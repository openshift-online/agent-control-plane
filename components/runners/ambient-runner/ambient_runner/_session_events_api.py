from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ._grpc_client import AmbientGRPCClient

import grpc

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SessionEvent:
    id: str
    session_id: str
    seq: int
    event_type: str
    payload: str
    created_at: Optional[datetime]
    completed_at: Optional[datetime]
    event_count: int

    @classmethod
    def _from_proto(cls, pb: object) -> SessionEvent:
        created_at: Optional[datetime] = None
        ts = getattr(pb, "created_at", None)
        if ts is not None:
            try:
                created_at = datetime.fromtimestamp(
                    ts.seconds + ts.nanos / 1e9, tz=timezone.utc
                )
            except Exception:
                pass
        completed_at: Optional[datetime] = None
        ts2 = getattr(pb, "completed_at", None)
        if ts2 is not None:
            try:
                completed_at = datetime.fromtimestamp(
                    ts2.seconds + ts2.nanos / 1e9, tz=timezone.utc
                )
            except Exception:
                pass
        return cls(
            id=getattr(pb, "id", ""),
            session_id=getattr(pb, "session_id", ""),
            seq=getattr(pb, "seq", 0),
            event_type=getattr(pb, "event_type", ""),
            payload=getattr(pb, "payload", ""),
            created_at=created_at,
            completed_at=completed_at,
            event_count=getattr(pb, "event_count", 1),
        )


class SessionEventsAPI:
    _PUSH_METHOD = "/ambient.v1.SessionService/PushSessionEvent"

    def __init__(
        self,
        channel: grpc.Channel,
        token: str = "",
        grpc_client: Optional[AmbientGRPCClient] = None,
    ) -> None:
        self._grpc_client = grpc_client
        self._metadata = [("authorization", f"Bearer {token}")] if token else []
        self._push_rpc = channel.unary_unary(
            self._PUSH_METHOD,
            request_serializer=_PushEventRequest.SerializeToString,
            response_deserializer=_SessionEventProto.FromString,
        )

    def push(
        self,
        session_id: str,
        event_type: str,
        payload: str,
        *,
        completed_at: Optional[datetime] = None,
        event_count: int = 1,
        timeout: float = 5.0,
    ) -> Optional[SessionEvent]:
        logger.info(
            "[GRPC EVENT PUSH→] session=%s event_type=%s payload_len=%d event_count=%d",
            session_id,
            event_type,
            len(payload),
            event_count,
        )
        req = _PushEventRequest()
        req.session_id = session_id
        req.event_type = event_type
        req.payload = payload
        req.event_count = event_count
        if completed_at is not None:
            req.completed_at_seconds = int(completed_at.timestamp())
            req.completed_at_nanos = completed_at.microsecond * 1000

        for attempt in range(2):
            try:
                pb = self._push_rpc(req, timeout=timeout, metadata=self._metadata)
                result = SessionEvent._from_proto(pb)
                logger.info(
                    "[GRPC EVENT PUSH→] OK session=%s event_type=%s seq=%d",
                    session_id,
                    event_type,
                    result.seq,
                )
                return result
            except grpc.RpcError as exc:
                if (
                    attempt == 0
                    and exc.code() == grpc.StatusCode.UNAUTHENTICATED
                    and self._grpc_client is not None
                ):
                    logger.warning(
                        "[GRPC EVENT PUSH→] UNAUTHENTICATED — reconnecting (session=%s)",
                        session_id,
                    )
                    self._grpc_client.reconnect()
                    new_api = self._grpc_client.session_events
                    self._push_rpc = new_api._push_rpc
                    self._metadata = new_api._metadata
                    continue
                logger.warning(
                    "[GRPC EVENT PUSH→] FAILED PushSessionEvent (session=%s event=%s): %s",
                    session_id,
                    event_type,
                    exc,
                )
                return None
            except Exception as exc:
                logger.warning(
                    "[GRPC EVENT PUSH→] FAILED unexpected error (session=%s): %s",
                    session_id,
                    exc,
                )
                return None
        return None


def _encode_string(field_number: int, value: str) -> bytes:
    encoded = value.encode("utf-8")
    tag = (field_number << 3) | 2
    return _varint(tag) + _varint(len(encoded)) + encoded


def _encode_int32(field_number: int, value: int) -> bytes:
    if value == 0:
        return b""
    tag = (field_number << 3) | 0
    return _varint(tag) + _varint(value)


