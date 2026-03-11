import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  OpenClawPluginApi,
  PluginConfig,
  ActivityContent,
  ActivityOptions,
  Trigger,
} from "../types.js";
import { normalizeCfg } from "../config.js";
import { resolveViewer } from "../linear-client.js";
import {
  readBody,
  readHeader,
  readObject,
  readString,
  normalizeKey,
  sendJson,
} from "../util.js";
import { verifySignature } from "./validation.js";
import {
  resolveSessionId,
  resolveSessionIdWithFallback,
  resolveIssue,
  rememberSessionHint,
} from "./session-resolver.js";
import {
  buildMessage,
} from "./message-builder.js";
import { isSelfAuthoredComment } from "./skip-filter.js";
import { captureBaseUrl } from "../api/base-url.js";
import { normalizePayload, normalizeTrigger } from "./trigger.js";
import { decideAddressability } from "./addressability.js";
import {
  DEDUP_WINDOW_MS,
  getInflightSince,
  isSessionInflight,
  markSessionInflight,
  rememberDelegationSession,
} from "../runtime/run-registry.js";
import {
  postLinearActivity,
} from "../linear-session-service.js";
import { prepareRun } from "./prepare-run.js";
import { createSessionForDelegatedIssue } from "./delegation.js";
import { executePreparedRun } from "./execute-run.js";

const callRef: { value?: (opts: Record<string, unknown>) => Promise<unknown> } = {};

const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_AGENT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 45_000;

