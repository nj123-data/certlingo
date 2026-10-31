import argparse
import csv
import json
import re
import time
from pathlib import Path

import cv2
import pandas as pd
import pytesseract
from PIL import Image
from dotenv import load_dotenv
from google import genai
from google.genai import types

from config import PHOTOS_DIR, OUTPUT_DIR, TESSERACT_CMD, OCR_LANGUAGE

load_dotenv()

# ---------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------

IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".bmp",
    ".tif", ".tiff", ".webp",
}

MODEL_NAME = "gemini-2.5-flash"
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 2

QUESTION_FIELDS = [
    "question_number",
    "question_text",
    "option_A",
    "option_B",
    "option_C",
    "option_D",
    "option_E",
    "category",
]
ANSWER_FIELDS = [
    "correct_option",
    "explanation_option_A",
    "explanation_option_B",
    "explanation_option_C",
    "explanation_option_D",
    "explanation_option_E",
]

OUTPUT_COLUMNS = [
    "source_image",
    "raw_ocr",
    "category",
    "question_number",
    "question_text",
    "option_A",
    "option_B",
    "option_C",
    "option_D",
    "option_E",
    *ANSWER_FIELDS,
]


# ---------------------------------------------------------
# TESSERACT OCR
# ---------------------------------------------------------

def configure_tesseract():
    if TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD


def prepare_image(image_path):
    """Resize and preprocess an image to improve OCR accuracy."""

    # cv2.imread fails on Windows with non-ASCII paths.
    # Read via numpy as a workaround.
    import numpy as np

    image_path = Path(image_path)
    file_bytes = np.frombuffer(image_path.read_bytes(), dtype=np.uint8)
    image = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError(f"Cannot read image: {image_path}")

    height, width = image.shape[:2]

    if width < 1600:
        scale = 1600 / width
        image = cv2.resize(
            image,
            None,
            fx=scale,
            fy=scale,
            interpolation=cv2.INTER_CUBIC,
        )

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    _, processed = cv2.threshold(
        gray,
        0,
        255,
        cv2.THRESH_BINARY + cv2.THRESH_OTSU,
    )

    return Image.fromarray(processed)


def extract_ocr_lines(image_path):
    """Extract OCR text while preserving reading order."""

    configure_tesseract()
    image = prepare_image(image_path)

    data = pytesseract.image_to_data(
        image,
        lang=OCR_LANGUAGE,
        config="--psm 6",
        output_type=pytesseract.Output.DATAFRAME,
    )

    if data.empty:
        return []

    data = data.dropna(subset=["text"]).copy()
    data["text"] = data["text"].astype(str).str.strip()
    data["conf"] = pd.to_numeric(data["conf"], errors="coerce")

    data = data[
        (data["text"] != "")
        & (data["conf"] >= 0)
    ]

    if data.empty:
        return []

    lines = []

    for _, group in data.groupby(
        ["block_num", "par_num", "line_num"],
        sort=False,
    ):
        group = group.sort_values("left")
        text = " ".join(group["text"].tolist()).strip()

        if text:
            lines.append({
                "top":        int(group["top"].min()),
                "left":       int(group["left"].min()),
                "text":       text,
                "confidence": float(group["conf"].mean()),
            })

    return sorted(
        lines,
        key=lambda line: (line["top"], line["left"]),
    )


# ---------------------------------------------------------
# HELPERS
# ---------------------------------------------------------

def empty_record():
    return {
        "source_image":         "",
        "raw_ocr":              "",
        "category":             "",
        "question_number":      "",
        "question_text":        "",
        "option_A":             "",
        "option_B":             "",
        "option_C":             "",
        "option_D":             "",
        "option_E":             "",
        "correct_option":       "",
        "explanation_option_A": "",
        "explanation_option_B": "",
        "explanation_option_C": "",
        "explanation_option_D": "",
        "explanation_option_E": "",
    }


def normalize_text(text):
    text = str(text or "").casefold()
    return re.sub(r"\s+", " ", text).strip()


def get_filename_question_number(source_image):
    stem = Path(source_image).stem

    patterns = [
        r"^question[\s_-]*(\d+)",
        r"^q[\s_-]*(\d+)",
        r"^(\d+)(?:\D|$)",
    ]

    for pattern in patterns:
        match = re.search(pattern, stem, re.IGNORECASE)
        if match:
            return match.group(1)

    return ""


def clean_string(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def extract_json_response(response):
    if not response.text:
        raise ValueError("Gemini returned an empty response.")
    result = json.loads(response.text)
    if not isinstance(result, dict):
        raise ValueError("Expected a JSON object.")
    return result


def generate_with_retry(client, prompt, schema):
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = client.models.generate_content(
                model=MODEL_NAME,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_json_schema=schema,
                ),
            )
            return extract_json_response(response)

        except Exception as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                delay = RETRY_DELAY_SECONDS * attempt
                print(
                    f"    Attempt {attempt} failed: {exc}. "
                    f"Retrying in {delay}s..."
                )
                time.sleep(delay)

    raise RuntimeError(
        f"Gemini failed after {MAX_RETRIES} attempts: {last_error}"
    )


