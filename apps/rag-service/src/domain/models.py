from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class RetrievedChunk(BaseModel):
    id: str
    document_id: str
    document_name: str
    content: str
    parent_chunk_id: str | None = None
    parent_content: str | None = None
    section: str | None = None
    page_number: int | None = None
    dense_score: float = 0.0
    sparse_score: float = 0.0
    rrf_score: float = 0.0
    rank: int = 0


class Citation(BaseModel):
    documentId: str
    documentName: str
    page: int | None = None
    text: str
    score: float
    url: str | None = None


class QueryRequest(BaseModel):
    # Generous cap: the model-aware token budget (composer + backend validation)
    # is the real gate, not a character ceiling. Nothing is ever truncated.
    message: str = Field(min_length=1, max_length=1_000_000)
    conversation_id: str | None = None
    user_id: str | None = None
    history: list[dict[str, str]] = Field(default_factory=list)
    provider: str | None = Field(default=None, max_length=32)
    model: str | None = Field(default=None, max_length=128)
    # Retrieval depth: "fast" | "balanced" | "deep" (default "balanced").
    mode: str | None = Field(default=None, max_length=16)
    # Optional document scope: when non-empty, retrieval is restricted to
    # these document ids (metadata filtering happens in SQL before scoring).
    document_ids: list[str] = Field(default_factory=list)
    # Resolved by the api-gateway (user key > server default). Only sent over
    # the internal service-to-service network and never logged.
    api_key: str | None = Field(default=None, max_length=512)


class MemoryHit(BaseModel):
    """A past message recalled from semantic conversation memory."""

    id: str
    conversation_id: str | None = None
    role: str
    content: str
    score: float = 0.0
    created_at: datetime | None = None
    access_count: int = 0
    last_accessed_at: datetime | None = None


class MemoryFact(BaseModel):
    """A durable fact about the user extracted from past conversations."""

    id: str
    type: str = "fact"
    content: str
    importance: float = 0.5
    score: float = 0.0
    created_at: datetime | None = None
    access_count: int = 0
    last_accessed_at: datetime | None = None


class FeedbackRequest(BaseModel):
    message_id: str
    helpful: bool | None = None
    comment: str | None = None


class RetrieveRequest(BaseModel):
    """Retrieval-only playground request: no conversation, no generation."""

    message: str = Field(min_length=1, max_length=4096)
    user_id: str | None = None
    mode: str | None = Field(default=None, max_length=16)
    provider: str | None = Field(default=None, max_length=32)
    model: str | None = Field(default=None, max_length=128)
    document_ids: list[str] = Field(default_factory=list)
    api_key: str | None = Field(default=None, max_length=512)
