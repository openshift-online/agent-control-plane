from datetime import datetime, timezone
from unittest.mock import MagicMock, PropertyMock

import grpc

from ambient_runner._session_events_api import (
    SessionEvent,
    SessionEventsAPI,
    _PushEventRequest,
    _SessionEventProto,
    _TimestampLike,
    _decode_varint,
    _encode_int32,
    _encode_string,
    _encode_timestamp,
    _varint,
)


class TestVarintEncoding:
    def test_single_byte(self):
        assert _varint(0) == b"\x00"
        assert _varint(1) == b"\x01"
        assert _varint(127) == b"\x7f"

    def test_multi_byte(self):
        assert _varint(128) == b"\x80\x01"
        assert _varint(300) == b"\xac\x02"

    def test_roundtrip(self):
        for val in (0, 1, 127, 128, 300, 16384, 100000):
            encoded = _varint(val)
            decoded, end = _decode_varint(encoded, 0)
            assert decoded == val
            assert end == len(encoded)


class TestEncodeString:
    def test_basic(self):
        data = _encode_string(1, "abc")
        tag, pos = _decode_varint(data, 0)
        assert tag >> 3 == 1
        assert tag & 0x7 == 2
        length, pos = _decode_varint(data, pos)
        assert length == 3
        assert data[pos : pos + length] == b"abc"

    def test_unicode(self):
        data = _encode_string(2, "hello\u2603")
        tag, pos = _decode_varint(data, 0)
        assert tag >> 3 == 2
        length, pos = _decode_varint(data, pos)
        content = data[pos : pos + length].decode("utf-8")
        assert content == "hello\u2603"


class TestEncodeInt32:
    def test_zero_omitted(self):
        assert _encode_int32(5, 0) == b""

    def test_nonzero(self):
        data = _encode_int32(5, 42)
        tag, pos = _decode_varint(data, 0)
        assert tag >> 3 == 5
        assert tag & 0x7 == 0
        val, _ = _decode_varint(data, pos)
        assert val == 42


class TestEncodeTimestamp:
    def test_zero_omitted(self):
        assert _encode_timestamp(4, 0, 0) == b""

    def test_seconds_only(self):
        data = _encode_timestamp(4, 1700000000, 0)
        tag, pos = _decode_varint(data, 0)
        assert tag >> 3 == 4
        assert tag & 0x7 == 2

    def test_seconds_and_nanos(self):
        data = _encode_timestamp(4, 1700000000, 500000)
        assert len(data) > 0
        tag, pos = _decode_varint(data, 0)
        assert tag >> 3 == 4


class TestPushEventRequestSerialization:
    def test_basic_fields(self):
        req = _PushEventRequest()
        req.session_id = "sess-123"
        req.event_type = "TEXT_MESSAGE_END"
        req.payload = '{"data":"test"}'
        req.event_count = 5

        raw = req.SerializeToString()
        assert len(raw) > 0
        assert b"sess-123" in raw
        assert b"TEXT_MESSAGE_END" in raw
        assert b'{"data":"test"}' in raw

    def test_with_completed_at(self):
        req = _PushEventRequest()
        req.session_id = "s-1"
        req.event_type = "RUN_FINISHED"
        req.payload = "{}"
        req.completed_at_seconds = 1700000000
        req.completed_at_nanos = 500000
        req.event_count = 1

        raw = req.SerializeToString()
        assert len(raw) > 0

    def test_empty_request(self):
        req = _PushEventRequest()
        raw = req.SerializeToString()
        assert raw == b""


class TestSessionEventProtoDeserialization:
    def test_roundtrip_through_push_request(self):
        req = _PushEventRequest()
        req.session_id = "sess-abc"
        req.event_type = "TOOL_CALL_END"
        req.payload = '{"tool":"Read"}'
        req.event_count = 3
        _raw = req.SerializeToString()

    def test_from_string_with_string_fields(self):
        data = b""
        data += _encode_string(1, "evt-id-1")
        data += _encode_string(2, "sess-xyz")
        data += _encode_string(4, "TEXT_MESSAGE_END")
        data += _encode_string(5, '{"content":"hello"}')

        msg = _SessionEventProto.FromString(data)
        assert msg.id == "evt-id-1"
        assert msg.session_id == "sess-xyz"
        assert msg.event_type == "TEXT_MESSAGE_END"
        assert msg.payload == '{"content":"hello"}'

    def test_from_string_with_varint_fields(self):
        data = b""
        data += _encode_string(1, "e-1")
        seq_tag = (3 << 3) | 0
        data += _varint(seq_tag) + _varint(42)
        ec_tag = (8 << 3) | 0
        data += _varint(ec_tag) + _varint(7)

        msg = _SessionEventProto.FromString(data)
        assert msg.id == "e-1"
        assert msg.seq == 42
        assert msg.event_count == 7

    def test_from_string_with_timestamp(self):
        inner = _varint((1 << 3) | 0) + _varint(1700000000)
        inner += _varint((2 << 3) | 0) + _varint(500000)

        data = b""
        data += _encode_string(1, "e-ts")
        ts_tag = (6 << 3) | 2
        data += _varint(ts_tag) + _varint(len(inner)) + inner

        msg = _SessionEventProto.FromString(data)
        assert msg.id == "e-ts"
        assert msg.created_at is not None
        assert msg.created_at.seconds == 1700000000
        assert msg.created_at.nanos == 500000

    def test_from_string_empty(self):
        msg = _SessionEventProto.FromString(b"")
        assert msg.id == ""
        assert msg.seq == 0
        assert msg.event_count == 0


