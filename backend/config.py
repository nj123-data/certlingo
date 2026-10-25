"""Shared configuration for the CertLingo backend."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# ── Paths ──────────────────────────────────────────────────
ROOT_DIR   = Path(__file__).resolve().parent
DATA_DIR   = ROOT_DIR / "data"
PHOTOS_DIR = DATA_DIR / "screenshots"
OUTPUT_DIR = DATA_DIR / "output"

PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── SQL Server ─────────────────────────────────────────────
SQL_SERVER               = os.getenv("SQL_SERVER", r".\SQLEXPRESS01")
SQL_DATABASE             = os.getenv("SQL_DATABASE", "VideoOCR")
SQL_DRIVER               = os.getenv("SQL_DRIVER", "ODBC Driver 18 for SQL Server")
SQL_TRUSTED_CONNECTION   = "yes"
SQL_ENCRYPT              = "yes"
SQL_TRUST_SERVER_CERTIFICATE = "yes"

# ── Tesseract ──────────────────────────────────────────────
TESSERACT_CMD = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
OCR_LANGUAGE  = "eng"

# ── Gemini ─────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# The google-genai SDK reads GOOGLE_API_KEY from the environment.
# We set it here so the pipeline script works without modification.
if GEMINI_API_KEY and not os.getenv("GOOGLE_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = GEMINI_API_KEY

# ── Database ───────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL", "")  # Supabase Postgres URL
# If DATABASE_URL is set, use Postgres. Otherwise fall back to SQL Server.
USE_POSTGRES = bool(DATABASE_URL)