# ---------------------------------------------------------
# GEMINI: OCR TEXT TO STRUCTURED QUESTION
# ---------------------------------------------------------

PARSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "question_number": {"type": "STRING"},
        "question_text":   {"type": "STRING"},
        "option_A":        {"type": "STRING"},
        "option_B":        {"type": "STRING"},
        "option_C":        {"type": "STRING"},
        "option_D":        {"type": "STRING"},
        "option_E":        {"type": "STRING"},
    },
    "required": QUESTION_FIELDS,
}

def parse_raw_ocr_to_fields(raw_ocr_text, source_image, client):
    record = empty_record()
    record["source_image"] = source_image
    record["raw_ocr"] = raw_ocr_text or ""

    if not raw_ocr_text or not raw_ocr_text.strip():
        print(f"    Empty OCR: {source_image}")
        return record

    filename_number = get_filename_question_number(source_image)

    prompt = f"""
You are a precise OCR extraction assistant for multiple-choice
technical certification questions.

Extract ONE complete question from the supplied OCR text.

SOURCE FILENAME:
{source_image}

FILENAME QUESTION NUMBER:
{filename_number or "Not available"}

OCR TEXT:
<<<
{raw_ocr_text}
>>>

EXTRACTION RULES:

1. Extract the question number from the OCR header when available.
2. If the OCR does not contain a question number, use the filename
   question number when available.
3. Extract the FULL question text, including introductory
   paragraphs, technical context, constraints, and the final
   sentence asking what is required.
4. Extract options A, B, C and D into separate fields.
5. Remove only the option label and separator, such as "A.",
   "A)", or "A:".
6. Join lines that are continuations of the same sentence.
7. Do not merge option text into the question.
8. Preserve technical terms, product names, acronyms and meaning.
9. Fix obvious OCR spacing errors only when the intended text
   is unambiguous.
10. Do not answer the question or add explanations.
11. Never invent missing question or option text.
12. If a field cannot be identified confidently, return an
    empty string for that field.
13. Return question_number as a string.
14. Return only the JSON object matching the requested schema.
"""

    try:
        result = generate_with_retry(client, prompt, PARSE_SCHEMA)

        for field in QUESTION_FIELDS:
            record[field] = clean_string(result.get(field, ""))

        if not record["question_number"] and filename_number:
            record["question_number"] = filename_number

        return record

    except Exception as exc:
        print(f"    Parsing failed for {source_image}: {exc}")
        return record


def validate_question(record):
    # option_E is optional — not all questions have 5 options
    required_fields = [
        "question_text",
        "option_A",
        "option_B",
        "option_C",
        "option_D",
    ]

    missing = [
        field for field in required_fields
        if not record.get(field, "").strip()
    ]

    return missing


# ---------------------------------------------------------
# GEMINI: ANSWER AND EXPLANATIONS
# ---------------------------------------------------------
ANSWER_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "correct_option": {
            "type": "STRING",
        },
        "explanation_option_A": {"type": "STRING"},
        "explanation_option_B": {"type": "STRING"},
        "explanation_option_C": {"type": "STRING"},
        "explanation_option_D": {"type": "STRING"},
        "explanation_option_E": {"type": "STRING"},
    },
    "required": ANSWER_FIELDS,
}


def enrich_question(record, client):
    prompt = f"""
You are an expert technical certification exam tutor.

Analyze the following multiple-choice question and determine
the most appropriate answer based on the stated requirements.

QUESTION:
{record["question_text"]}

OPTION A:
{record["option_A"]}

OPTION B:
{record["option_B"]}

OPTION C:
{record["option_C"]}

OPTION D:
{record["option_D"]}

TASKS:

1. Identify the single best answer.
2. Explain why option A is correct or incorrect.
3. Explain why option B is correct or incorrect.
4. Explain why option C is correct or incorrect.
5. Explain why option D is correct or incorrect.

REQUIREMENTS:

- Base your reasoning on the exact question and its constraints.
- Explain the relevant technical concepts.
- Explain why incorrect options fail to meet the requirements.
- Do not change or rewrite the original question.
- Do not claim certainty if the question is ambiguous.
- If the answer cannot be determined reliably, use an empty
  string for correct_option and explain the ambiguity in each
  relevant explanation field.
- Keep explanations clear, accurate and educational.
- Return only the requested JSON object.
"""

    result = generate_with_retry(client, prompt, ANSWER_SCHEMA)

    correct_option = clean_string(
        result.get("correct_option", "")
    ).upper()

    if correct_option not in {"A", "B", "C", "D"}:
        correct_option = ""

    record["correct_option"] = correct_option

    for field in ANSWER_FIELDS[1:]:
        record[field] = clean_string(result.get(field, ""))

    return record


