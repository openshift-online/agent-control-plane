import json


from ag_ui.core import (
    EventType,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)

from ambient_runner.middleware.event_compressor import CompressedEvent, EventCompressor


def _run_started() -> RunStartedEvent:
    return RunStartedEvent(type=EventType.RUN_STARTED, thread_id="t-1", run_id="r-1")


def _run_finished() -> RunFinishedEvent:
    return RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="t-1", run_id="r-1")


def _text_start(msg_id: str = "m-1") -> TextMessageStartEvent:
    return TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START, message_id=msg_id, role="assistant"
    )


def _text_content(msg_id: str = "m-1", delta: str = "Hello") -> TextMessageContentEvent:
    return TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT, message_id=msg_id, delta=delta
    )


def _text_end(msg_id: str = "m-1") -> TextMessageEndEvent:
    return TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=msg_id)


def _tool_start(tool_id: str = "tc-1", name: str = "Read") -> ToolCallStartEvent:
    return ToolCallStartEvent(
        type=EventType.TOOL_CALL_START, tool_call_id=tool_id, tool_call_name=name
    )


def _tool_args(tool_id: str = "tc-1", delta: str = '{"file":"x"}') -> ToolCallArgsEvent:
    return ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS, tool_call_id=tool_id, delta=delta
    )


def _tool_end(tool_id: str = "tc-1") -> ToolCallEndEvent:
    return ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool_id)


def _reasoning_start(msg_id: str = "rm-1") -> ReasoningMessageStartEvent:
    return ReasoningMessageStartEvent(
        type=EventType.REASONING_MESSAGE_START, message_id=msg_id, role="reasoning"
    )


def _reasoning_content(
    msg_id: str = "rm-1", delta: str = "thinking"
) -> ReasoningMessageContentEvent:
    return ReasoningMessageContentEvent(
        type=EventType.REASONING_MESSAGE_CONTENT, message_id=msg_id, delta=delta
    )


def _reasoning_end(msg_id: str = "rm-1") -> ReasoningMessageEndEvent:
    return ReasoningMessageEndEvent(
        type=EventType.REASONING_MESSAGE_END, message_id=msg_id
    )


class TestTextMessageCompression:
    def test_start_content_end_produces_single_compressed_event(self):
        c = EventCompressor()
        assert c.feed(_text_start()) == []
        assert c.feed(_text_content(delta="Hello ")) == []
        assert c.feed(_text_content(delta="world")) == []
        results = c.feed(_text_end())

        assert len(results) == 1
        ce = results[0]
        assert ce.event_type == "TEXT_MESSAGE_START"
        assert ce.event_count == 4
        assert ce.completed_at is not None

        payload = json.loads(ce.payload)
        assert payload["accumulated_content"] == "Hello world"
        assert payload["fragment_count"] == 2
        assert "end_event" in payload

    def test_start_with_no_content_then_end(self):
        c = EventCompressor()
        assert c.feed(_text_start()) == []
        results = c.feed(_text_end())

        assert len(results) == 1
        ce = results[0]
        assert ce.event_count == 2
        payload = json.loads(ce.payload)
        assert payload["fragment_count"] == 0
        assert "accumulated_content" not in payload

    def test_single_content_fragment(self):
        c = EventCompressor()
        c.feed(_text_start())
        c.feed(_text_content(delta="only"))
        results = c.feed(_text_end())

        assert len(results) == 1
        payload = json.loads(results[0].payload)
        assert payload["accumulated_content"] == "only"
        assert payload["fragment_count"] == 1


class TestToolCallCompression:
    def test_tool_call_start_args_end(self):
        c = EventCompressor()
        assert c.feed(_tool_start()) == []
        assert c.feed(_tool_args(delta='{"path":')) == []
        assert c.feed(_tool_args(delta='"/tmp"}')) == []
        results = c.feed(_tool_end())

        assert len(results) == 1
        ce = results[0]
        assert ce.event_type == "TOOL_CALL_START"
        assert ce.event_count == 4
        payload = json.loads(ce.payload)
        assert payload["accumulated_content"] == '{"path":"/tmp"}'
        assert payload["fragment_count"] == 2


