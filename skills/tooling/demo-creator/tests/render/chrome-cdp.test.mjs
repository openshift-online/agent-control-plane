import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CdpConnection, headlessBrowserArgs, localResourceAllowed, withHeadlessPage } from "../../scripts/render/chrome-cdp.mjs";
import { resolveChrome } from "../../scripts/render/common.mjs";

class FakeSocket extends EventTarget {
  readyState = 0;
  sent = [];

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  receive(message) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

test("CDP commands reject errors, time out, and reject on disconnect", async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection("ws://test", { commandTimeoutMs: 2_000, socketFactory: () => socket });
  socket.open();

  const errored = assert.rejects(connection.send("Runtime.evaluate"), /evaluation failed/);
  await new Promise((resolve) => setImmediate(resolve));
  socket.receive({ id: socket.sent.at(-1).id, error: { message: "evaluation failed" } });
  await errored;

  const timeoutSocket = new FakeSocket();
  const timeoutConnection = new CdpConnection("ws://timeout", {
    commandTimeoutMs: 20,
    socketFactory: () => timeoutSocket,
  });
  timeoutSocket.open();
  await assert.rejects(timeoutConnection.send("Page.captureScreenshot"), /command timed out/);

  const disconnected = assert.rejects(connection.send("Runtime.enable"), /connection closed/);
  await new Promise((resolve) => setImmediate(resolve));
  socket.close();
  await disconnected;
});

test("CDP connection rejects immediately when the socket closes before opening", async () => {
  const socket = new FakeSocket();
  const connection = new CdpConnection("ws://test", { commandTimeoutMs: 2_000, socketFactory: () => socket });
  const pending = connection.send("Runtime.enable");
  socket.close();
  await assert.rejects(pending, /connection closed/);
});

test("resource policy permits data and explicit local paths only", () => {
  assert.equal(localResourceAllowed("data:text/plain,hello"), true);
  assert.equal(localResourceAllowed("file:///tmp/demo/slides.html", ["/tmp/demo/slides.html"]), true);
  assert.equal(localResourceAllowed("file:///tmp/demo/secret.txt", ["/tmp/demo/slides.html"]), false);
  assert.equal(localResourceAllowed("http://127.0.0.1:8080/asset.png", ["/tmp/demo"]), false);
  assert.equal(localResourceAllowed("https://example.test/asset.png", ["/tmp/demo"]), false);
});

test("headless renderer uses the mock keychain without disabling the sandbox", () => {
  const args = headlessBrowserArgs("/tmp/demo-profile");
  assert.ok(args.includes("--use-mock-keychain"));
  assert.ok(args.includes("--password-store=basic"));
  assert.equal(args.includes("--no-sandbox"), false);
});

const browserPath = process.env.DEMO_RENDER_SMOKE === "1" ? await resolveChrome() : null;

test("live renderer blocks dynamic loopback requests before they reach the server", { skip: !browserPath }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "demo-loopback-block-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("should not be reached");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const htmlPath = join(root, "slides.html");
  await writeFile(htmlPath, `<html><body><script>fetch('http://127.0.0.1:${address.port}/dynamic')</script></body></html>`);

  await assert.rejects(
    withHeadlessPage({
      width: 640,
      height: 360,
      browserPath,
      allowedFilePaths: [htmlPath],
    }, (page) => page.navigate(htmlPath)),
    /blocked non-local resource/,
  );
  assert.equal(requests, 0);
});