export function createLinearWebhook(
  api: OpenClawPluginApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }
    const read = await readBody(req, MAX_BODY);
    if (!read.ok) {
      sendJson(res, read.status, { ok: false, error: read.error });
      return;
    }
    const raw = read.body;
    const cfg = normalizeCfg(api.pluginConfig);
    const secret = cfg.linearWebhookSecret;
    const sig = readHeader(req, "linear-signature");
    const delivery = readHeader(req, "linear-delivery");
    if (secret && !verifySignature(secret, sig, raw)) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    // Capture the host from incoming webhooks for base URL auto-detection
    const host = readHeader(req, "host");
    if (host) captureBaseUrl(host);

    const text = raw.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }
    const data = normalizePayload(parsed);
    let stamp =
      typeof data.webhookTimestamp === "number"
        ? (data.webhookTimestamp as number)
        : undefined;
    if (typeof stamp === "number" && stamp > 0 && stamp < 1e12) {
      stamp = stamp * 1000;
    }
    if (stamp && Math.abs(Date.now() - stamp) > 60_000) {
      res.statusCode = 401;
      res.end("Stale webhook");
      return;
    }
    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
    queueMicrotask(() => {
      handleWebhook(api, cfg, data, delivery).catch((err) => {
        api.logger.warn?.(`linear webhook error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  };
}

async function handleWebhook(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
): Promise<void> {
  const kind = readString(data.type as string) ?? "";
  if (kind === "PermissionChange" || kind === "OAuthApp") {
    logEvent(api, "permission", data);
    return;
  }
  if (kind === "Comment" && (await isSelfAuthoredComment(api, cfg, data))) {
    return;
  }
  const trigger = normalizeTrigger(data);
  if (!trigger) {
    if (kind === "AppUserNotification") {
      logEvent(api, "notification", data);
    } else if (kind) {
      api.logger.info?.(`linear webhook ignored (${kind})`);
    }
    return;
  }

  let sessionId = await resolveSessionIdWithFallback(api, cfg, trigger.payload);
  let delegationSessionCreated = false;
  let delegationIssueId = "";
  if (!sessionId && trigger.source === "delegation") {
    const delegated = await createSessionForDelegatedIssue(
      api,
      cfg,
      trigger.payload,
    );
    if (delegated.sessionId) {
      sessionId = delegated.sessionId;
      delegationSessionCreated = true;
      delegationIssueId = delegated.issueId;
    } else {
      api.logger.info?.(
        `linear delegation bootstrap skipped kind=${kind || "unknown"} reason=${delegated.reason || "-"}`,
      );
    }
  }
  if (!sessionId) {
    if (kind) {
      if (kind === "Comment") {
        const topKeys = Object.keys(data).join(",");
        const nested = readObject(data.data);
        const nestedKeys = nested ? Object.keys(nested).join(",") : "";
        api.logger.info?.(
          `linear webhook ignored (${kind}) keys=[${topKeys}] dataKeys=[${nestedKeys}]`,
        );
      } else {
        api.logger.info?.(`linear webhook ignored (${kind})`);
      }
    }
    return;
  }
  const eventData: Record<string, unknown> = resolveSessionId(trigger.payload)
    ? { ...trigger.payload }
    : { ...trigger.payload, agentSessionId: sessionId };
  if (delegationIssueId && !readString(eventData.issueId as string) && !readObject(eventData.issue)) {
    eventData.issueId = delegationIssueId;
  }
  if (delegationSessionCreated) {
    eventData.__delegationSessionCreated = true;
  }
  rememberSessionHint(eventData, sessionId);
  const eventIssueId =
    readString(resolveIssue(eventData)?.id) ??
    readString(eventData.issueId as string) ??
    "";
  if (eventIssueId && sessionId) {
    rememberDelegationSession(eventIssueId, sessionId);
  }
  await handleAgentEvent(api, cfg, { ...trigger, payload: eventData }, delivery);
}

async function handleAgentEvent(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  trigger: Trigger,
  delivery: string | undefined,
): Promise<void> {
  const data = trigger.payload;
  const kind = readString(data.type as string) ?? "";
  const prompt = readString(readObject(data.agentActivity)?.body) ??
    readString(readObject(readObject(data.agentActivity)?.content)?.body) ??
    readString(readObject(data.comment)?.body) ??
    readString(data.body as string) ??
    readString(data.message as string) ??
    "";
  const viewerId = await resolveViewer(api, cfg);
  const addressed = await decideAddressability({
    api,
    cfg,
    kind,
    action: trigger.action,
    data,
    prompt,
    viewerId,
    mentionHandle: cfg.mentionHandle,
  });
  if (!addressed.ok) {
    api.logger.info?.(`linear event ignored (strictAddressing: ${addressed.reason})`);
    return;
  }

  const session = resolveSessionId(data);
  if (!session) return;
  const prepared = await prepareRun(api, cfg, trigger, session, delivery);
  if (!prepared) return;

  // Dedup: skip if an agent is already running for this session.
  if (isSessionInflight(session)) {
    const elapsed = Date.now() - (getInflightSince(session) ?? Date.now());
    if (trigger.action !== "prompted" || elapsed < DEDUP_WINDOW_MS) {
      api.logger.info?.(`linear handler: skipping duplicate for session ${session.slice(0, 8)}... (action=${trigger.action}, elapsed=${elapsed}ms)`);
      return;
    }
  }
  markSessionInflight(session);

  try {
    await executePreparedRun({
      api,
      cfg,
      sessionId: session,
      prepared,
      loadCallGateway,
      defaultAgentTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      defaultHeartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn?.(`linear agent run failed: ${msg}`);
    postLinearActivity(api, cfg, session, {
      type: "error",
      body: `Agent run failed: ${msg}`,
    }).catch(() => {});
  }
}

export async function postActivity(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  content: ActivityContent,
  opts: ActivityOptions = {},
): Promise<void> {
  await postLinearActivity(api, cfg, session, content, opts);
}

async function updateSessionExternalUrl(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  url: string,
  label: string,
): Promise<void> {
  if (!session || !url) return;
  const input = { addedExternalUrls: [{ label, url }] };
  const result = await callLinear(api, cfg, "agentSessionUpdate", {
    query: SESSION_UPDATE_MUTATION,
    variables: { id: session, input },
  });
  if (!result.ok) return;
  const root = readObject(result.data!.agentSessionUpdate);
  if (root && root.success === true) return;
  api.logger.warn?.("linear agentSessionUpdate failed");
}

async function isExplicitlyAddressed(input: {
  api: OpenClawPluginApi;
  cfg: PluginConfig;
  kind: string;
  action: string;
  data: Record<string, unknown>;
  prompt: string;
  viewerId: string;
  mentionHandle?: string;
}): Promise<{ ok: boolean; reason: string }> {
  const { api, cfg, kind, action, data, prompt, viewerId, mentionHandle } = input;

  if (action === "created") {
    const issue = resolveIssue(data);
    const delegate = readObject(issue?.delegate);
    const delegateId = readString(delegate?.id) ?? "";
    if (viewerId && delegateId && delegateId === viewerId) {
      return { ok: true, reason: "delegated-to-app" };
    }
    const handle = (mentionHandle ?? "").trim().toLowerCase().replace(/^@/, "");
    const createdMentions = extractMentionHandles((prompt ?? "").toLowerCase());
    if (handle && createdMentions.has(handle)) {
      return { ok: true, reason: "explicit-mention-on-create" };
    }
    return { ok: false, reason: "created-without-delegation" };
  }

  const comment = readObject(data.comment);
  const bodyRaw = `${prompt}
${readString(comment?.body) ?? ""}`;
  const body = bodyRaw.toLowerCase();
  const handle = (mentionHandle ?? "").trim().toLowerCase().replace(/^@/, "");
  const mentionedHandles = extractMentionHandles(body);

  if (mentionedHandles.size > 0 && handle && !mentionedHandles.has(handle)) {
    return { ok: false, reason: "mentioned-other-bot" };
  }

  if (handle && mentionedHandles.has(handle)) {
    return { ok: true, reason: "explicit-mention" };
  }

  const parentId = readString(comment?.parentId) ?? readString(data.parentId as string) ?? "";
  const commentId = readString(comment?.id) ?? readString(data.commentId as string) ?? "";
  if (kind === "Comment" && parentId) {
    const ownerHandle = await resolveThreadOwnerHandle(api, cfg, commentId, handle);
    if (ownerHandle) {
      if (handle && ownerHandle === handle) {
        return { ok: true, reason: "thread-owned-by-us" };
      }
      return { ok: false, reason: `thread-owned-by-${ownerHandle}` };
    }
    return { ok: false, reason: "thread-owner-unknown" };
  }

  return { ok: false, reason: "not-addressed" };
}

function extractMentionHandles(text: string): Set<string> {
  const matches = Array.from((text ?? "").matchAll(/@([a-z0-9._-]+)/gi));
  return new Set(matches.map((m) => (m[1] ?? "").toLowerCase()).filter(Boolean));
}

function pickThreadOwnerHandle(handles: Set<string>, expectedHandle?: string): string {
  const expected = (expectedHandle ?? "").trim().toLowerCase().replace(/^@/, "");
  if (expected && handles.has(expected)) return expected;
  return handles.values().next().value ?? "";
}

async function resolveThreadOwnerHandle(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  commentId: string,
  expectedHandle?: string,
): Promise<string> {
  if (!commentId) return "";
  const { COMMENT_THREAD_NODE_QUERY } = await import("../graphql/queries.js");

  let currentId = commentId;
  let safety = 0;
  while (currentId && safety < 12) {
    safety += 1;
    const result = await callLinear(api, cfg, "commentThreadNode", {
      query: COMMENT_THREAD_NODE_QUERY,
      variables: { id: currentId },
    });
    if (!result.ok) return "";
    const node = readObject(result.data?.comment);
    if (!node) return "";

    const parentId = readString(node.parentId) ?? "";
    const body = readString(node.body) ?? "";

    if (!parentId) {
      const handles = extractMentionHandles(body.toLowerCase());
      return pickThreadOwnerHandle(handles, expectedHandle);
    }

    const parent = readObject(node.parent);
    const parentObjId = readString(parent?.id) ?? "";
    const parentObjParentId = readString(parent?.parentId) ?? "";
    if (parent && parentObjId && !parentObjParentId) {
      const rootBody = readString(parent.body) ?? "";
      const handles = extractMentionHandles(rootBody.toLowerCase());
      return pickThreadOwnerHandle(handles, expectedHandle);
    }

    currentId = parentObjId || parentId;
  }
  return "";
}

function normalizePayload(
  input: unknown,
): Record<string, unknown> {
  const root = readObject(input);
  if (!root) return {};
  const nested = readObject(root.data);
  if (!nested) return root;
  const out: Record<string, unknown> = { ...root, ...nested };
  const kind = readString(out.type as string) ?? "";
  if (kind === "Comment" && !readObject(out.comment)) out.comment = nested;
  if (kind === "Issue" && !readObject(out.issue)) out.issue = nested;
  return out;
}

function logEvent(
  api: OpenClawPluginApi,
  label: string,
  data: Record<string, unknown>,
): void {
  const action = readString(data.action as string) ?? "";
  const name = action ? `${label} ${action}` : label;
  api.logger.info?.(`linear ${name}`);
}

async function loadCallGateway(
  api: OpenClawPluginApi,
): Promise<(opts: Record<string, unknown>) => Promise<unknown>> {
  if (callRef.value) return callRef.value;
  if (api.callGateway && typeof api.callGateway === "function") {
    callRef.value = api.callGateway as (opts: Record<string, unknown>) => Promise<unknown>;
    return callRef.value;
  }
  try {
    const argv1 =
      typeof process?.argv?.[1] === "string" ? process.argv[1] : "";
    const distDir = argv1 ? path.dirname(argv1) : "";
    if (distDir && fs.existsSync(distDir)) {
      const files = fs
        .readdirSync(distDir)
        .filter(
          (name) => name.startsWith("call-") && name.endsWith(".js"),
        )
        // Prefer call-D* over call--* because call--* imports entry.js
        // which has a module-level side effect that calls runCli(), causing
        // a second gateway start and a GatewayLockError crash.
        .sort((a, b) =>
          a.startsWith("call--") === b.startsWith("call--")
            ? 0
            : a.startsWith("call--")
              ? 1
              : -1,
        );
      for (const file of files) {
        try {
          const mod = await import(
            pathToFileURL(path.join(distDir, file)).href
          );
          const fn =
            (mod?.n as ((...args: unknown[]) => unknown) | undefined) ??
            (mod?.callGateway as ((...args: unknown[]) => unknown) | undefined);
          if (typeof fn === "function") {
            const auth = api.config?.gateway?.auth ?? {};
            const token =
              typeof auth.token === "string"
                ? auth.token.trim()
                : undefined;
            const password =
              typeof auth.password === "string"
                ? auth.password.trim()
                : undefined;
            const call = (opts: Record<string, unknown>) =>
              fn({
                ...opts,
                token: (opts?.token as string | undefined) ?? token,
                password:
                  (opts?.password as string | undefined) ?? password,
              });
            callRef.value = call as (opts: Record<string, unknown>) => Promise<unknown>;
            return callRef.value;
          }
        } catch (err) {
          api.logger?.debug?.(
            `linear: callGateway import failed (${file}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    api.logger?.warn?.(
      `linear: failed to locate gateway callGateway: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error(
    "callGateway not available. Ensure the plugin is running inside an OpenClaw gateway process.",
  );
}
