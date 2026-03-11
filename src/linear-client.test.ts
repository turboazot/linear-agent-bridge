import test from "node:test";
import assert from "node:assert/strict";
import { callLinear } from "./linear-client.js";
import type { OpenClawPluginApi, PluginConfig } from "./types.js";

const api: OpenClawPluginApi = {
  logger: {},
  registerHttpRoute: () => {},
};

const cfg: PluginConfig = {
  linearApiKey: "token",
};

test("callLinear returns structured HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("bad request", { status: 400 })) as typeof fetch;
  try {
    const result = await callLinear(api, cfg, "test", {
      query: "query {}",
      variables: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error ?? "", /bad request/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callLinear returns structured GraphQL errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await callLinear(api, cfg, "test", {
      query: "query {}",
      variables: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /boom/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callLinear returns missing-token failure", async () => {
  const result = await callLinear(api, {
    linearTokenStorePath: "/tmp/linear-agent-bridge-missing-token-store.json",
  }, "test", {
    query: "query {}",
    variables: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing-token");
});
