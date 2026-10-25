"""CertLingo FastAPI backend."""

import csv
import io
import shutil
import threading
import traceback

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import PHOTOS_DIR, OUTPUT_DIR
from jobs import create_job, get_job, update_job, RUNNING, DONE, FAILED

# ── App ────────────────────────────────────────────────────
app = FastAPI(title="CertLingo API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "null",
        "https://*.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Static files ───────────────────────────────────────────
app.mount(
    "/screenshots",
    StaticFiles(directory=str(PHOTOS_DIR)),
    name="screenshots",
)


# ── DB helper ──────────────────────────────────────────────
def get_db_connection():
    """
    Returns (connection, dialect).
    - dialect = "postgres"   when DATABASE_URL is set (Supabase / Render)
    - dialect = "sqlserver"  when running locally with SQL Server
    """
    from config import DATABASE_URL, USE_POSTGRES

    if USE_POSTGRES:
        import psycopg2
        conn = psycopg2.connect(DATABASE_URL)
        return conn, "postgres"
    else:
        import pyodbc
        from config import (
            SQL_SERVER, SQL_DATABASE, SQL_DRIVER,
            SQL_TRUSTED_CONNECTION, SQL_ENCRYPT,
            SQL_TRUST_SERVER_CERTIFICATE,
        )
        conn_str = (
            f"DRIVER={{{SQL_DRIVER}}};"
            f"SERVER={SQL_SERVER};"
            f"DATABASE={SQL_DATABASE};"
            f"Trusted_Connection={SQL_TRUSTED_CONNECTION};"
            f"Encrypt={SQL_ENCRYPT};"
            f"TrustServerCertificate={SQL_TRUST_SERVER_CERTIFICATE};"
        )
        conn = pyodbc.connect(conn_str, timeout=10)
        return conn, "sqlserver"


def ensure_table(cursor, dialect: str):
    """Create the questions table if it does not exist."""
    if dialect == "postgres":
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS questions (
                id                   SERIAL PRIMARY KEY,
                source_image         TEXT,
                raw_ocr              TEXT,
                question_number      TEXT,
                question_text        TEXT,
                option_A             TEXT,
                option_B             TEXT,
                option_C             TEXT,
                option_D             TEXT,
                option_E             TEXT,
                correct_option       TEXT,
                explanation_option_A TEXT,
                explanation_option_B TEXT,
                explanation_option_C TEXT,
                explanation_option_D TEXT,
                explanation_option_E TEXT,
                category             TEXT,
                created_at           TIMESTAMPTZ DEFAULT NOW()
            )
        """)
    else:
        cursor.execute("""
            IF NOT EXISTS (
                SELECT * FROM sys.objects
                WHERE object_id = OBJECT_ID(N'[dbo].[questions]')
                  AND type = N'U'
            )
            BEGIN
                CREATE TABLE questions (
                    id                   INT IDENTITY(1,1) PRIMARY KEY,
                    source_image         NVARCHAR(500),
                    raw_ocr              NVARCHAR(MAX),
                    question_number      NVARCHAR(50),
                    question_text        NVARCHAR(MAX),
                    option_A             NVARCHAR(MAX),
                    option_B             NVARCHAR(MAX),
                    option_C             NVARCHAR(MAX),
                    option_D             NVARCHAR(MAX),
                    option_E             NVARCHAR(MAX),
                    correct_option       NVARCHAR(50),
                    explanation_option_A NVARCHAR(MAX),
                    explanation_option_B NVARCHAR(MAX),
                    explanation_option_C NVARCHAR(MAX),
                    explanation_option_D NVARCHAR(MAX),
                    explanation_option_E NVARCHAR(MAX),
                    category             NVARCHAR(255),
                    created_at           DATETIME2 DEFAULT GETUTCDATE()
                )
            END
        """)


def placeholder(dialect: str) -> str:
    """Return the correct SQL placeholder for the dialect."""
    return "%s" if dialect == "postgres" else "?"


# ── Health ─────────────────────────────────────────────────
@app.get("/api/health")
def health():
    from config import USE_POSTGRES
    return {
        "status":          "ok",
        "db_mode":         "postgres" if USE_POSTGRES else "sqlserver",
        "screenshots_dir": str(PHOTOS_DIR),
        "output_dir":      str(OUTPUT_DIR),
    }


# ── Clear screenshots ──────────────────────────────────────
@app.post("/api/screenshots/clear")
def clear_screenshots():
    if PHOTOS_DIR.exists():
        shutil.rmtree(PHOTOS_DIR)
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    print("[clear] Screenshots folder cleared")
    return {"cleared": True}


# ── Upload screenshots ─────────────────────────────────────
@app.post("/api/screenshots/upload")
async def upload_screenshots(files: list[UploadFile] = File(...)):
    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

    saved  = []
    errors = []

    print(f"[upload] Received {len(files)} file(s)")

    for upload in files:
        try:
            content = await upload.read()
            print(f"[upload] {upload.filename} — {len(content)} bytes")

            if len(content) == 0:
                errors.append({"filename": upload.filename, "error": "Empty file"})
                continue

            dest = PHOTOS_DIR / upload.filename
            dest.write_bytes(content)
            saved.append(upload.filename)

        except Exception as exc:
            print(f"[upload] ERROR {upload.filename}: {exc}")
            errors.append({"filename": upload.filename, "error": str(exc)})

    print(f"[upload] Done — saved {len(saved)}, errors {len(errors)}")
    return {"saved": saved, "errors": errors, "total": len(saved)}


# ── List screenshots ───────────────────────────────────────
@app.get("/api/screenshots")
def list_screenshots():
    if not PHOTOS_DIR.exists():
        return {"screenshots": [], "total": 0}
    files = sorted(
        p.name for p in PHOTOS_DIR.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    return {"screenshots": files, "total": len(files)}


# ── Delete a screenshot ────────────────────────────────────
@app.delete("/api/screenshots/{filename}")
def delete_screenshot(filename: str):
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    target = PHOTOS_DIR / filename
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    target.unlink()
    return {"deleted": filename}


# ── Start full OCR + Gemini pipeline ──────────────────────
@app.post("/api/process")
def start_process(category: str = ""):
    screenshots = (
        list(PHOTOS_DIR.glob("*.jpg")) +
        list(PHOTOS_DIR.glob("*.jpeg")) +
        list(PHOTOS_DIR.glob("*.png"))
    )
    if not screenshots:
        raise HTTPException(
            status_code=400,
            detail="No screenshots found. Complete Step 1 first."
        )

    job_id = create_job("process", category=category)
    threading.Thread(
        target=_run_pipeline,
        args=(job_id, category),
        daemon=True,
    ).start()
    return {"job_id": job_id}


def _run_pipeline(job_id: str, category: str = "") -> None:
    try:
        update_job(job_id, status=RUNNING, message="Starting OCR pipeline...")

        from image_processing import process_images

        def progress_callback(current: int, total: int, message: str) -> None:
            pct = round((current / total) * 100) if total else 0
            update_job(job_id, progress=pct, message=message)

        output_csv = process_images(
            input_dir=str(PHOTOS_DIR),
            progress_callback=progress_callback,
            category=category,
        )

        update_job(
            job_id,
            status=DONE,
            progress=100,
            message="Processing complete",
            result={"csv_path": str(output_csv) if output_csv else None},
        )
        print(f"[process] Job {job_id} complete → {output_csv}")

    except Exception as exc:
        tb = traceback.format_exc()
        print(f"[process] Job {job_id} FAILED:\n{tb}")
        update_job(job_id, status=FAILED, message=str(exc), error=tb)


# ── OCR only (no Gemini) ───────────────────────────────────
@app.post("/api/ocr")
def start_ocr():
    screenshots = (
        list(PHOTOS_DIR.glob("*.jpg")) +
        list(PHOTOS_DIR.glob("*.jpeg")) +
        list(PHOTOS_DIR.glob("*.png"))
    )
    if not screenshots:
        raise HTTPException(
            status_code=400,
            detail="No screenshots found. Upload screenshots first."
        )

    job_id = create_job("ocr")
    threading.Thread(target=_run_ocr_only, args=(job_id,), daemon=True).start()
    return {"job_id": job_id}


def _run_ocr_only(job_id: str) -> None:
    try:
        update_job(job_id, status=RUNNING, message="Starting OCR...")

        from image_processing import extract_ocr_lines, IMAGE_EXTENSIONS

        images = sorted(
            p for p in PHOTOS_DIR.rglob("*")
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
        )

        total   = len(images)
        results = []

        for index, image_path in enumerate(images, 1):
            relative_path = image_path.name
            update_job(
                job_id,
                progress=round((index / total) * 100),
                message=f"OCR [{index}/{total}]: {relative_path}",
            )
            try:
                lines    = extract_ocr_lines(image_path)
                raw_text = "\n".join(line["text"] for line in lines)
            except Exception as exc:
                print(f"[ocr] Failed {relative_path}: {exc}")
                raw_text = ""

            results.append({
                "filename": relative_path,
                "raw_ocr":  raw_text,
                "empty":    not raw_text.strip(),
            })

        update_job(
            job_id,
            status=DONE,
            progress=100,
            message=f"OCR complete — {total} images processed",
            result={"ocr_results": results},
        )

    except Exception as exc:
        tb = traceback.format_exc()
        print(f"[ocr] Job {job_id} FAILED:\n{tb}")
        update_job(job_id, status=FAILED, message=str(exc), error=tb)


# ── Job status ─────────────────────────────────────────────
@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


# ── Questions preview (from CSV) ───────────────────────────
@app.get("/api/questions/preview")
def questions_preview():
    csvs = sorted(OUTPUT_DIR.glob("*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not csvs:
        return {"questions": [], "total": 0, "csv_path": None}

    latest    = csvs[0]
    questions = []
    with latest.open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            questions.append(dict(row))

    return {"questions": questions, "total": len(questions), "csv_path": str(latest)}


# ── Upload CSV ─────────────────────────────────────────────
@app.post("/api/questions/upload-csv")
async def upload_csv(file: UploadFile = File(...), category: str = ""):
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a .csv")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    content = await file.read()
    text    = content.decode("utf-8-sig")

    if category:
        reader     = csv.DictReader(io.StringIO(text))
        rows       = list(reader)
        fieldnames = list(reader.fieldnames or [])

        if "category" not in fieldnames:
            fieldnames = ["category"] + fieldnames

        for row in rows:
            row["category"] = category

        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(rows)
        final_content = out.getvalue().encode("utf-8-sig")
    else:
        final_content = content

    dest = OUTPUT_DIR / file.filename
    dest.write_bytes(final_content)
    print(f"[csv] Uploaded CSV saved → {dest} (category={category or 'none'})")
    return {"csv_path": str(dest)}


# ── Load questions into DB ─────────────────────────────────
@app.post("/api/load")
def load_questions(category: str = None):
    """
    Read the latest CSV and insert rows into Postgres (Supabase)
    or SQL Server depending on the environment.
    """
    # 1. Find latest CSV
    csvs = sorted(OUTPUT_DIR.glob("*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not csvs:
        raise HTTPException(status_code=400, detail="No CSV found. Complete Step 2 first.")
    latest_csv = csvs[0]

    # 2. Read rows
    rows = []
    with latest_csv.open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            rows.append(dict(row))
    if not rows:
        raise HTTPException(status_code=400, detail="CSV is empty.")

    # 3. Connect
    try:
        conn, dialect = get_db_connection()
        cursor        = conn.cursor()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Cannot connect to database: {exc}")

    # 4. Ensure table exists
    ensure_table(cursor, dialect)
    conn.commit()

    # 5. Insert rows
    ph = placeholder(dialect)
    INSERT_SQL = f"""
        INSERT INTO questions (
            source_image, raw_ocr, question_number, question_text,
            option_A, option_B, option_C, option_D, option_E,
            correct_option,
            explanation_option_A, explanation_option_B,
            explanation_option_C, explanation_option_D, explanation_option_E,
            category
        ) VALUES ({ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph})
    """

    inserted = skipped = failed = 0
    details  = []

    for i, row in enumerate(rows, 1):
        q_text = (row.get("question_text") or "").strip()

        if not q_text:
            failed += 1
            details.append({"row": i, "status": "failed", "reason": "Missing question_text"})
            continue

        cursor.execute(
            f"SELECT COUNT(*) FROM questions WHERE question_text = {ph}",
            (q_text,),
        )
        if cursor.fetchone()[0] > 0:
            skipped += 1
            details.append({"row": i, "status": "skipped", "reason": "Duplicate"})
            continue

        try:
            cursor.execute(INSERT_SQL, (
                row.get("source_image")         or None,
                row.get("raw_ocr")              or None,
                row.get("question_number")      or None,
                q_text,
                row.get("option_A")             or None,
                row.get("option_B")             or None,
                row.get("option_C")             or None,
                row.get("option_D")             or None,
                row.get("option_E")             or None,
                row.get("correct_option")       or None,
                row.get("explanation_option_A") or None,
                row.get("explanation_option_B") or None,
                row.get("explanation_option_C") or None,
                row.get("explanation_option_D") or None,
                row.get("explanation_option_E") or None,
                category or row.get("category") or None,
            ))
            inserted += 1
            details.append({"row": i, "status": "inserted"})
        except Exception as exc:
            failed += 1
            details.append({"row": i, "status": "failed", "reason": str(exc)})

    conn.commit()
    cursor.close()
    conn.close()

    return {
        "csv":      latest_csv.name,
        "total":    len(rows),
        "inserted": inserted,
        "skipped":  skipped,
        "failed":   failed,
        "details":  details,
    }


# ── DB status ──────────────────────────────────────────────
@app.get("/api/db/status")
def db_status():
    try:
        conn, dialect = get_db_connection()
        cursor        = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM questions")
        count = cursor.fetchone()[0]
        conn.close()
        return {"connected": True, "dialect": dialect, "question_count": count}
    except Exception as exc:
        return {"connected": False, "error": str(exc)}


# ── Serve questions to the question bank ───────────────────
@app.get("/api/questions")
def get_questions(category: str = None, limit: int = 200, offset: int = 0):
    try:
        conn, dialect = get_db_connection()
        cursor        = conn.cursor()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"DB unavailable: {exc}")

    ph = placeholder(dialect)

    if dialect == "postgres":
        if category:
            cursor.execute(
                f"SELECT * FROM questions WHERE category = {ph} ORDER BY id LIMIT {ph} OFFSET {ph}",
                (category, limit, offset),
            )
        else:
            cursor.execute(
                f"SELECT * FROM questions ORDER BY id LIMIT {ph} OFFSET {ph}",
                (limit, offset),
            )
    else:
        if category:
            cursor.execute(
                f"SELECT * FROM questions WHERE category = {ph} ORDER BY id OFFSET {ph} ROWS FETCH NEXT {ph} ROWS ONLY",
                (category, offset, limit),
            )
        else:
            cursor.execute(
                f"SELECT * FROM questions ORDER BY id OFFSET {ph} ROWS FETCH NEXT {ph} ROWS ONLY",
                (offset, limit),
            )

    columns = [col[0] for col in cursor.description]
    rows    = [dict(zip(columns, row)) for row in cursor.fetchall()]

    for row in rows:
        if row.get("created_at"):
            row["created_at"] = str(row["created_at"])

    if category:
        cursor.execute(
            f"SELECT COUNT(*) FROM questions WHERE category = {ph}", (category,)
        )
    else:
        cursor.execute("SELECT COUNT(*) FROM questions")
    total = cursor.fetchone()[0]

    conn.close()
    return {"questions": rows, "total": total}