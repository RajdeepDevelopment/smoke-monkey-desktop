"""Gateway-compatible API surface for the desktop app (local mode only).

The in-app UI speaks the api-gateway contract: ``/api/auth/*``, ``/api/chat/
stream``, ``/api/conversations/*``, ``/api/documents/*``, ``/api/keys/*``,
``/api/models/*``, ``/api/playground/retrieve``, ``/api/analytics/metrics``,
``/api/settings/*``, ``/api/health``. On the desktop there is no gateway, so
this router serves that exact surface:

- auth is a single-user no-op (one default user, ``settings.local_user_id``);
- chat streams through the same ``QueryPipeline`` as ``/api/v1/query`` and
  persists each exchange into ``conversations.db``;
- conversations/settings are owned by local SQLite stores and cache flags;
- everything else is a thin alias to the existing ``/api/v1`` handlers so there
  is exactly one implementation per endpoint.

Cloud mode returns 501 — the gateway remains the single entry point there.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import uuid
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from src.api import documents as documents_api
from src.api import keys as keys_api
from src.api import routes as v1
from src.application.omniroute import omniroute_user_setting_key
from src.application.websearch import web_search_user_setting_key
from src.config import settings
from src.domain.models import QueryRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["desktop"])

_DEFAULT_USER = settings.local_user_id
_DEFAULT_EMAIL = "desktop@local"
_DEFAULT_NAME = "Desktop User"
_PROFILE_LOCK = asyncio.Lock()


def _profile_path() -> Path:
    return Path(settings.local_data_dir) / "profile.json"


def _load_profile() -> dict[str, Any]:
    """Persisted display name/email the user entered on first register/login."""
    try:
        path = _profile_path()
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:  # noqa: BLE001 - a broken profile must never break auth
        logger.debug("profile read failed", exc_info=True)
    return {}


def _save_profile(profile: dict[str, Any]) -> None:
    try:
        path = _profile_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001
        logger.debug("profile write failed", exc_info=True)


def _default_user() -> dict[str, Any]:
    profile = _load_profile()
    return {
        "id": _DEFAULT_USER,
        "email": profile.get("email") or _DEFAULT_EMAIL,
        "name": profile.get("name") or _DEFAULT_NAME,
        "createdAt": "1970-01-01T00:00:00+00:00",
    }


_TITLE_STOP = {
    "a",
    "an",
    "the",
    "of",
    "for",
    "with",
    "and",
    "or",
    "in",
    "on",
    "at",
    "to",
    "my",
    "your",
    "this",
    "that",
    "please",
    "can",
    "could",
    "will",
    "would",
    "is",
    "are",
    "was",
    "were",
}


def _derive_title(message: str) -> str:
    """Human-readable conversation title from the first user message.

    Deterministic (no LLM call): strips markdown/code/emojis/symbols, keeps the
    leading natural-language words and capitalizes the first letter, so a
    message like "can you check if the port works" becomes "Can you check if
    the port works" instead of a machine label such as "port-check".
    """
    text = re.sub(r"`[^`]*`|```.*?```", " ", message, flags=re.S)
    text = re.sub(r"[*_#>|\[\](){}]|!{2,}|\s+", " ", text)
    text = re.sub(r"https?://\S+|[\U0001F300-\U0001FAFF\u2600-\u27BF]", " ", text)
    text = re.sub(r"[^0-9A-Za-z',.?;:!%-]+", " ", text)
    words = [w for w in text.split() if w]
    words = [w for w in words if w.lower() not in _TITLE_STOP]
    if not words:
        words = [w for w in text.split() if w] or [message.strip()]
    title = " ".join(words)
    title = re.sub(r"[.!?;:]+$", "", title)
    title = title.strip().strip("'\"")
    if title:
        title = title[0].upper() + title[1:]
    return title[:60] or "New conversation"


def _require_local() -> None:
    if settings.storage_mode != "local":
        raise HTTPException(
            status_code=501,
            detail="the desktop API is served by the API gateway in cloud mode",
        )


def _stores(request: Request):
    state = request.app.state
    conversations = getattr(state, "conversations", None)
    redis = getattr(state, "redis", None)
    if conversations is None or not conversations.enabled:
        raise HTTPException(status_code=503, detail="local storage not initialized")
    return conversations, redis


async def _read_flag(redis, key: str) -> bool:
    if redis is None:
        return False
    try:
        return await redis.get(key) == "1"
    except Exception:  # noqa: BLE001 - a settings lookup must never break a request
        return False


# ── Auth (single-user no-op) ───────────────────────────────────────────────

class _Credentials(BaseModel):
    email: str = Field(default=_DEFAULT_EMAIL, max_length=255)
    name: str | None = Field(default=None, max_length=255)
    password: str = Field(default="desktop", max_length=255)


class _TitleBody(BaseModel):
    title: str | None = Field(default=None, max_length=300)


class _ToggleBody(BaseModel):
    enabled: bool = True


def _hash_password(password: str) -> tuple[str, str]:
    """Return ``(salt_hex, hash_hex)`` using scrypt (stdlib, no deps)."""
    salt = uuid.uuid4().hex.encode()
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )
    return salt.hex(), digest.hex()


def _verify_password(password: str, salt_hex: str, hash_hex: str) -> bool:
    try:
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=2**14,
            r=8,
            p=1,
            dklen=32,
        )
        return hmac.compare_digest(digest.hex(), hash_hex)
    except Exception:  # noqa: BLE001 - malformed stored hash = invalid password
        return False


@router.post("/auth/register")
async def auth_register(body: _Credentials) -> dict[str, Any]:
    _require_local()
    salt, digest = _hash_password(body.password or "desktop")
    async with _PROFILE_LOCK:
        _save_profile(
            {
                "email": body.email,
                "name": body.name or body.email.split("@")[0],
                "password_salt": salt,
                "password_hash": digest,
            }
        )
    return {"accessToken": "desktop", "user": _default_user()}


@router.post("/auth/login")
async def auth_login(body: _Credentials) -> dict[str, Any]:
    _require_local()
    current = _load_profile()
    stored_hash = current.get("password_hash")
    stored_salt = current.get("password_salt")
    if stored_hash and stored_salt:
        if not _verify_password(body.password, stored_salt, stored_hash):
            raise HTTPException(status_code=401, detail="Invalid email or password")
    async with _PROFILE_LOCK:
        # First login with no stored password (e.g. a pre-password profile) is
        # treated as setting the password, so an existing profile is never
        # locked out; every later login must match it.
        _save_profile(
            {
                "email": body.email,
                "name": current.get("name") or body.email.split("@")[0],
                **(
                    {"password_salt": stored_salt, "password_hash": stored_hash}
                    if stored_salt and stored_hash
                    else dict(
                        zip(("password_salt", "password_hash"), _hash_password(body.password), strict=False)
                    )
                ),
            }
        )
    return {"accessToken": "desktop", "user": _default_user()}


@router.post("/auth/logout")
async def auth_logout() -> dict[str, str]:
    _require_local()
    return {"status": "ok"}


@router.post("/auth/me")
async def auth_me() -> dict[str, Any]:
    _require_local()
    return {"user": _default_user()}


# ── Chat (SSE) ─────────────────────────────────────────────────────────────

class _ChatBody(BaseModel):
    """Exactly the payload the in-app UI sends to ``/api/chat/stream``."""

    message: str = Field(min_length=1, max_length=4096)
    conversationId: str | None = Field(default=None, max_length=128)
    provider: str | None = Field(default=None, max_length=32)
    model: str | None = Field(default=None, max_length=128)
    mode: str | None = Field(default=None, max_length=16)
    history: list[dict[str, str]] = Field(default_factory=list)
    documentIds: list[str] = Field(default_factory=list)


@router.post("/chat/stream")
async def chat_stream(request: Request, body: _ChatBody) -> EventSourceResponse:
    _require_local()
    state = request.app.state
    user_id = _DEFAULT_USER

    # New chat → create the conversation up front with a human-readable title
    # derived from the first message, then thread its id into the pipeline so
    # the meta event returns it and the UI attaches to this conversation.
    conversations, _redis = _stores(request)
    conversation_id = body.conversationId
    if conversation_id is None:
        conversation_id = str(uuid.uuid4())
        await conversations.create(user_id, _derive_title(body.message))
        try:
            await conversations.add_message(user_id, conversation_id, "user", body.message)
        except Exception as exc:  # noqa: BLE001 - history must never break chat
            logger.debug("conversation persistence failed: %s", exc)

    query = QueryRequest(
        message=body.message,
        conversation_id=conversation_id,
        user_id=user_id,
        provider=body.provider,
        model=body.model,
        mode=body.mode,
        history=body.history,
        document_ids=body.documentIds,
    )

    async def generator():
        answer: list[str] = []
        try:
            async for event in state.pipeline.stream_query(query):
                if event.get("type") == "chunk":
                    answer.append(str(event.get("text") or ""))
                yield await v1._json_sse(event)
        finally:
            # Persist the exchange (best-effort) so history survives restarts.
            try:
                if not body.conversationId:
                    # New chat: user message was persisted at creation time.
                    await conversations.add_message(
                        user_id, conversation_id, "assistant", "".join(answer)
                    )
                else:
                    await conversations.add_message(
                        user_id, conversation_id, "user", body.message
                    )
                    await conversations.add_message(
                        user_id, conversation_id, "assistant", "".join(answer)
                    )
            except Exception as exc:  # noqa: BLE001 - history must never break chat
                logger.debug("conversation persistence failed: %s", exc)

    return EventSourceResponse(generator(), media_type="text/event-stream")


# ── Conversations ──────────────────────────────────────────────────────────

@router.get("/conversations")
async def list_conversations(request: Request) -> list[dict[str, Any]]:
    _require_local()
    conversations, _ = _stores(request)
    return await conversations.list(_DEFAULT_USER)


@router.post("/conversations")
async def create_conversation(request: Request, body: _TitleBody) -> dict[str, Any]:
    _require_local()
    conversations, _ = _stores(request)
    return await conversations.create(_DEFAULT_USER, body.title)


@router.get("/conversations/{conversation_id}/messages")
async def conversation_messages(request: Request, conversation_id: str) -> list[dict[str, Any]]:
    _require_local()
    conversations, _ = _stores(request)
    messages = await conversations.get_messages(_DEFAULT_USER, conversation_id)
    if messages is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return messages


@router.delete("/conversations/{conversation_id}")
async def remove_conversation(request: Request, conversation_id: str) -> dict[str, str]:
    _require_local()
    conversations, _ = _stores(request)
    if not await conversations.delete(_DEFAULT_USER, conversation_id):
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"status": "ok"}


# ── Settings ───────────────────────────────────────────────────────────────

@router.get("/settings")
async def get_settings(request: Request) -> dict[str, Any]:
    _require_local()
    _conversations, redis = _stores(request)
    web_enabled = await _read_flag(redis, web_search_user_setting_key(_DEFAULT_USER))
    omni_enabled = await _read_flag(redis, omniroute_user_setting_key(_DEFAULT_USER))
    return {
        "webSearch": {"serverEnabled": settings.web_search_enabled, "enabled": web_enabled},
        "omniroute": {"serverEnabled": settings.omniroute_enabled, "enabled": omni_enabled},
    }


@router.put("/settings/web-search")
async def set_web_search(request: Request, body: _ToggleBody) -> dict[str, Any]:
    _require_local()
    _conversations, redis = _stores(request)
    if redis is not None:
        await redis.set(web_search_user_setting_key(_DEFAULT_USER), "1" if body.enabled else "0")
    return {
        "webSearch": {
            "serverEnabled": settings.web_search_enabled,
            "enabled": body.enabled,
        }
    }


@router.put("/settings/omniroute")
async def set_omniroute(request: Request, body: _ToggleBody) -> dict[str, Any]:
    _require_local()
    _conversations, redis = _stores(request)
    if redis is not None:
        await redis.set(omniroute_user_setting_key(_DEFAULT_USER), "1" if body.enabled else "0")
    return {
        "omniroute": {
            "serverEnabled": settings.omniroute_enabled,
            "enabled": body.enabled,
        }
    }


_ONBOARDING_KEY = "rag:user_setting:{user_id}:onboarding_completed"


@router.get("/settings/onboarding")
async def get_onboarding(request: Request) -> dict[str, Any]:
    """Whether the first-run onboarding wizard has been completed for this user."""
    _require_local()
    _conversations, redis = _stores(request)
    completed = await _read_flag(redis, _ONBOARDING_KEY.format(user_id=_DEFAULT_USER))
    return {"completed": completed}


@router.put("/settings/onboarding")
async def set_onboarding(request: Request) -> dict[str, Any]:
    """Mark the first-run onboarding wizard as completed."""
    _require_local()
    _conversations, redis = _stores(request)
    if redis is not None:
        await redis.set(_ONBOARDING_KEY.format(user_id=_DEFAULT_USER), "1")
    return {"completed": True}


# ── Thin aliases to the /api/v1 handlers ──────────────────────────────────

@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    _require_local()
    return await v1.health(request)


@router.get("/models")
async def models() -> dict[str, Any]:
    _require_local()
    return await v1.models()


@router.get("/models/openrouter")
async def models_openrouter() -> dict[str, Any]:
    _require_local()
    return await v1.openrouter_models()


@router.get("/models/omniroute")
async def models_omniroute() -> dict[str, Any]:
    _require_local()
    return await v1.omniroute_models()


@router.get("/analytics/metrics")
async def metrics(request: Request) -> dict[str, Any]:
    _require_local()
    return await v1.metrics(request)


@router.post("/playground/retrieve")
async def playground_retrieve(request: Request, body: _ChatBody) -> dict[str, Any]:
    _require_local()
    from src.domain.models import RetrieveRequest

    retrieve = RetrieveRequest(
        message=body.message,
        user_id=_DEFAULT_USER,
        mode=body.mode,
        provider=body.provider,
        model=body.model,
        document_ids=body.documentIds,
    )
    return await v1.retrieve(request, retrieve)


@router.get("/documents")
async def list_documents(request: Request, user_id: str = _DEFAULT_USER) -> list[dict[str, Any]]:
    _require_local()
    return await documents_api.list_documents(request, user_id)


@router.post("/documents/upload")
async def upload_document(
    request: Request,
    file: Annotated[UploadFile, File()],
    user_id: Annotated[str, Form()] = _DEFAULT_USER,
) -> dict[str, Any]:
    _require_local()
    return await documents_api.upload_document(request, file, user_id)


@router.get("/documents/{document_id}")
async def get_document(
    request: Request, document_id: str, user_id: str = _DEFAULT_USER
) -> dict[str, Any]:
    _require_local()
    return await documents_api.get_document(request, document_id, user_id)


@router.delete("/documents/{document_id}")
async def remove_document(
    request: Request, document_id: str, user_id: str = _DEFAULT_USER
) -> dict[str, str]:
    _require_local()
    return await documents_api.remove_document(request, document_id, user_id)


@router.get("/keys")
async def list_keys(request: Request, user_id: str = _DEFAULT_USER) -> dict[str, Any]:
    _require_local()
    return await keys_api.list_keys(request, user_id)


@router.put("/keys/{provider}")
async def save_key(
    request: Request,
    provider: str,
    body: keys_api.SaveKeyRequest,
    user_id: str = _DEFAULT_USER,
) -> dict[str, Any]:
    _require_local()
    return await keys_api.save_key(request, provider, body, user_id)


@router.delete("/keys/{provider}")
async def remove_key(
    request: Request, provider: str, user_id: str = _DEFAULT_USER
) -> dict[str, str]:
    _require_local()
    return await keys_api.remove_key(request, provider, user_id)


@router.post("/keys/{provider}/test")
async def test_key(
    request: Request, provider: str, user_id: str = _DEFAULT_USER
) -> dict[str, Any]:
    _require_local()
    return await keys_api.test_key(request, provider, user_id)
