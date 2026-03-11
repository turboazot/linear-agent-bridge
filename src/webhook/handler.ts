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
