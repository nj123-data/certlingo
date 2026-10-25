"""In-memory background job tracker."""

import uuid
from datetime import datetime
from typing import Any

PENDING = "pending"
RUNNING = "running"
DONE    = "done"
FAILED  = "failed"

_jobs: dict[str, dict[str, Any]] = {}


def create_job(job_type: str, category: str = "") -> str:
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {
        "id":              job_id,
        "type":            job_type,
        "category":        category,
        "status":          PENDING,
        "progress":        0,
        "message":         "Queued",
        "progress_detail": [],
        "result":          None,
        "error":           None,
        "created_at":      datetime.utcnow().isoformat(),
        "updated_at":      datetime.utcnow().isoformat(),
    }
    return job_id


def get_job(job_id: str) -> dict[str, Any] | None:
    return _jobs.get(job_id)


def update_job(
    job_id:          str,
    status:          str | None  = None,
    progress:        int | None  = None,
    message:         str | None  = None,
    progress_detail: list | None = None,
    result:          Any         = None,
    error:           str | None  = None,
) -> None:
    job = _jobs.get(job_id)
    if not job:
        return
    if status          is not None: job["status"]          = status
    if progress        is not None: job["progress"]        = progress
    if message         is not None: job["message"]         = message
    if progress_detail is not None: job["progress_detail"] = progress_detail
    if result          is not None: job["result"]          = result
    if error           is not None: job["error"]           = error
    job["updated_at"] = datetime.utcnow().isoformat()