import test from "node:test";
import assert from "node:assert/strict";
import { extractMentionHandles, isDelegatedToTarget, normalizeMentionHandle } from "./addressability.js";

test("normalizeMentionHandle strips leading at-sign", () => {
  assert.equal(normalizeMentionHandle("@personal-openclaw"), "personal-openclaw");
});

test("extractMentionHandles collects multiple handles", () => {
  assert.deepEqual(
    [...extractMentionHandles("@alpha please defer to @beta")].sort(),
    ["alpha", "beta"],
  );
});

test("isDelegatedToTarget matches by viewer id", () => {
  assert.equal(isDelegatedToTarget("viewer_1", "other", "viewer_1", "bot"), true);
});

test("isDelegatedToTarget matches by mention handle", () => {
  assert.equal(isDelegatedToTarget("", "personal-openclaw", "", "@personal-openclaw"), true);
});

test("isDelegatedToTarget rejects different bot handles", () => {
  assert.equal(isDelegatedToTarget("", "other-bot", "", "@personal-openclaw"), false);
});