class TestReasoningMessageCompression:
    def test_reasoning_start_content_end(self):
        c = EventCompressor()
        assert c.feed(_reasoning_start()) == []
        assert c.feed(_reasoning_content(delta="step 1 ")) == []
        assert c.feed(_reasoning_content(delta="step 2")) == []
        results = c.feed(_reasoning_end())

        assert len(results) == 1
        ce = results[0]
        assert ce.event_type == "REASONING_MESSAGE_START"
        assert ce.event_count == 4
        payload = json.loads(ce.payload)
        assert payload["accumulated_content"] == "step 1 step 2"


class TestStandaloneEvents:
    def test_run_started_passes_through(self):
        c = EventCompressor()
        results = c.feed(_run_started())

        assert len(results) == 1
        ce = results[0]
        assert ce.event_type == "RUN_STARTED"
        assert ce.event_count == 1
        assert ce.completed_at is None

    def test_run_finished_passes_through(self):
        c = EventCompressor()
        results = c.feed(_run_finished())

        assert len(results) == 1
        assert results[0].event_type == "RUN_FINISHED"
        assert results[0].event_count == 1


class TestFlush:
    def test_flush_empty_returns_nothing(self):
        c = EventCompressor()
        assert c.flush() == []

    def test_flush_incomplete_accumulation(self):
        c = EventCompressor()
        c.feed(_text_start())
        c.feed(_text_content(delta="partial"))
        results = c.flush()

        assert len(results) == 1
        ce = results[0]
        assert ce.event_type == "TEXT_MESSAGE_START"
        assert ce.event_count == 2
        assert ce.completed_at is not None
        payload = json.loads(ce.payload)
        assert payload["accumulated_content"] == "partial"
        assert payload["fragment_count"] == 1

    def test_flush_after_complete_returns_nothing(self):
        c = EventCompressor()
        c.feed(_text_start())
        c.feed(_text_end())
        assert c.flush() == []

    def test_flush_start_only(self):
        c = EventCompressor()
        c.feed(_text_start())
        results = c.flush()

        assert len(results) == 1
        assert results[0].event_count == 1


class TestInterruptedAccumulation:
    def test_new_start_flushes_previous(self):
        c = EventCompressor()
        c.feed(_text_start(msg_id="m-1"))
        c.feed(_text_content(msg_id="m-1", delta="first"))

        results = c.feed(_tool_start(tool_id="tc-1"))

        assert len(results) == 1
        ce = results[0]
        assert ce.event_type == "TEXT_MESSAGE_START"
        assert ce.event_count == 2
        payload = json.loads(ce.payload)
        assert payload["accumulated_content"] == "first"

    def test_standalone_event_during_accumulation_flushes(self):
        c = EventCompressor()
        c.feed(_text_start())
        c.feed(_text_content(delta="abc"))

        results = c.feed(_run_finished())

        assert len(results) == 2
        assert results[0].event_type == "TEXT_MESSAGE_START"
        assert results[1].event_type == "RUN_FINISHED"
        assert results[1].event_count == 1


class TestEmptyStream:
    def test_no_events(self):
        c = EventCompressor()
        assert c.flush() == []


class TestMultipleGroups:
    def test_sequential_text_and_tool(self):
        c = EventCompressor()
        all_results: list[CompressedEvent] = []

        c.feed(_text_start())
        c.feed(_text_content(delta="hello"))
        all_results.extend(c.feed(_text_end()))

        c.feed(_tool_start())
        c.feed(_tool_args(delta="args"))
        all_results.extend(c.feed(_tool_end()))

        assert len(all_results) == 2
        assert all_results[0].event_type == "TEXT_MESSAGE_START"
        assert all_results[1].event_type == "TOOL_CALL_START"

    def test_interleaved_standalone_between_groups(self):
        c = EventCompressor()
        all_results: list[CompressedEvent] = []

        all_results.extend(c.feed(_run_started()))
        c.feed(_text_start())
        c.feed(_text_content(delta="hi"))
        all_results.extend(c.feed(_text_end()))
        all_results.extend(c.feed(_run_finished()))

        assert len(all_results) == 3
        assert all_results[0].event_type == "RUN_STARTED"
        assert all_results[1].event_type == "TEXT_MESSAGE_START"
        assert all_results[2].event_type == "RUN_FINISHED"


class TestMismatchedFragments:
    def test_wrong_fragment_type_flushes_accumulator(self):
        c = EventCompressor()
        c.feed(_text_start())
        results = c.feed(_tool_args(delta="wrong"))

        assert len(results) == 2
        assert results[0].event_type == "TEXT_MESSAGE_START"
        assert results[1].event_type == "TOOL_CALL_ARGS"
