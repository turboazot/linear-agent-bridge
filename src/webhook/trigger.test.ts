import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrigger } from "./trigger.js";

test("normalizeTrigger detects agent session created events", () => {
  const trigger = normalizeTrigger({
    type: "AgentSessionEvent",
    action: "created",
    agentSessionId: "sess_123",
  });
  assert.deepEqual(trigger && { source: trigger.source, action: trigger.action }, {
    source: "session",
    action: "created",
  });
});

test("normalizeTrigger treats comment create as prompted fallback", () => {
  const trigger = normalizeTrigger({
    type: "Comment",
    action: "created",
    comment: { id: "c1" },
  });
  assert.deepEqual(trigger && { source: trigger.source, action: trigger.action }, {
    source: "comment",
    action: "prompted",
  });
});

test("normalizeTrigger detects delegated notifications", () => {
  const trigger = normalizeTrigger({
    type: "AppUserNotification",
    notificationType: "issueAssignedToYou",
  });
  assert.deepEqual(trigger && { source: trigger.source, action: trigger.action }, {
    source: "delegation",
    action: "created",
  });
});

test("normalizeTrigger rejects unrelated webhook kinds", () => {
  assert.equal(normalizeTrigger({ type: "Issue", action: "updated" }), null);
});
