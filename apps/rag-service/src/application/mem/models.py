"""Memory data model: types, priorities, sources, relationships, and the
canonical ``Memory`` object the agent operates on."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class MemoryType(StrEnum):
    EPISODIC = "episodic"  # what happened in past conversations/events
    SEMANTIC = "semantic"  # durable facts/preferences/projects/identity
    PROCEDURAL = "procedural"  # how the user does things (workflows, habits)
    RELATIONSHIP = "relationship"  # connections between people/topics/memories
    PROSPECTIVE = "prospective"  # future intents, upcoming tests, scheduled reminders

    @classmethod
    def from_extractor(cls, raw: str) -> MemoryType:
        """Map the extractor's coarse type tags onto the richer enum."""
        value = (raw or "").strip().lower()
        if value in {"preference", "project", "fact", "contact", "constraint",
                     "style", "inference", "preferences"}:
            return cls.SEMANTIC
        if value in {"prospective", "intent", "todo", "reminder", "schedule"}:
            return cls.PROSPECTIVE
        if value == "procedure":
            return cls.PROCEDURAL
        if value in {"relationship", "relation"}:
            return cls.RELATIONSHIP
        return cls.SEMANTIC


class MemoryPriority(StrEnum):
    CRITICAL = "critical"  # importance >= 0.8 — identity/relationships/contacts
    IMPORTANT = "important"  # importance >= 0.6
    NORMAL = "normal"  # importance >= 0.4
    LOW = "low"  # importance >= 0.25
    TRANSIENT = "transient"  # everything below — the first to be forgotten

    @classmethod
    def from_importance(cls, importance: float) -> MemoryPriority:
        if importance >= 0.8:
            return cls.CRITICAL
        if importance >= 0.6:
            return cls.IMPORTANT
        if importance >= 0.4:
            return cls.NORMAL
        if importance >= 0.25:
            return cls.LOW
        return cls.TRANSIENT


class MemorySource(StrEnum):
    USER = "user"
    SYSTEM = "system"
    CONVERSATION = "conversation"
    DOCUMENT = "document"
    WEB = "web"


class MemoryStage(StrEnum):
    """Lifecycle stage (item 13): candidate → confirmed → stable → stale → archived.

    - ``candidate`` — extracted but not yet corroborated (one observation).
    - ``confirmed`` — corroborated by re-statement/recall (evidence count).
    - ``stable`` — high-importance, repeatedly accessed durable knowledge.
    - ``stale`` — confirmed knowledge that has stopped being used.
    - ``archived`` — soft-deleted terminal state (manual archive / forget).
    """

    CANDIDATE = "candidate"
    CONFIRMED = "confirmed"
    STABLE = "stable"
    STALE = "stale"
    ARCHIVED = "archived"


class MemoryCategory(StrEnum):
    """Knowledge taxonomy (item 16): facts vs preferences vs style vs inference.

    The extractor's coarse ``type`` tags are promoted to these categories so
    the recall path can split "what the user believes" from "how the user
    likes it" from "the assistant's inferences".
    """

    FACT = "fact"
    PREFERENCE = "preference"
    STYLE = "style"
    INFERENCE = "inference"

    @classmethod
    def from_type_tag(cls, raw: str) -> MemoryCategory:
        value = (raw or "").strip().lower()
        if value in {"preference", "preferences"}:
            return cls.PREFERENCE
        if value in {"style"}:
            return cls.STYLE
        if value in {"inference", "guess", "assumption"}:
            return cls.INFERENCE
        return cls.FACT


@dataclass
class RelationshipLink:
    """A typed connection between a memory (or entity) and another."""

    target: str  # memory id or entity name
    rel_type: str = "RELATED_TO"
    confidence: float = 0.8
    description: str = ""


@dataclass
class Memory:
    """Canonical memory object flowing through the agent lifecycle.

    Embeds the human-memory attributes that matter for management: importance
    (how critical it is), recency/usage (how freshly it is recalled), a TTL
    (forgetting horizon), and graph relationships (what it connects to).
    """

    id: str
    user_id: str
    type: MemoryType
    content: str
    importance: float = 0.5
    embedding: list[float] | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    source: MemorySource = MemorySource.CONVERSATION
    ttl_days: int | None = None
    access_count: int = 0
    last_accessed_at: datetime | None = None
    relationships: list[RelationshipLink] = field(default_factory=list)
    version: int = 1
    category: MemoryCategory = MemoryCategory.FACT
    stage: MemoryStage = MemoryStage.CANDIDATE
    confidence: float = 0.7
    evidence_count: int = 1

    @property
    def priority(self) -> MemoryPriority:
        return MemoryPriority.from_importance(self.importance)

    @property
    def ttl(self) -> int:
        if self.ttl_days is not None:
            return self.ttl_days
        if self.importance >= 0.8:
            return 365
        if self.importance >= 0.6:
            return 180
        if self.importance >= 0.4:
            return 90
        return 30

    def to_graph_properties(self) -> dict[str, Any]:
        """Node properties for the Neo4j store."""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "type": self.type.value,
            "content": self.content,
            "importance": self.importance,
            "source": self.source.value,
            "created_at": self.created_at.isoformat(),
            "access_count": self.access_count,
            "category": self.category.value,
            "stage": self.stage.value,
            "confidence": self.confidence,
            "evidence_count": self.evidence_count,
        }


class ProspectiveStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"  # claimed by a scheduler worker, not yet dispatched
    DISPATCHED = "dispatched"  # enqueued to its target queue (exactly-once)
    SURFACED = "surfaced"
    ACKNOWLEDGED = "acknowledged"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    SNOOZED = "snoozed"
    EXPIRED = "expired"
    FAILED = "failed"


class ScheduleType(StrEnum):
    ONCE = "once"
    DAILY = "daily"
    WEEKLY = "weekly"
    CRON = "cron"
    EVENT_RELATIVE = "event_relative"
    NEXT_VISIT = "next_visit"


@dataclass
class ProspectiveMemory:
    """Prospective Memory — 'What to remember / what should happen'."""

    id: str
    user_id: str
    subject: str
    content: str
    event_at: datetime | None = None
    timezone: str = "Asia/Kolkata"
    # Item 17: how confident we are in the timezone and where it came from.
    timezone_source: str = "default"  # explicit | inferred | default
    timezone_confidence: float = 0.3
    importance: float = 0.8
    status: ProspectiveStatus = ProspectiveStatus.PENDING
    snoozed_until: datetime | None = None
    surface_policy: dict[str, Any] = field(
        default_factory=lambda: {
            "mode": "next_visit",
            "max_frequency": 1,
            "max_context_items": 2,
            "require_relevance": True,
        }
    )
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class ScheduledIntent:
    """Scheduled Intent — 'When the system should act' on a ProspectiveMemory."""

    id: str
    prospective_memory_id: str
    user_id: str
    trigger_at: datetime
    trigger_at_utc: datetime
    timezone: str = "Asia/Kolkata"
    schedule_type: ScheduleType = ScheduleType.ONCE
    trigger_policy: str = "1_day_before"
    action: str = "RETURN_CONTEXT"  # REMIND_USER | REVISIT_MEMORY | ASK_FOLLOWUP | RETURN_CONTEXT
    payload: dict[str, Any] = field(default_factory=dict)
    idempotency_key: str = ""
    status: ProspectiveStatus = ProspectiveStatus.PENDING
    # Item 10: scheduler-side retry/DLQ bookkeeping (backoff + escalation).
    attempt_count: int = 0
    next_attempt_at: datetime | None = None
    last_error: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

