import { registerApiHandler } from "./router.js";
import type { PlanStep } from "../types.js";
import { setPlan } from "../agent/plan-manager.js";
import { readObject, readString, readArray, sendJson } from "../util.js";
import {
  createLinearSessionOnComment,
  createLinearSessionOnIssue,
  updateLinearSessionExternalUrl,
  updateLinearSessionPlan,
} from "../linear-session-service.js";

// POST /session/plan
registerApiHandler("/session/plan", async ({ api, cfg, context, body, res }) => {
  const rawPlan = readArray(body.plan);
  if (rawPlan.length === 0) {
    sendJson(res, 400, { ok: false, error: "plan array is required" });
    return;
  }

  const plan: PlanStep[] = rawPlan.map((item) => {
    const obj = readObject(item);
    return {
      content: readString(obj?.content) ?? "",
      status: (readString(obj?.status) ?? "pending") as PlanStep["status"],
    };
  });

  setPlan(context.sessionId, plan);

  const ok = await updateLinearSessionPlan(api, cfg, context.sessionId, plan);
  if (!ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, { ok: true });
});

// POST /session/create-on-issue
registerApiHandler("/session/create-on-issue", async ({ api, cfg, body, res }) => {
  const issueId = readString(body.issueId as string);
  if (!issueId) {
    sendJson(res, 400, { ok: false, error: "issueId is required" });
    return;
  }

  const sessionId = await createLinearSessionOnIssue(api, cfg, issueId);
  if (!sessionId) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    sessionId,
  });
});

// POST /session/create-on-comment
registerApiHandler("/session/create-on-comment", async ({ api, cfg, body, res }) => {
  const commentId = readString(body.commentId as string);
  if (!commentId) {
    sendJson(res, 400, { ok: false, error: "commentId is required" });
    return;
  }

  const sessionId = await createLinearSessionOnComment(api, cfg, commentId);
  if (!sessionId) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    sessionId,
  });
});

// POST /session/external-url
registerApiHandler("/session/external-url", async ({ api, cfg, context, body, res }) => {
  const url = readString(body.url as string);
  const label = readString(body.label as string) ?? "Link";
  if (!url) {
    sendJson(res, 400, { ok: false, error: "url is required" });
    return;
  }

  const ok = await updateLinearSessionExternalUrl(api, cfg, context.sessionId, url, label);
  if (!ok) {
    sendJson(res, 502, { ok: false, error: "Linear API error" });
    return;
  }
  sendJson(res, 200, { ok: true });
});
