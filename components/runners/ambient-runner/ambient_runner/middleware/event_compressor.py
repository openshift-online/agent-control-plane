"""
Context-aware AG-UI event compressor.

Accumulates fragment events (``*_CONTENT``, ``TOOL_CALL_ARGS``) between
their ``*_START``/``*_END`` boundaries and flushes them as a single
compressed event with ``event_count`` and ``completed_at`` metadata.

Events that are not part of a start/end group are passed through
immediately as single-event records (event_count=1).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from ag_ui.core import BaseEvent

logger = logging.getLogger(__name__)

_FRAGMENT_EVENTS = frozenset(
    {
        "TEXT_MESSAGE_CONTENT",
        "REASONING_MESSAGE_CONTENT",
        "TOOL_CALL_ARGS",
    }
)

_START_EVENTS = frozenset(
    {
        "TEXT_MESSAGE_START",
        "REASONING_MESSAGE_START",
        "TOOL_CALL_START",
    }
)

_END_EVENTS = frozenset(
    {
        "TEXT_MESSAGE_END",
        "REASONING_MESSAGE_END",
        "TOOL_CALL_END",
    }
)

_START_TO_END = {
    "TEXT_MESSAGE_START": "TEXT_MESSAGE_END",
    "REASONING_MESSAGE_START": "REASONING_MESSAGE_END",
    "TOOL_CALL_START": "TOOL_CALL_END",
}

_START_TO_CONTENT = {
    "TEXT_MESSAGE_START": "TEXT_MESSAGE_CONTENT",
    "REASONING_MESSAGE_START": "REASONING_MESSAGE_CONTENT",
    "TOOL_CALL_START": "TOOL_CALL_ARGS",
}


def _event_type_str(event: BaseEvent) -> str:
    raw = getattr(event, "type", None)
    if raw is None:
        return "unknown"
    return str(raw.value) if hasattr(raw, "value") else str(raw)


def _event_to_dict(event: BaseEvent) -> dict:
    try:
        if hasattr(event, "model_dump"):
            return event.model_dump()
        if hasattr(event, "dict"):
            return event.dict()
    except Exception:
        pass
    return {"type": _event_type_str(event)}


@dataclass
class _AccumulatorContext:
    start_type: str
    start_payload: dict
    fragments: list[dict] = field(default_factory=list)
    fragment_count: int = 0
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class CompressedEvent:
    event_type: str
    payload: str
    completed_at: Optional[datetime]
    event_count: int


class EventCompressor:
    """Accumulates AG-UI event fragments and emits compressed events.

    Call ``feed(event)`` for each incoming AG-UI event. It returns a list
    of ``CompressedEvent`` objects ready to be pushed to the Events API.
    Call ``flush()`` at stream end to emit any incomplete accumulations.
    """

    def __init__(self) -> None:
        self._active: Optional[_AccumulatorContext] = None

    def feed(self, event: BaseEvent) -> list[CompressedEvent]:
        event_type = _event_type_str(event)
        event_dict = _event_to_dict(event)
        results: list[CompressedEvent] = []

        if event_type in _START_EVENTS:
            if self._active is not None:
                results.extend(self._flush_active())
            self._active = _AccumulatorContext(
                start_type=event_type,
                start_payload=event_dict,
            )
            return results

        if event_type in _FRAGMENT_EVENTS and self._active is not None:
            expected_content = _START_TO_CONTENT.get(self._active.start_type)
            if expected_content == event_type:
                self._active.fragments.append(event_dict)
                self._active.fragment_count += 1
                return results

        if event_type in _END_EVENTS and self._active is not None:
            expected_end = _START_TO_END.get(self._active.start_type)
            if expected_end == event_type:
                now = datetime.now(timezone.utc)
                total_count = 1 + self._active.fragment_count + 1

                compressed_payload = self._build_compressed_payload(
                    self._active, event_dict
                )
                results.append(
                    CompressedEvent(
                        event_type=self._active.start_type,
                        payload=compressed_payload,
                        completed_at=now,
                        event_count=total_count,
                    )
                )
                self._active = None
                return results

        if self._active is not None:
            results.extend(self._flush_active())

        results.append(
            CompressedEvent(
                event_type=event_type,
                payload=json.dumps(event_dict),
                completed_at=None,
                event_count=1,
            )
        )
        return results

    def flush(self) -> list[CompressedEvent]:
        if self._active is None:
            return []
        return self._flush_active()

    def _flush_active(self) -> list[CompressedEvent]:
        ctx = self._active
        self._active = None
        if ctx is None:
            return []

        now = datetime.now(timezone.utc)
        total_count = 1 + ctx.fragment_count

        compressed_payload = self._build_compressed_payload(ctx, None)
        return [
            CompressedEvent(
                event_type=ctx.start_type,
                payload=compressed_payload,
                completed_at=now,
                event_count=total_count,
            )
        ]

    def _build_compressed_payload(
        self,
        ctx: _AccumulatorContext,
        end_event: Optional[dict],
    ) -> str:
        accumulated = ""
        for frag in ctx.fragments:
            delta = frag.get("delta", "")
            if delta:
                accumulated += delta

        envelope = dict(ctx.start_payload)
        if accumulated:
            envelope["accumulated_content"] = accumulated
        envelope["fragment_count"] = ctx.fragment_count
        if end_event is not None:
            envelope["end_event"] = end_event
        return json.dumps(envelope)
