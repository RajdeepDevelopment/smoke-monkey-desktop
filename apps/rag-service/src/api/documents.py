"""Desktop document API (local mode only).

The cloud edition uploads documents through the api-gateway (NestJS → Postgres
+ MinIO + NATS). The desktop edition needs no gateway, so rag-service owns the
upload path: PDFs go to the local filesystem store, the ingest job is queued
into the shared ``jobs.db`` for the document-worker, and document status is
read back from the shared ``memory.db`` documents table.

In cloud mode these endpoints are intentionally unavailable (HTTP 501) so the
gateway remains the single upload path.
"""
from __future__ import annotations

import logging
import tempfile
import uuid
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from src.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/documents", tags=["documents"])

MAX_UPLOAD_MB = 10
ALLOWED_TYPES = {"application/pdf"}


def _require_local() -> None:
    if settings.storage_mode != "local":
        raise HTTPException(
            status_code=501,
            detail="document upload is served by the API gateway in cloud mode",
        )


def _stores(request: Request) -> tuple[Any, Any, Any]:
    """(vector, documents file store, job queue) from the local bundle."""
    vector = request.app.state.vector
    documents = request.app.state.documents
    jobs = request.app.state.jobs
    if vector is None or documents is None or jobs is None:
        raise HTTPException(status_code=503, detail="local storage not initialized")
    return vector, documents, jobs


def _dto(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "userId": row.get("user_id"),
        "filename": row.get("filename"),
        "status": row.get("status"),
        "chunkCount": row.get("chunk_count"),
        "error": row.get("error"),
        "createdAt": row.get("updated_at"),
        "updatedAt": row.get("updated_at"),
    }


@router.post("/upload")
async def upload_document(
    request: Request,
    file: Annotated[UploadFile, File()],
    user_id: Annotated[str, Form()] = settings.local_user_id,
) -> dict[str, Any]:
    _require_local()
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="only PDF files are supported")
    payload = await file.read()
    if not payload or len(payload) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"file exceeds {MAX_UPLOAD_MB}MB limit")

    vector, documents, jobs = _stores(request)
    document_id = str(uuid.uuid4())
    s3_key = f"users/{user_id}/{document_id}.pdf"

    try:
        with tempfile.TemporaryDirectory() as tmp:
            local_path = Path(tmp) / file.filename
            local_path.write_bytes(payload)
            await documents.upload(s3_key, local_path, content_type="application/pdf")
        await vector.insert_document(document_id, user_id, file.filename)
        await jobs.submit(
            job_id=str(uuid.uuid4()),
            document_id=document_id,
            user_id=user_id,
            filename=file.filename,
            s3_key=s3_key,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("upload pipeline failed for %s: %s", document_id, exc)
        await vector.set_document_status(document_id, "failed", error=str(exc)[:500], user_id=user_id)
        raise HTTPException(
            status_code=400, detail="failed to queue document for ingestion"
        ) from None

    row = await vector.get_document(document_id, user_id)
    return _dto(row or {"id": document_id, "user_id": user_id, "filename": file.filename})


@router.get("")
async def list_documents(request: Request, user_id: str = settings.local_user_id) -> list[dict[str, Any]]:
    _require_local()
    vector, _, _ = _stores(request)
    return [_dto(row) for row in await vector.list_documents(user_id)]


@router.get("/{document_id}")
async def get_document(request: Request, document_id: str, user_id: str = settings.local_user_id) -> dict[str, Any]:
    _require_local()
    vector, _, _ = _stores(request)
    row = await vector.get_document(document_id, user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="document not found")
    return _dto(row)


@router.delete("/{document_id}")
async def remove_document(request: Request, document_id: str, user_id: str = settings.local_user_id) -> dict[str, str]:
    _require_local()
    vector, documents, _ = _stores(request)
    row = await vector.get_document(document_id, user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="document not found")
    await documents.delete(f"users/{user_id}/{document_id}.pdf")
    await vector.delete_document(document_id, user_id)
    return {"status": "ok"}
