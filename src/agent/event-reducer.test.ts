import test from "node:test";
import assert from "node:assert/strict";
import { AgentEventReducer } from "./event-reducer.js";
import type { AgentEventPayload } from "../types.js";

function evt(
  stream: AgentEventPayload["stream"],
  data: Record<string, unknown>,
): AgentEventPayload {
  return {
    runId: "run_1",
    seq: 1,
    stream,
    ts: Date.now(),
    data,
    sessionKey: "agent:test:linear:s1",
  };
}

test("event reducer emits lifecycle start thought once", () => {
  const reducer = new AgentEventReducer("ABC-1 Demo");
  assert.equal(reducer.reduce(evt("lifecycle", { phase: "start" })).length, 1);
  assert.equal(reducer.reduce(evt("lifecycle", { phase: "start" })).length, 0);
});

test("event reducer batches assistant chunks until threshold", () => {
  const reducer = new AgentEventReducer("ABC-1 Demo");
  assert.equal(reducer.reduce(evt("assistant", { delta: "short" })).length, 0);
  const emitted = reducer.reduce(
    evt("assistant", {
      delta:
        " This is a long enough sentence to clear the batching threshold and finish cleanly for the reducer test case. It keeps going so the reducer definitely has more than enough content to emit one chunk immediately.",
    }),
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.type, "thought");
});

test("event reducer suppresses non-mutating successful tool chatter", () => {
  const reducer = new AgentEventReducer("ABC-1 Demo");
  const emitted = reducer.reduce(
    evt("tool", {
      phase: "result",
      name: "read",
      result: "ok",
      isError: false,
    }),
  );
  assert.equal(emitted.length, 0);
});

test("event reducer emits mutating tool results", () => {
  const reducer = new AgentEventReducer("ABC-1 Demo");
  const emitted = reducer.reduce(
    evt("tool", {
      phase: "result",
      name: "edit",
      result: {
        content: [
          {
            type: "text",
            text: "Successfully replaced text in /home/ubuntu/projects/misc/hello-python/README.md.",
          },
        ],
      },
      isError: false,
    }),
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.type, "action");
  assert.equal(emitted[0]?.result, "Updated README.md");
});

test("event reducer suppresses raw json tool payload leakage", () => {
  const reducer = new AgentEventReducer("ABC-1 Demo");
  const emitted = reducer.reduce(
    evt("tool", {
      phase: "result",
      name: "edit",
      result: {
        content: [
          {
            type: "text",
            text: "Successfully replaced text in /tmp/demo/README.md.",
          },
        ],
        details: {
          diff: "@@ ... huge diff ...",
        },
      },
      isError: false,
    }),
  );
  assert.equal(emitted.length, 1);
  assert.match(emitted[0]?.result ?? "", /^Updated /);
  assert.doesNotMatch(emitted[0]?.result ?? "", /content|details|diff/);
});

test("event reducer flushes buffered thought on lifecycle end", () => {
  const reducer = new AgentEventReducer("ABC-1 Demo");
  const immediate = reducer.reduce(
    evt("assistant", {
      delta:
        "Buffered text that should remain pending until lifecycle end because it stays below the immediate flush threshold.",
    }),
  );
  assert.equal(immediate.length, 0);
  const flushed = reducer.reduce(evt("lifecycle", { phase: "end" }));
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.type, "thought");
});