def _encode_int64(field_number: int, value: int) -> bytes:
    if value == 0:
        return b""
    tag = (field_number << 3) | 0
    return _varint(tag) + _varint(value)


def _encode_timestamp(field_number: int, seconds: int, nanos: int) -> bytes:
    inner = b""
    if seconds:
        inner += _varint((1 << 3) | 0) + _varint(seconds)
    if nanos:
        inner += _varint((2 << 3) | 0) + _varint(nanos)
    if not inner:
        return b""
    tag = (field_number << 3) | 2
    return _varint(tag) + _varint(len(inner)) + inner


def _varint(value: int) -> bytes:
    bits = value & 0x7F
    value >>= 7
    result = b""
    while value:
        result += bytes([0x80 | bits])
        bits = value & 0x7F
        value >>= 7
    result += bytes([bits])
    return result


def _decode_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7


class _PushEventRequest:
    def __init__(self) -> None:
        self.session_id: str = ""
        self.event_type: str = ""
        self.payload: str = ""
        self.completed_at_seconds: int = 0
        self.completed_at_nanos: int = 0
        self.event_count: int = 0

    def SerializeToString(self) -> bytes:
        out = b""
        if self.session_id:
            out += _encode_string(1, self.session_id)
        if self.event_type:
            out += _encode_string(2, self.event_type)
        if self.payload:
            out += _encode_string(3, self.payload)
        if self.completed_at_seconds or self.completed_at_nanos:
            out += _encode_timestamp(
                4, self.completed_at_seconds, self.completed_at_nanos
            )
        if self.event_count:
            out += _encode_int32(5, self.event_count)
        return out


class _TimestampLike:
    __slots__ = ("seconds", "nanos")

    def __init__(self, seconds: int, nanos: int) -> None:
        self.seconds = seconds
        self.nanos = nanos


class _SessionEventProto:
    __slots__ = (
        "id",
        "session_id",
        "seq",
        "event_type",
        "payload",
        "created_at",
        "completed_at",
        "event_count",
    )

    def __init__(self) -> None:
        self.id: str = ""
        self.session_id: str = ""
        self.seq: int = 0
        self.event_type: str = ""
        self.payload: str = ""
        self.created_at: Optional[_TimestampLike] = None
        self.completed_at: Optional[_TimestampLike] = None
        self.event_count: int = 0

    @classmethod
    def FromString(cls, data: bytes) -> _SessionEventProto:
        msg = cls()
        pos = 0
        while pos < len(data):
            tag_varint, pos = _decode_varint(data, pos)
            field_number = tag_varint >> 3
            wire_type = tag_varint & 0x7
            if wire_type == 2:
                length, pos = _decode_varint(data, pos)
                value_bytes = data[pos : pos + length]
                pos += length
                if field_number == 1:
                    msg.id = value_bytes.decode("utf-8", errors="replace")
                elif field_number == 2:
                    msg.session_id = value_bytes.decode("utf-8", errors="replace")
                elif field_number == 4:
                    msg.event_type = value_bytes.decode("utf-8", errors="replace")
                elif field_number == 5:
                    msg.payload = value_bytes.decode("utf-8", errors="replace")
                elif field_number == 6:
                    msg.created_at = _parse_timestamp(value_bytes)
                elif field_number == 7:
                    msg.completed_at = _parse_timestamp(value_bytes)
            elif wire_type == 0:
                value, pos = _decode_varint(data, pos)
                if field_number == 3:
                    msg.seq = value
                elif field_number == 8:
                    msg.event_count = value
            elif wire_type == 1:
                pos += 8
            elif wire_type == 5:
                pos += 4
            else:
                break
        return msg


def _parse_timestamp(data: bytes) -> Optional[_TimestampLike]:
    seconds = 0
    nanos = 0
    pos = 0
    while pos < len(data):
        tag_varint, pos = _decode_varint(data, pos)
        field_number = tag_varint >> 3
        wire_type = tag_varint & 0x7
        if wire_type == 0:
            value, pos = _decode_varint(data, pos)
            if field_number == 1:
                seconds = value
            elif field_number == 2:
                nanos = value
        elif wire_type == 2:
            length, pos = _decode_varint(data, pos)
            pos += length
        elif wire_type == 1:
            pos += 8
        elif wire_type == 5:
            pos += 4
        else:
            break
    return _TimestampLike(seconds, nanos)
