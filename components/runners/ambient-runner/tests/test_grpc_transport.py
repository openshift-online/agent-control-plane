"""Tests for GRPCSessionListener and GRPCMessageWriter in grpc_transport.py.

Coverage targets:
- GRPCSessionListener: ready event lifecycle, message type filtering,
  fan-out to SSE queues, stop/cancel, bridge.run() called with correct RunnerInput,
  exception in bridge.run() synthesizes RUN_ERROR, invalid JSON fallback
- GRPCMessageWriter: MESSAGES_SNAPSHOT accumulation, RUN_FINISHED/RUN_ERROR push,
  non-terminal events ignored, push offloaded to executor (non-blocking),
  push failure logged without re-raising
- _synthesize_run_error: feeds RUN_ERROR to SSE queue, schedules writer persist
"""

import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.conftest import (
    async_event_stream,
    make_run_finished,
    make_text_content,
    make_text_start,
)

from ambient_runner.bridges.claude.grpc_transport import (
    GRPCMessageWriter,
    GRPCSessionListener,
    _synthesize_run_error,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_session_message(event_type: str, payload: str, seq: int = 1):
    msg = MagicMock()
    msg.event_type = event_type
    msg.payload = payload
    msg.seq = seq
    msg.session_id = "sess-1"
    return msg


def _make_runner_payload(
    thread_id: str = "t-1",
    run_id: str = "r-1",
    content: str = "hello",
) -> str:
    return json.dumps(
        {
            "threadId": thread_id,
            "runId": run_id,
            "messages": [{"id": str(uuid.uuid4()), "role": "user", "content": content}],
        }
    )


def _make_grpc_client(messages=None):
    """Return a mock AmbientGRPCClient whose watch() yields the given messages."""
    client = MagicMock()
    client.session_messages.watch.return_value = iter(messages or [])
    client.session_messages.push.return_value = MagicMock(seq=1)
    return client


def _make_bridge(active_streams=None):
    bridge = MagicMock()
    bridge._active_streams = active_streams if active_streams is not None else {}
    return bridge


# ---------------------------------------------------------------------------
# GRPCSessionListener — ready event
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestGRPCSessionListenerReady:
    async def test_ready_set_after_watch_opens(self):
        client = _make_grpc_client(messages=[])
        bridge = _make_bridge()
        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            assert listener.ready.is_set()
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_ready_not_set_before_watch(self):
        bridge = _make_bridge()
        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        assert not listener.ready.is_set()

    async def test_ready_set_on_successful_watch(self):
        client = _make_grpc_client(messages=[])
        bridge = _make_bridge()
        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            assert listener.ready.is_set()
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


# ---------------------------------------------------------------------------
# GRPCSessionListener — message filtering
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestGRPCSessionListenerFiltering:
    async def test_non_user_messages_do_not_trigger_run(self):
        msgs = [
            _make_session_message("assistant", '{"foo": "bar"}', seq=1),
            _make_session_message("system", "{}", seq=2),
        ]
        client = _make_grpc_client(messages=msgs)
        bridge = _make_bridge()
        bridge.run = AsyncMock(return_value=async_event_stream([]))

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.1)
            bridge.run.assert_not_called()
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_user_message_triggers_bridge_run(self):
        payload = _make_runner_payload(
            thread_id="t-1", run_id="r-1", content="do the thing"
        )
        msgs = [_make_session_message("user", payload, seq=1)]
        client = _make_grpc_client(messages=msgs)
        bridge = _make_bridge()

        run_inputs = []

        async def fake_run(input_data):
            run_inputs.append(input_data)
            yield make_text_start()
            yield make_run_finished()

        bridge.run = fake_run
        bridge._active_streams = {}

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.3)
            assert len(run_inputs) == 1
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_user_message_run_called_with_correct_thread_id(self):
        """bridge.run() must receive input_data with thread_id from the message payload."""
        payload = _make_runner_payload(
            thread_id="t-specific", run_id="r-42", content="hello"
        )
        msgs = [_make_session_message("user", payload, seq=5)]
        client = _make_grpc_client(messages=msgs)
        bridge = _make_bridge()

        run_inputs = []

        async def fake_run(input_data):
            run_inputs.append(input_data)
            yield make_run_finished()

        bridge.run = fake_run
        bridge._active_streams = {}

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.3)
            assert len(run_inputs) == 1
            assert run_inputs[0].thread_id == "t-specific"
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_invalid_json_payload_uses_raw_as_content_fallback(self):
        """Invalid JSON in payload falls back to creating a message with raw payload as content."""
        msgs = [_make_session_message("user", "not-json", seq=1)]
        client = _make_grpc_client(messages=msgs)
        bridge = _make_bridge()

        run_inputs = []

        async def fake_run(input_data):
            run_inputs.append(input_data)
            yield make_run_finished()

        bridge.run = fake_run
        bridge._active_streams = {}

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.3)
            assert len(run_inputs) == 1
            msgs_in_input = run_inputs[0].messages
            assert len(msgs_in_input) == 1
            msg = msgs_in_input[0]
            role = msg["role"] if isinstance(msg, dict) else getattr(msg, "role", None)
            content = (
                msg["content"]
                if isinstance(msg, dict)
                else getattr(msg, "content", None)
            )
            assert role == "user"
            assert content == "not-json"
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_bridge_run_exception_synthesizes_run_error_to_sse_queue(self):
        """If bridge.run() raises, a RUN_ERROR event must be fed to the SSE tap queue."""
        payload = _make_runner_payload(thread_id="t-err", run_id="r-err")
        msgs = [_make_session_message("user", payload, seq=1)]
        client = _make_grpc_client(messages=msgs)

        tap_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        active_streams = {"t-err": tap_queue}
        bridge = _make_bridge(active_streams=active_streams)

        async def exploding_run(input_data):
            raise RuntimeError("boom")
            yield  # make it a generator

        bridge.run = exploding_run

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.5)

            run_error_events = []
            while not tap_queue.empty():
                ev = tap_queue.get_nowait()
                raw = getattr(ev, "type", None)
                ev_str = raw.value if hasattr(raw, "value") else str(raw)
                if "RUN_ERROR" in ev_str:
                    run_error_events.append(ev)
            assert len(run_error_events) >= 1
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


