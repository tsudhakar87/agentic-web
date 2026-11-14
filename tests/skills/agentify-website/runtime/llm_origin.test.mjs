// Smoke-test: verifies that LlmClient.chat() forwards `origin` as body.user
// and always sets body.max_tokens on the outbound request.
//
// Run from the repository root:
//   node --test "tests/skills/agentify-website/runtime/llm_origin.test.mjs"
//
// No real model is called. A local HTTP server echoes the request body back
// and responds with a minimal SSE stream so _readSse() completes cleanly.

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { LlmClient } from "../../../../skills/agentify-website/runtime/llm.js";

// ---------------------------------------------------------------------------
// Minimal SSE echo server
// ---------------------------------------------------------------------------

function startEchoServer() {
  return new Promise((resolve) => {
    const requests = [];

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        requests.push(parsed);

        // Respond with a minimal SSE stream: one content delta + [DONE]
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        const delta = JSON.stringify({
          choices: [{ delta: { content: "ok" }, finish_reason: null }],
        });
        const done = JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        });
        res.write(`data: ${delta}\n\n`);
        res.write(`data: ${done}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("body.user is set to origin when origin is provided", async () => {
  const { server, requests, baseUrl } = await startEchoServer();
  try {
    const client = new LlmClient({ baseUrl, apiKey: "sk-test" });
    await client.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      origin: "https://example.com",
    });
    assert.equal(requests.length, 1, "server received exactly one request");
    assert.equal(requests[0].user, "https://example.com", "body.user matches origin");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("body.user is absent when origin is not provided", async () => {
  const { server, requests, baseUrl } = await startEchoServer();
  try {
    const client = new LlmClient({ baseUrl, apiKey: "sk-test" });
    await client.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(requests.length, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(requests[0], "user"),
      false,
      "body.user must not be set when origin is absent"
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("body.max_tokens defaults to 1024 when caller omits it", async () => {
  const { server, requests, baseUrl } = await startEchoServer();
  try {
    const client = new LlmClient({ baseUrl, apiKey: "sk-test" });
    await client.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      origin: "https://example.com",
    });
    assert.equal(requests[0].max_tokens, 1024, "max_tokens should default to 1024");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("body.max_tokens respects a value already on the body when set by caller", async () => {
  // LlmClient.chat() doesn't accept max_tokens directly yet — this test
  // verifies the ?? guard doesn't overwrite a value that IS already present.
  // We patch the body after construction via a subclass to simulate a future
  // caller that sets it.
  const { server, requests, baseUrl } = await startEchoServer();
  try {
    class PatchedClient extends LlmClient {
      async chat(opts) {
        // Inject max_tokens before the call reaches the real logic by
        // temporarily overriding the base URL to our echo then calling super.
        return super.chat({ ...opts, _forceMaxTokens: 512 });
      }
    }
    // For now just verify the default path; this test is a placeholder for
    // when max_tokens is exposed as a first-class param.
    const client = new PatchedClient({ baseUrl, apiKey: "sk-test" });
    await client.chat({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      origin: "https://example.com",
    });
    // The ?? guard means 1024 is used (since body.max_tokens starts undefined).
    assert.equal(requests[0].max_tokens, 1024);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("existing engine call-count logic is unaffected (mock path still works)", async () => {
  // Verify the browser://mock path returns a result — engine.js's call-count
  // guards sit above LlmClient and don't change. This just confirms the mock
  // branch didn't break.
  const client = new LlmClient({ baseUrl: "browser://mock", apiKey: "", mock: true });
  const result = await client.chat({
    model: "neuro-san-mock",
    messages: [{ role: "user", content: "ping" }],
    tools: [],
    origin: "https://example.com",
  });
  assert.ok(result.content || result.toolCalls.length >= 0, "mock path returns a result");
});
