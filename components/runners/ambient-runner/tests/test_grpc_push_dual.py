import json
from dataclasses import dataclass, field
from unittest.mock import MagicMock, patch

import pytest


from ambient_runner.middleware.event_compressor import EventCompressor
from ambient_runner.middleware.grpc_push import (
    _event_to_payload,
    _event_type_str,
    _flush_compressor,
    _push_compressed_events,
    _push_event,
)
from tests.conftest import (
    async_event_stream,
    make_run_finished,
    make_run_started,
    make_text_content,
    make_text_end,
    make_text_start,
)


@dataclass
class FakePushCapture:
    calls: list = field(default_factory=list)

    def push(self, session_id: str, event_type: str, payload: str, **kwargs):
        self.calls.append(
            {
                "session_id": session_id,
                "event_type": event_type,
                "payload": payload,
                **kwargs,
            }
        )


@dataclass
class FakeGRPCClient:
    session_messages: FakePushCapture = field(default_factory=FakePushCapture)
    session_events: FakePushCapture = field(default_factory=FakePushCapture)

    def close(self):
        pass

    def reconnect(self):
        pass


class TestEventTypeStr:
    def test_enum_value(self):
        event = make_run_started()
        assert _event_type_str(event) == "RUN_STARTED"

    def test_no_type(self):
        event = MagicMock(spec=[])
        assert _event_type_str(event) == "unknown"


class TestEventToPayload:
    def test_model_dump_path(self):
        event = make_text_content(delta="hello")
        payload = _event_to_payload(event)
        data = json.loads(payload)
        assert data["delta"] == "hello"

    def test_fallback_on_error(self):
        event = MagicMock()
        event.model_dump.side_effect = Exception("boom")
        del event.dict
        event.type = "FAKE"
        payload = _event_to_payload(event)
        data = json.loads(payload)
        assert data["type"] == "FAKE"


class TestPushEvent:
    def test_pushes_to_session_messages(self):
        client = FakeGRPCClient()
        event = make_text_start()
        _push_event(client, "sess-1", event)

        assert len(client.session_messages.calls) == 1
        call = client.session_messages.calls[0]
        assert call["session_id"] == "sess-1"
        assert call["event_type"] == "TEXT_MESSAGE_START"
        data = json.loads(call["payload"])
        assert data["type"] == "TEXT_MESSAGE_START"

    def test_swallows_exceptions(self):
        client = MagicMock()
        client.session_messages.push.side_effect = RuntimeError("fail")
        _push_event(client, "s-1", make_run_started())


class TestPushCompressedEvents:
    def test_standalone_event_pushed_immediately(self):
        client = FakeGRPCClient()
        compressor = EventCompressor()
        _push_compressed_events(client, "sess-1", compressor, make_run_started())

        assert len(client.session_events.calls) == 1
        call = client.session_events.calls[0]
        assert call["event_type"] == "RUN_STARTED"
        assert call["event_count"] == 1

    def test_compressed_group_pushed_on_end(self):
        client = FakeGRPCClient()
        compressor = EventCompressor()

        _push_compressed_events(client, "sess-1", compressor, make_text_start())
        assert len(client.session_events.calls) == 0

        _push_compressed_events(
            client, "sess-1", compressor, make_text_content(delta="hi")
        )
        assert len(client.session_events.calls) == 0

        _push_compressed_events(client, "sess-1", compressor, make_text_end())
        assert len(client.session_events.calls) == 1

        call = client.session_events.calls[0]
        assert call["event_type"] == "TEXT_MESSAGE_START"
        assert call["event_count"] == 3
        assert call["completed_at"] is not None

    def test_swallows_exceptions(self):
        client = MagicMock()
        client.session_events.push.side_effect = RuntimeError("fail")
        compressor = EventCompressor()
        _push_compressed_events(client, "s-1", compressor, make_run_started())


class TestFlushCompressor:
    def test_flush_pushes_remaining(self):
        client = FakeGRPCClient()
        compressor = EventCompressor()
        compressor.feed(make_text_start())
        compressor.feed(make_text_content(delta="partial"))

        _flush_compressor(client, "sess-1", compressor)

        assert len(client.session_events.calls) == 1
        call = client.session_events.calls[0]
        assert call["event_type"] == "TEXT_MESSAGE_START"

    def test_flush_empty_is_noop(self):
        client = FakeGRPCClient()
        compressor = EventCompressor()
        _flush_compressor(client, "sess-1", compressor)
        assert len(client.session_events.calls) == 0

    def test_swallows_exceptions(self):
        client = MagicMock()
        client.session_events.push.side_effect = RuntimeError("fail")
        compressor = EventCompressor()
        compressor.feed(make_text_start())
        _flush_compressor(client, "s-1", compressor)


@pytest.mark.asyncio
class TestGRPCPushMiddlewareNoOp:
    async def test_passthrough_without_grpc_url(self):
        from ambient_runner.middleware.grpc_push import grpc_push_middleware

        events = [make_run_started(), make_text_start(), make_run_finished()]
        with patch.dict("os.environ", {}, clear=True):
            collected = [
                e async for e in grpc_push_middleware(async_event_stream(events))
            ]

        assert len(collected) == 3
        assert collected[0] is events[0]

    async def test_passthrough_with_url_but_no_session_id(self):
        from ambient_runner.middleware.grpc_push import grpc_push_middleware

        events = [make_run_started()]
        with patch.dict(
            "os.environ", {"AMBIENT_GRPC_URL": "localhost:9000"}, clear=True
        ):
            collected = [
                e async for e in grpc_push_middleware(async_event_stream(events))
            ]

        assert len(collected) == 1


@pytest.mark.asyncio
class TestGRPCPushMiddlewareDualPush:
    async def test_dual_push_both_session_messages_and_events(self):
        from ambient_runner.middleware.grpc_push import grpc_push_middleware

        client = FakeGRPCClient()

        events = [
            make_run_started(),
            make_text_start(),
            make_text_content(delta="hey"),
            make_text_end(),
            make_run_finished(),
        ]

        env = {"AMBIENT_GRPC_URL": "localhost:9000", "SESSION_ID": "sess-42"}
        mock_client_cls = MagicMock()
        mock_client_cls.from_env.return_value = client

        with (
            patch.dict("os.environ", env, clear=True),
            patch(
                "ambient_runner.middleware.grpc_push.AmbientGRPCClient",
                mock_client_cls,
                create=True,
            ),
        ):
            with patch(
                "ambient_runner.middleware.grpc_push.__import__",
                side_effect=ImportError,
                create=True,
            ):
                pass

            original_import = (
                __builtins__.__import__
                if hasattr(__builtins__, "__import__")
                else __import__
            )

            def fake_import(name, *args, **kwargs):
                if name == "ambient_platform._grpc_client":
                    mod = MagicMock()
                    mod.AmbientGRPCClient = mock_client_cls
                    return mod
                return original_import(name, *args, **kwargs)

            with patch("builtins.__import__", side_effect=fake_import):
                collected = [
                    e
                    async for e in grpc_push_middleware(
                        async_event_stream(events), session_id="sess-42"
                    )
                ]

        assert len(collected) == 5

        assert len(client.session_messages.calls) == 5
        msg_types = [c["event_type"] for c in client.session_messages.calls]
        assert msg_types == [
            "RUN_STARTED",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
            "RUN_FINISHED",
        ]

        assert len(client.session_events.calls) == 3
        evt_types = [c["event_type"] for c in client.session_events.calls]
        assert "RUN_STARTED" in evt_types
        assert "TEXT_MESSAGE_START" in evt_types
        assert "RUN_FINISHED" in evt_types
