import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()


def _build_message_id() -> str:
    return f"msg_mock-{uuid.uuid4()}"


def _extract_last_user_message(messages: list[dict]) -> str:
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                for block in reversed(content):
                    if isinstance(block, dict) and block.get("type") == "text":
                        return block.get("text", "")
            return str(content)
    return ""


def _build_response_text(last_user_message: str) -> str:
    return f"Mock LLM response: {last_user_message}"


@app.get("/health")
async def health():
    return JSONResponse(content={"status": "ok"})


@app.post("/v1/messages")
async def messages(request: Request):
    body = await request.json()

    model = body.get("model", "mock-model")
    msgs = body.get("messages", [])
    stream = body.get("stream", False)

    last_user_message = _extract_last_user_message(msgs)
    response_text = _build_response_text(last_user_message)
    msg_id = _build_message_id()

    if stream:
        return StreamingResponse(
            _stream_events(msg_id, model, response_text),
            media_type="text/event-stream",
        )

    return JSONResponse(content={
        "id": msg_id,
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": response_text}],
        "model": model,
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 0, "output_tokens": 0},
    })


async def _stream_events(msg_id: str, model: str, text: str):
    import json

    events = [
        ("message_start", {
            "type": "message_start",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": model,
                "stop_reason": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        }),
        ("content_block_start", {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        }),
        ("content_block_delta", {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": text},
        }),
        ("content_block_stop", {
            "type": "content_block_stop",
            "index": 0,
        }),
        ("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 0},
        }),
        ("message_stop", {
            "type": "message_stop",
        }),
    ]

    for event_type, data in events:
        yield f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