def enrich_with_gemini(records, client, progress_callback=None, ocr_total=0):
    enriched_rows = []

    for index, row in enumerate(records, 1):
        question_number = row.get("question_number", "")
        label = question_number or row.get("source_image", "Unknown")

        missing = validate_question(row)

        if missing:
            print(
                f"[{index}/{len(records)}] Skipping {label}: "
                f"missing {', '.join(missing)}"
            )
            enriched_rows.append(row)
        else:
            print(
                f"[{index}/{len(records)}] "
                f"Generating answer for Question {label}..."
            )
            try:
                row = enrich_question(row, client)
            except Exception as exc:
                print(f"    Answer enrichment failed for {label}: {exc}")
            enriched_rows.append(row)

        # Progress: Gemini enrichment is the second half
        if progress_callback:
            progress_callback(
                ocr_total + index,
                ocr_total + len(records),
                f"Gemini [{index}/{len(records)}]: {label}",
            )

    return enriched_rows


# ---------------------------------------------------------
# IMAGE PROCESSING PIPELINE
# ---------------------------------------------------------

def process_images(input_dir, progress_callback=None, category=""):
    """
    Run the full OCR + Gemini pipeline on a folder of images.
    Optionally accepts a progress_callback(current, total, message).
    """
    input_dir = Path(input_dir).expanduser().resolve()

    if not input_dir.exists():
        raise FileNotFoundError(
            f"Input folder does not exist: {input_dir}"
        )

    if not input_dir.is_dir():
        raise NotADirectoryError(
            f"Input path is not a folder: {input_dir}"
        )

    images = sorted(
        path
        for path in input_dir.rglob("*")
        if path.is_file()
        and path.suffix.lower() in IMAGE_EXTENSIONS
    )

    if not images:
        print(f"No images found in {input_dir}")
        return None

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    output_csv = OUTPUT_DIR / f"parsed_questions_{input_dir.name}.csv"

    client = genai.Client()

    # ── Phase 1: OCR ──────────────────────────────────────
    raw_records = []
    ocr_total = len(images)

    for index, image_path in enumerate(images, 1):
        relative_path = str(image_path.relative_to(input_dir))

        print(f"[{index}/{ocr_total}] Extracting OCR: {relative_path}")

        if progress_callback:
            progress_callback(
                index,
                ocr_total * 2,
                f"OCR [{index}/{ocr_total}]: {relative_path}",
            )

        try:
            lines = extract_ocr_lines(image_path)
            raw_text = "\n".join(line["text"] for line in lines)
        except Exception as exc:
            print(f"    OCR failed: {exc}")
            raw_text = ""

        raw_records.append({
            "source_image": relative_path,
            "raw_ocr":      raw_text,
        })

    # ── Phase 2: Deduplicate ───────────────────────────────
    seen_ocr = set()
    unique_records = []
    duplicate_count = 0

    for record in raw_records:
        normalized = normalize_text(record["raw_ocr"])

        if normalized and normalized in seen_ocr:
            duplicate_count += 1
            print(f"    Duplicate OCR skipped: {record['source_image']}")
            continue

        if normalized:
            seen_ocr.add(normalized)

        unique_records.append(record)

    print(
        f"\nOCR images:        {len(raw_records)}"
        f"\nDuplicates skipped: {duplicate_count}"
        f"\nRecords to parse:  {len(unique_records)}\n"
    )

    # ── Phase 3: Gemini parse ──────────────────────────────
    parsed_records = []

    for index, raw_record in enumerate(unique_records, 1):
        print(f"[{index}/{len(unique_records)}] Parsing: {raw_record['source_image']}")

        parsed = parse_raw_ocr_to_fields(
            raw_ocr_text=raw_record["raw_ocr"],
            source_image=raw_record["source_image"],
            client=client,
        )

        parsed["category"] = category

        parsed_records.append(parsed)

    valid_records = [r for r in parsed_records if not validate_question(r)]
    invalid_records = [r for r in parsed_records if validate_question(r)]

    print(
        f"\nSuccessfully parsed:  {len(valid_records)}"
        f"\nIncomplete questions: {len(invalid_records)}\n"
    )

    # ── Phase 4: Gemini enrich ─────────────────────────────
    final_records = enrich_with_gemini(
        parsed_records,
        client,
        progress_callback=progress_callback,
        ocr_total=ocr_total,
    )

    # ── Phase 5: Export CSV ────────────────────────────────
    df = pd.DataFrame(final_records, columns=OUTPUT_COLUMNS)

    df.to_csv(
        output_csv,
        index=False,
        quoting=csv.QUOTE_MINIMAL,
        encoding="utf-8-sig",
    )

    print(f"\nCSV saved: {output_csv}")
    print(f"Total:      {len(df)}")
    print(f"Complete:   {len(valid_records)}")
    print(f"Incomplete: {len(invalid_records)}")

    return output_csv


# ---------------------------------------------------------
# COMMAND-LINE ENTRY POINT
# ---------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description=(
            "Extract certification questions from screenshots "
            "using Tesseract OCR and Gemini AI."
        )
    )

    parser.add_argument(
        "--input",
        default=str(PHOTOS_DIR),
        help="Folder containing question screenshots.",
    )

    args = parser.parse_args()
    process_images(args.input)


if __name__ == "__main__":
    main()