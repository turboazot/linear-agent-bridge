import test from "node:test";
import assert from "node:assert/strict";
import {
  attachSessionToken,
  clearSessionInflight,
  getDelegationSession,
  getInflightSince,
  isSessionInflight,
  markSessionInflight,
  rememberDelegationSession,
  registerSessionSubscription,
  cleanupRun,
} from "./run-registry.js";
import { createSessionToken, validateSessionToken } from "../agent/session-token.js";

test("run registry tracks inflight sessions", () => {
  markSessionInflight("s1");
  assert.equal(isSessionInflight("s1"), true);
  assert.equal(typeof getInflightSince("s1"), "number");
  clearSessionInflight("s1");
  assert.equal(isSessionInflight("s1"), false);
});

test("run registry remembers delegation session cache", () => {
  rememberDelegationSession("issue-1", "sess-1");
  assert.equal(getDelegationSession("issue-1"), "sess-1");
});

test("cleanupRun revokes tokens and unsubscribes", () => {
  let unsubscribed = false;
  const context = {
    sessionId: "sess-cleanup",
    issueId: "issue",
    issueIdentifier: "ABC-1",
    issueTitle: "Title",
    issueUrl: "https://linear.app",
    teamId: "team",
    apiToken: "",
  };
  const token = createSessionToken(context);
  attachSessionToken({ ...context, apiToken: token });
  registerSessionSubscription("sess-cleanup", () => {
    unsubscribed = true;
  });
  cleanupRun("sess-cleanup");
  assert.equal(unsubscribed, true);
  assert.equal(validateSessionToken(token), null);
});