# ---------------------------------------------------------------------------
# GRPCSessionListener — fan-out
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestGRPCSessionListenerFanOut:
    async def test_events_fed_to_active_streams_queue(self):
        payload = _make_runner_payload(thread_id="t-fanout", run_id="r-1")
        msgs = [_make_session_message("user", payload, seq=1)]
        client = _make_grpc_client(messages=msgs)

        received_events = []
        tap_queue: asyncio.Queue = asyncio.Queue(maxsize=100)

        bridge = _make_bridge(active_streams={"t-fanout": tap_queue})
        events = [make_text_start(), make_text_content(), make_run_finished()]

        async def fake_run(input_data):
            for e in events:
                yield e

        bridge.run = fake_run

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.3)
            while not tap_queue.empty():
                received_events.append(tap_queue.get_nowait())
            assert len(received_events) == len(events)
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_no_active_stream_fan_out_skipped_silently(self):
        payload = _make_runner_payload(thread_id="t-1", run_id="r-1")
        msgs = [_make_session_message("user", payload, seq=1)]
        client = _make_grpc_client(messages=msgs)
        bridge = _make_bridge(active_streams={})

        events = [make_text_start(), make_run_finished()]

        async def fake_run(input_data):
            for e in events:
                yield e

        bridge.run = fake_run

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.3)
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_full_queue_drops_event_without_raising(self):
        payload = _make_runner_payload(thread_id="t-full", run_id="r-1")
        msgs = [_make_session_message("user", payload, seq=1)]
        client = _make_grpc_client(messages=msgs)

        full_queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        full_queue.put_nowait(make_text_start())

        bridge = _make_bridge(active_streams={"t-full": full_queue})
        events = [make_text_start(), make_run_finished()]

        async def fake_run(input_data):
            for e in events:
                yield e

        bridge.run = fake_run

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.3)
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_active_streams_entry_removed_after_turn(self):
        payload = _make_runner_payload(thread_id="t-cleanup", run_id="r-1")
        msgs = [_make_session_message("user", payload, seq=1)]
        client = _make_grpc_client(messages=msgs)

        tap_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        active_streams = {"t-cleanup": tap_queue}
        bridge = _make_bridge(active_streams=active_streams)

        async def fake_run(input_data):
            yield make_run_finished()

        bridge.run = fake_run

        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client

        task = asyncio.create_task(listener._listen_loop())
        try:
            await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
            await asyncio.sleep(0.3)
            assert "t-cleanup" not in active_streams
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


# ---------------------------------------------------------------------------
# GRPCSessionListener — stop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestGRPCSessionListenerStop:
    async def test_stop_cancels_task(self):
        client = _make_grpc_client(messages=[])
        bridge = _make_bridge()
        listener = GRPCSessionListener(
            bridge=bridge, session_id="s-1", grpc_url="localhost:9000"
        )
        listener._grpc_client = client
        listener._task = asyncio.create_task(listener._listen_loop())

        await asyncio.wait_for(listener.ready.wait(), timeout=2.0)
        await listener.stop()
        assert listener._task.done()