class TestSessionEventFromProto:
    def test_basic_conversion(self):
        pb = MagicMock()
        pb.id = "evt-1"
        pb.session_id = "sess-1"
        pb.seq = 10
        pb.event_type = "RUN_STARTED"
        pb.payload = "{}"
        pb.created_at = _TimestampLike(1700000000, 0)
        pb.completed_at = None
        pb.event_count = 1

        evt = SessionEvent._from_proto(pb)
        assert evt.id == "evt-1"
        assert evt.session_id == "sess-1"
        assert evt.seq == 10
        assert evt.event_type == "RUN_STARTED"
        assert evt.created_at is not None
        assert evt.completed_at is None
        assert evt.event_count == 1

    def test_with_completed_at(self):
        pb = MagicMock()
        pb.id = "evt-2"
        pb.session_id = "sess-2"
        pb.seq = 5
        pb.event_type = "TEXT_MESSAGE_END"
        pb.payload = '{"text":"hi"}'
        pb.created_at = _TimestampLike(1700000000, 0)
        pb.completed_at = _TimestampLike(1700000001, 500000)
        pb.event_count = 4

        evt = SessionEvent._from_proto(pb)
        assert evt.completed_at is not None
        assert evt.event_count == 4


class TestSessionEventsAPIPush:
    def _make_api(self, push_return=None, push_side_effect=None):
        channel = MagicMock()
        rpc_callable = MagicMock()
        if push_side_effect is not None:
            rpc_callable.side_effect = push_side_effect
        elif push_return is not None:
            rpc_callable.return_value = push_return
        channel.unary_unary.return_value = rpc_callable

        api = SessionEventsAPI(channel, token="test-token")
        return api, rpc_callable

    def _make_response_proto(self, seq=1):
        pb = _SessionEventProto()
        pb.id = "evt-resp"
        pb.session_id = "sess-1"
        pb.seq = seq
        pb.event_type = "TEXT_MESSAGE_END"
        pb.payload = "{}"
        pb.event_count = 3
        return pb

    def test_push_success(self):
        resp = self._make_response_proto(seq=42)
        api, rpc = self._make_api(push_return=resp)

        result = api.push("sess-1", "TEXT_MESSAGE_END", '{"data":"x"}', event_count=3)

        assert result is not None
        assert result.seq == 42
        rpc.assert_called_once()

    def test_push_returns_none_on_rpc_error(self):
        exc = grpc.RpcError()
        exc.code = MagicMock(return_value=grpc.StatusCode.INTERNAL)
        api, _ = self._make_api(push_side_effect=exc)

        result = api.push("sess-1", "RUN_STARTED", "{}")
        assert result is None

    def test_push_returns_none_on_generic_exception(self):
        api, _ = self._make_api(push_side_effect=RuntimeError("boom"))

        result = api.push("sess-1", "RUN_STARTED", "{}")
        assert result is None

    def test_push_with_completed_at(self):
        resp = self._make_response_proto()
        api, rpc = self._make_api(push_return=resp)

        ts = datetime(2024, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        result = api.push(
            "sess-1",
            "TEXT_MESSAGE_END",
            "{}",
            completed_at=ts,
            event_count=5,
        )

        assert result is not None
        rpc.assert_called_once()
        req = rpc.call_args[0][0]
        assert req.completed_at_seconds == int(ts.timestamp())

    def test_unauthenticated_retry(self):
        exc = grpc.RpcError()
        exc.code = MagicMock(return_value=grpc.StatusCode.UNAUTHENTICATED)

        resp = self._make_response_proto(seq=99)

        grpc_client = MagicMock()
        new_api = MagicMock()
        new_rpc = MagicMock(return_value=resp)
        new_api._push_rpc = new_rpc
        new_api._metadata = [("authorization", "Bearer refreshed")]
        type(grpc_client).session_events = PropertyMock(return_value=new_api)

        channel = MagicMock()
        first_rpc = MagicMock(side_effect=exc)
        channel.unary_unary.return_value = first_rpc

        api = SessionEventsAPI(channel, token="old-token", grpc_client=grpc_client)
        result = api.push("sess-1", "RUN_STARTED", "{}")

        assert result is not None
        assert result.seq == 99
        grpc_client.reconnect.assert_called_once()

    def test_unauthenticated_no_grpc_client_returns_none(self):
        exc = grpc.RpcError()
        exc.code = MagicMock(return_value=grpc.StatusCode.UNAUTHENTICATED)

        api, _ = self._make_api(push_side_effect=exc)
        result = api.push("sess-1", "RUN_STARTED", "{}")
        assert result is None

    def test_metadata_includes_bearer_token(self):
        channel = MagicMock()
        channel.unary_unary.return_value = MagicMock()

        api = SessionEventsAPI(channel, token="my-secret-token")
        assert ("authorization", "Bearer my-secret-token") in api._metadata

    def test_no_token_no_metadata(self):
        channel = MagicMock()
        channel.unary_unary.return_value = MagicMock()

        api = SessionEventsAPI(channel, token="")
        assert api._metadata == []