# ---------------------------------------------------------------------------
# GRPCMessageWriter — consume
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestGRPCMessageWriterConsume:
    def _writer(self):
        client = MagicMock()
        client.session_messages.push.return_value = MagicMock(seq=1)
        return GRPCMessageWriter(
            session_id="s-1", run_id="r-1", grpc_client=client
        ), client

    def _text_events(self, text="hello"):
        start = MagicMock()
        start.type = MagicMock(value="TEXT_MESSAGE_START")
        content = MagicMock()
        content.type = MagicMock(value="TEXT_MESSAGE_CONTENT")
        content.delta = text
        end = MagicMock()
        end.type = MagicMock(value="TEXT_MESSAGE_END")
        return start, content, end

    async def test_text_message_buffered(self):
        writer, _ = self._writer()
        start, content, _ = self._text_events("hi")
        await writer.consume(start)
        await writer.consume(content)
        assert writer._text_buffer == "hi"

    async def test_text_message_end_pushes(self):
        writer, client = self._writer()
        for ev in self._text_events("done"):
            await writer.consume(ev)
        client.session_messages.push.assert_called_once()

    async def test_text_message_end_clears_buffer(self):
        writer, _ = self._writer()
        for ev in self._text_events("done"):
            await writer.consume(ev)
        assert writer._text_buffer == ""

    async def test_empty_text_does_not_push(self):
        writer, client = self._writer()
        start, _, end = self._text_events()
        await writer.consume(start)
        await writer.consume(end)
        client.session_messages.push.assert_not_called()

    async def test_content_without_end_does_not_push(self):
        writer, client = self._writer()
        start, content, _ = self._text_events()
        await writer.consume(start)
        await writer.consume(content)
        client.session_messages.push.assert_not_called()

    async def test_unknown_event_type_ignored(self):
        writer, client = self._writer()
        event = MagicMock()
        event.type = None
        await writer.consume(event)
        client.session_messages.push.assert_not_called()

    async def test_no_grpc_client_push_skipped(self):
        writer = GRPCMessageWriter(session_id="s-1", run_id="r-1", grpc_client=None)
        for ev in self._text_events("test"):
            await writer.consume(ev)

    async def test_push_includes_correct_session_id(self):
        writer, client = self._writer()
        for ev in self._text_events("test"):
            await writer.consume(ev)
        assert client.session_messages.push.call_args[0][0] == "s-1"
        assert client.session_messages.push.call_args[1]["event_type"] == "assistant"

    async def test_push_offloaded_to_executor_not_inline(self):
        writer, client = self._writer()

        executor_calls = []
        real_loop = asyncio.get_event_loop()
        original = real_loop.run_in_executor

        async def capturing(executor, fn, *args):
            executor_calls.append(fn)
            return await original(executor, fn, *args)

        with patch.object(real_loop, "run_in_executor", side_effect=capturing):
            for ev in self._text_events("test"):
                await writer.consume(ev)

        assert len(executor_calls) == 1

    async def test_push_failure_does_not_raise(self):
        writer, client = self._writer()
        client.session_messages.push.side_effect = RuntimeError("rpc unavailable")
        for ev in self._text_events("test"):
            await writer.consume(ev)

    async def test_push_error_flushes_buffer_then_pushes_error(self):
        writer, client = self._writer()
        start, content, _ = self._text_events("partial")
        await writer.consume(start)
        await writer.consume(content)
        await writer.push_error("something broke")
        assert client.session_messages.push.call_count == 2
        calls = client.session_messages.push.call_args_list
        assert calls[0][1]["event_type"] == "assistant"
        assert calls[1][1]["event_type"] == "error"


# ---------------------------------------------------------------------------
# _synthesize_run_error — standalone helper
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestSynthesizeRunError:
    async def test_feeds_run_error_event_to_sse_queue(self):
        """_synthesize_run_error must put a RUN_ERROR event into the SSE tap queue."""
        tap_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        active_streams = {"t-synth": tap_queue}

        client = MagicMock()
        client.session_messages.push.return_value = MagicMock(seq=1)
        writer = GRPCMessageWriter(session_id="s-1", run_id="r-1", grpc_client=client)

        _synthesize_run_error("t-synth", "test error", active_streams, writer)

        await asyncio.sleep(0.1)

        assert not tap_queue.empty()
        ev = tap_queue.get_nowait()
        raw = getattr(ev, "type", None)
        ev_str = raw.value if hasattr(raw, "value") else str(raw)
        assert "RUN_ERROR" in ev_str

    async def test_no_sse_queue_does_not_raise(self):
        """When no SSE queue is registered, _synthesize_run_error must not raise."""
        active_streams: dict = {}

        client = MagicMock()
        client.session_messages.push.return_value = MagicMock(seq=1)
        writer = GRPCMessageWriter(session_id="s-1", run_id="r-1", grpc_client=client)

        _synthesize_run_error("t-missing", "test error", active_streams, writer)
        await asyncio.sleep(0.1)

    async def test_schedules_writer_error_persist(self):
        """_synthesize_run_error must schedule writer.push_error()."""
        tap_queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        active_streams = {"t-wr": tap_queue}

        client = MagicMock()
        client.session_messages.push.return_value = MagicMock(seq=1)
        writer = GRPCMessageWriter(session_id="s-1", run_id="r-1", grpc_client=client)

        push_error_calls = []
        original_push_error = writer.push_error

        async def tracking_push_error(msg):
            push_error_calls.append(msg)
            return await original_push_error(msg)

        writer.push_error = tracking_push_error

        _synthesize_run_error("t-wr", "boom", active_streams, writer)
        await asyncio.sleep(0.2)

        assert "boom" in push_error_calls
