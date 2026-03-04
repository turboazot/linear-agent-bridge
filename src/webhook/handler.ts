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
} from "../types.js";
import { normalizeCfg } from "../config.js";
import { callLinear, resolveViewer } from "../linear-client.js";
import {
  ACTIVITY_MUTATION,
  SESSION_UPDATE_MUTATION,
  AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
} from "../graphql/mutations.js";
import { ISSUE_DETAIL_QUERY } from "../graphql/queries.js";
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
  resolveKnownSessionForIssue,
  resolveIssue,
  rememberSessionHint,
} from "./session-resolver.js";
import {
  buildMessage,
  buildLabel,
  buildThought,
  buildStopText,
  resolveAction,
  resolvePrompt,
  resolveSignal,
  resolveContext,
  resolveKey,
  resolveRepo,
  resolveExternal,
} from "./message-builder.js";
import { buildAgentResponse } from "./response-parser.js";
import { applyIssuePolicy, resolveIssueInfo } from "./issue-policy.js";
import { isCloseIntentPrompt, closeIssueFromPrompt } from "./close-intent.js";
import { shouldSkipPromptedRun, isSelfAuthoredComment } from "./skip-filter.js";
import { createSessionToken, revokeSessionToken } from "../agent/session-token.js";
import { buildEnrichedMessage } from "../agent/context-builder.js";
import { cleanupSession } from "../agent/plan-manager.js";
import { hasPostedResponse, clearResponseFlag } from "../agent/response-tracker.js";
import { captureBaseUrl } from "../api/base-url.js";

const callRef: { value?: (opts: Record<string, unknown>) => Promise<unknown> } = {};

const MAX_BODY = 2 * 1024 * 1024;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

// Guard against duplicate agent runs for the same session.
// Linear sends both an AgentSessionEvent and a Comment webhook for the
// same interaction; without dedup both trigger an agent run.
// Maps session ID → timestamp when marked inflight.
const inflightSessions = new Map<string, number>();
const DEDUP_WINDOW_MS = 5_000;
const delegationByIssue = new Map<string, { sessionId: string; at: number }>();
const initializedSessions = new Set<string>();

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
  const rawAction = (readString(data.action as string) ?? "").trim().toLowerCase();
  const notificationType = (
    readString(data.notificationType as string) ??
    readString(readObject(data.notification)?.type) ??
    ""
  )
    .trim()
    .toLowerCase();
  if (kind === "PermissionChange" || kind === "OAuthApp") {
    logEvent(api, "permission", data);
    return;
  }
  if (kind === "Comment" && (await isSelfAuthoredComment(api, cfg, data))) {
    return;
  }
  const isIssueAssignedNotification =
    kind === "AppUserNotification" &&
    (notificationType === "issueassignedtoyou" ||
      notificationType === "issue_assigned_to_you");
  const isCommentCreated =
    kind === "Comment" &&
    (!rawAction || rawAction === "create" || rawAction === "created" || rawAction === "prompted");

  if (kind === "AppUserNotification") {
    const notification = readObject(data.notification);
    const payload = readObject(data.payload);
    const entity = readObject(data.entity);
    const subject = readObject(data.subject);
    const organization = readObject(data.organization);
    const candidates = [
      readString(readObject(notification?.issue)?.id),
      readString(readObject(payload?.issue)?.id),
      readString(readObject(entity?.issue)?.id),
      readString(readObject(subject?.issue)?.id),
      readString(readObject(organization?.issue)?.id),
      readString(notification?.issueId),
      readString(payload?.issueId),
      readString(entity?.issueId),
      readString(subject?.issueId),
      readString(organization?.issueId),
      readString(data.issueId as string),
      readString(readObject(resolveIssue(data))?.id),
    ].filter(Boolean);
    const topKeys = Object.keys(data).join(",");
    const notificationKeys = notification ? Object.keys(notification).join(",") : "";
    api.logger.info?.(
      `linear app-notification action=${rawAction || "-"} notificationType=${notificationType || "-"} candidates=${candidates.length ? candidates.join("|") : "(none)"} keys=[${topKeys}] notificationKeys=[${notificationKeys}]`,
    );
  }

  // Strict trigger allowlist:
  // 1) issue delegated to app (notification event)
  // 2) comment created
  // 3) thread comment created (covered by Comment + parentId handling later)
  if (!isIssueAssignedNotification && !isCommentCreated) {
    if (kind === "AppUserNotification") {
      logEvent(api, "notification", data);
    } else if (kind) {
      api.logger.info?.(`linear webhook ignored (${kind})`);
    }
    return;
  }

  let sessionId = await resolveSessionIdWithFallback(api, cfg, data);
  let delegationSessionCreated = false;
  let delegationReason = "";
  let delegationIssueId = "";
  if (!sessionId && isIssueAssignedNotification) {
    const requireDelegateChange = false;
    const delegated = await createSessionForDelegatedIssue(
      api,
      cfg,
      data,
      requireDelegateChange,
    );
    if (delegated.sessionId) {
      sessionId = delegated.sessionId;
      delegationSessionCreated = true;
      delegationIssueId = delegated.issueId;
    } else {
      delegationReason = delegated.reason;
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
  const eventData: Record<string, unknown> = resolveSessionId(data)
    ? { ...data }
    : { ...data, agentSessionId: sessionId };
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
    delegationByIssue.set(eventIssueId, { sessionId, at: Date.now() });
  }
  await handleAgentEvent(api, cfg, eventData, delivery);
}

async function handleAgentEvent(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  delivery: string | undefined,
): Promise<void> {
  let action = resolveAction(data);
  if (!action && data.__delegationSessionCreated === true) {
    action = "created";
  }
  if (!action) {
    api.logger.info?.("linear agent event ignored");
    return;
  }
  const kind = readString(data.type as string) ?? "";
  const issue = resolveIssue(data);
  let issueId = readString(issue?.id) ?? "";
  let id = readString(issue?.identifier) ?? "";
  let title = readString(issue?.title) ?? "";
  let url = readString(issue?.url) ?? "";
  let desc = readString(issue?.description) ?? "";
  let issueTeamObj = readObject(issue?.team);
  let teamId = readString(issueTeamObj?.id) ?? "";
  let team = resolveKey(issue?.team);
  let proj = resolveKey(issue?.project);
  const guidance = readString(data.guidance as string) ?? "";
  const prompt = resolvePrompt(data);
  if (action === "prompted") {
    const skipReason = shouldSkipPromptedRun(prompt);
    if (skipReason) {
      api.logger.info?.(
        `linear prompted event ignored (${skipReason})`,
      );
      return;
    }
  }

  const viewerId = await resolveViewer(api, cfg);
  const addressed = await isExplicitlyAddressed({
    api,
    cfg,
    kind,
    action,
    data,
    prompt,
    viewerId,
    mentionHandle: cfg.mentionHandle,
  });
  if (!addressed.ok) {
    api.logger.info?.(`linear event ignored (strictAddressing: ${addressed.reason})`);
    return;
  }

  const context = resolveContext(data);
  const session = resolveSessionId(data);
  const isFirstInSession = session ? !initializedSessions.has(session) : false;
  const compactMessage = session ? !isFirstInSession : action === "prompted";
  if (
    isFirstInSession &&
    issueId &&
    (!id || !title || !url || !desc || !teamId)
  ) {
    const detail = await fetchIssueDetail(api, cfg, issueId);
    if (detail) {
      id ||= detail.identifier;
      title ||= detail.title;
      url ||= detail.url;
      desc ||= detail.description;
      teamId ||= detail.teamId;
      team ||= detail.teamKey || detail.teamId;
      proj ||= detail.projectKey || detail.projectId;
    }
  }
  const repo = resolveRepo(cfg, team, proj);
  const agent = cfg.devAgentId ?? "dev";
  const label = buildLabel(id, title);

  // Dedup: skip if an agent is already running for this session.
  // "prompted" (follow-up comment) actions are allowed through UNLESS
  // the session was just created (within DEDUP_WINDOW_MS), which means
  // this is the redundant Comment webhook that accompanies session creation.
  if (session && inflightSessions.has(session)) {
    const elapsed = Date.now() - inflightSessions.get(session)!;
    if (action !== "prompted" || elapsed < DEDUP_WINDOW_MS) {
      api.logger.info?.(`linear handler: skipping duplicate for session ${session.slice(0, 8)}... (action=${action}, elapsed=${elapsed}ms)`);
      return;
    }
  }
  // Mark in-flight immediately (before any await) to prevent races.
  if (session) inflightSessions.set(session, Date.now());
  if (session) initializedSessions.add(session);

  const key = normalizeKey(session || id || randomUUID());
  const sessionKey = `agent:${agent}:linear:${key}`;
  const idem = delivery ?? randomUUID();
  const signal = resolveSignal(data);
  const deliver = Boolean(cfg.notifyChannel && cfg.notifyTo);

  // Handle stop signal
  if (signal === "stop") {
    if (session) inflightSessions.delete(session);
    const text = buildStopText(id, title);
    postActivity(api, cfg, session, { type: "response", body: text }).catch(() => {});
    return;
  }

  // Post initial "thinking" activity
  const thought = buildThought(action, id, title);
  postActivity(api, cfg, session, { type: "thought", body: thought }, { ephemeral: true }).catch(() => {});

  // Fast-path for explicit close commands
  if (isCloseIntentPrompt(prompt)) {
    if (session) inflightSessions.delete(session);
    const closeText = issueId
      ? await closeIssueFromPrompt(api, cfg, issueId, id, title)
      : "Не удалось определить задачу для закрытия.";
    postActivity(api, cfg, session, { type: "response", body: closeText }).catch(() => {});
    return;
  }

  // Apply issue policies on create
  if (action === "created") {
    const external = resolveExternal(cfg, session, issueId);
    if (external) {
      updateSessionExternalUrl(api, cfg, session, external.url, external.label).catch(() => {});
    }
    applyIssuePolicy(api, cfg, issueId).catch(() => {});
  }

  // Generate per-session API token for agent to call back
  const enableApi = cfg.enableAgentApi !== false;
  api.logger.info?.(`linear handler: enableApi=${enableApi} session=${session ? session.slice(0, 8) + "..." : "(none)"} issueId=${issueId.slice(0, 8) || "(none)"}`);
  let apiToken = "";
  if (enableApi && session) {
    const sessionCtx = {
      sessionId: session,
      issueId,
      issueIdentifier: id,
      issueTitle: title,
      issueUrl: url,
      teamId,
      apiToken: "", // will be set below
    };
    apiToken = createSessionToken(sessionCtx);
    sessionCtx.apiToken = apiToken;
  }

  // Build agent message — enriched with API docs if API is enabled
  let message: string;
  if (enableApi && apiToken) {
    const { getBaseUrl } = await import("../api/base-url.js");
    const apiBaseUrl = cfg.apiBaseUrl || getBaseUrl();
    api.logger.info?.(`linear handler: ENRICHED message, apiBaseUrl=${apiBaseUrl}, tokenLen=${apiToken.length}`);
    message = buildEnrichedMessage({
      action,
      id,
      title,
      url,
      desc,
      guidance,
      prompt,
      repo,
      session,
      context,
      compact: compactMessage,
      apiBaseUrl,
      apiToken,
      issueId,
      teamId,
    });
  } else {
    api.logger.info?.(`linear handler: PLAIN message (no enrichment), enableApi=${enableApi}, apiToken=${apiToken ? "set" : "empty"}`);
    message = buildMessage({
      action,
      id,
      title,
      url,
      desc,
      guidance,
      prompt,
      repo,
      session,
      context,
      compact: compactMessage,
    });
  }

  // Run the agent and post response
  try {
    const call = await loadCallGateway(api);

    const runAgent = (key: string, idemKey: string) =>
      call({
        method: "agent",
        params: {
          message,
          agentId: agent,
          sessionKey: key,
          label,
          idempotencyKey: idemKey,
          deliver,
          channel: cfg.notifyChannel,
          to: cfg.notifyTo,
          accountId: cfg.notifyAccountId,
        },
        expectFinal: true,
        timeoutMs: AGENT_TIMEOUT_MS,
      });

    const handleSuccess = (result: unknown) => {
      if (session) inflightSessions.delete(session);
      if (apiToken) revokeSessionToken(apiToken);
      if (session) cleanupSession(session);

      const text = buildAgentResponse(result);
      if (session && hasPostedResponse(session)) {
        clearResponseFlag(session);
        return;
      }
      if (!text || text === "Agent completed with no reply.") return;
      postActivity(api, cfg, session, { type: "response", body: text }).catch(() => {});
    };

    try {
      const result = await runAgent(sessionKey, idem);
      handleSuccess(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAgentSessionMismatch =
        msg.includes("does not match session key agent") ||
        msg.includes("invalid agent params") && msg.includes("session key agent");

      if (isAgentSessionMismatch) {
        const freshSessionKey = `agent:${agent}:linear:${normalizeKey(randomUUID())}`;
        const retryIdem = randomUUID();
        api.logger.warn?.(`linear agent/session mismatch detected; retrying with fresh session key (${freshSessionKey})`);
        try {
          const retryResult = await runAgent(freshSessionKey, retryIdem);
          handleSuccess(retryResult);
          return;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (session) inflightSessions.delete(session);
          if (apiToken) revokeSessionToken(apiToken);
          if (session) cleanupSession(session);
          if (session) clearResponseFlag(session);
          api.logger.warn?.(`linear agent retry failed: ${retryMsg}`);
          postActivity(api, cfg, session, {
            type: "error",
            body: `Agent run failed: ${retryMsg}`,
          }).catch(() => {});
          return;
        }
      }

      if (session) inflightSessions.delete(session);
      if (apiToken) revokeSessionToken(apiToken);
      if (session) cleanupSession(session);
      if (session) clearResponseFlag(session);
      api.logger.warn?.(`linear agent run failed: ${msg}`);
      postActivity(api, cfg, session, {
        type: "error",
        body: `Agent run failed: ${msg}`,
      }).catch(() => {});
    }
  } catch (err) {
    if (session) inflightSessions.delete(session);
    if (apiToken) revokeSessionToken(apiToken);
    if (session) cleanupSession(session);
    if (session) clearResponseFlag(session);
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn?.(`linear agent run failed: ${msg}`);
    postActivity(api, cfg, session, {
      type: "error",
      body: `Agent run failed: ${msg}`,
    }).catch(() => {});
  }
}

async function fetchIssueDetail(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
): Promise<{
  identifier: string;
  title: string;
  url: string;
  description: string;
  teamId: string;
  teamKey: string;
  projectId: string;
  projectKey: string;
} | null> {
  if (!issueId) return null;
  const result = await callLinear(api, cfg, "issue(detail)", {
    query: ISSUE_DETAIL_QUERY,
    variables: { id: issueId },
  });
  if (!result.ok) return null;
  const issue = readObject(result.data?.issue);
  if (!issue) return null;
  const team = readObject(issue.team);
  const project = readObject(issue.project);
  return {
    identifier: readString(issue.identifier) ?? "",
    title: readString(issue.title) ?? "",
    url: readString(issue.url) ?? "",
    description: readString(issue.description) ?? "",
    teamId: readString(team?.id) ?? "",
    teamKey: readString(team?.key) ?? "",
    projectId: readString(project?.id) ?? "",
    projectKey: readString(project?.key) ?? "",
  };
}

export async function postActivity(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  content: ActivityContent,
  opts: ActivityOptions = {},
): Promise<void> {
  if (!session) return;
  const input: Record<string, unknown> = {
    agentSessionId: session,
    content,
  };
  if (opts.signal) input.signal = opts.signal;
  if (opts.signalMeta) input.signalMetadata = opts.signalMeta;
  if (opts.ephemeral) input.ephemeral = true;
  const result = await callLinear(api, cfg, "agentActivityCreate", {
    query: ACTIVITY_MUTATION,
    variables: { input },
  });
  if (!result.ok) return;
  const root = readObject(result.data!.agentActivityCreate);
  if (root && root.success === true) return;
  api.logger.warn?.("linear activity failed");
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

  // Session creation events are allowed only when delegated to this app user.
  if (action === "created") {
    if (data.__delegationSessionCreated === true) {
      return { ok: true, reason: "delegation-session-created" };
    }
    const issue = resolveIssue(data);
    const issueId = readString(issue?.id) ?? readString(data.issueId as string) ?? "";
    const delegate = readObject(issue?.delegate);
    let delegateId = readString(delegate?.id) ?? "";
    let delegateName =
      readString(delegate?.name) ??
      readString(delegate?.displayName) ??
      "";
    if (!delegateId && issueId) {
      const info = await resolveIssueInfo(api, cfg, issueId);
      delegateId = info?.delegateId ?? "";
      delegateName = info?.delegateName ?? delegateName;
    }
    if (isDelegatedToTarget(delegateId, delegateName, viewerId, mentionHandle)) {
      return { ok: true, reason: "delegated-to-app" };
    }
    // In strict mode, also allow explicit mention on create events.
    const handle = (mentionHandle ?? "").trim().toLowerCase().replace(/^@/, "");
    const createdMentions = extractMentionHandles((prompt ?? "").toLowerCase());
    if (handle && createdMentions.has(handle)) {
      return { ok: true, reason: "explicit-mention-on-create" };
    }
    return { ok: false, reason: "created-without-delegation" };
  }

  const comment = readObject(data.comment);
  const bodyRaw = `${prompt}\n${readString(comment?.body) ?? ""}`;
  const body = bodyRaw.toLowerCase();
  const handle = (mentionHandle ?? "").trim().toLowerCase().replace(/^@/, "");
  const mentionedHandles = extractMentionHandles(body);

  // If current comment mentions handles and not ours, skip (targeting someone else).
  if (mentionedHandles.size > 0 && handle && !mentionedHandles.has(handle)) {
    return { ok: false, reason: "mentioned-other-bot" };
  }

  // Explicit mention of this app always allows processing.
  if (handle && mentionedHandles.has(handle)) {
    return { ok: true, reason: "explicit-mention" };
  }

  // For thread replies, lock on root thread owner mention when present.
  const parentId = readString(comment?.parentId) ?? readString(data.parentId as string) ?? "";
  const commentId = readString(comment?.id) ?? readString(data.commentId as string) ?? "";
  if (kind === "Comment" && parentId) {
    const ownerHandle = await resolveThreadOwnerHandle(api, cfg, commentId);
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

async function createSessionForDelegatedIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
  requireDelegateChange: boolean,
): Promise<{ sessionId: string; issueId: string; reason: string }> {
  const kind = readString(data.type as string) ?? "";
  const notificationType = (
    readString(data.notificationType as string) ??
    readString(readObject(data.notification)?.type) ??
    ""
  )
    .trim()
    .toLowerCase();
  const isIssueUpdate = kind === "Issue";
  const isIssueAssignedNotification =
    kind === "AppUserNotification" &&
    (notificationType === "issueassignedtoyou" ||
      notificationType === "issue_assigned_to_you");
  if (!isIssueUpdate && !isIssueAssignedNotification) {
    return { sessionId: "", issueId: "", reason: `unsupported-kind:${kind || "unknown"}` };
  }
  if (isIssueUpdate) {
    const rawAction = (readString(data.action as string) ?? "").trim().toLowerCase();
    if (rawAction && rawAction !== "update" && rawAction !== "updated") {
      return { sessionId: "", issueId: "", reason: `unsupported-action:${rawAction}` };
    }
  }

  const issue = resolveIssue(data);
  const notification = readObject(data.notification);
  const payload = readObject(data.payload);
  const entity = readObject(data.entity);
  const subject = readObject(data.subject);
  const organization = readObject(data.organization);
  const orgIssue = readObject(organization?.issue);
  const notificationIssue = readObject(notification?.issue);
  const payloadIssue = readObject(payload?.issue);
  const entityIssue = readObject(entity?.issue);
  const subjectIssue = readObject(subject?.issue);
  const issueId =
    readString(issue?.id) ??
    readString(notificationIssue?.id) ??
    readString(payloadIssue?.id) ??
    readString(entityIssue?.id) ??
    readString(subjectIssue?.id) ??
    readString(orgIssue?.id) ??
    readString(notification?.issueId) ??
    readString(payload?.issueId) ??
    readString(entity?.issueId) ??
    readString(subject?.issueId) ??
    readString(organization?.issueId) ??
    readString(data.issueId as string) ??
    readString(data.id as string) ??
    "";
  if (!issueId) {
    const topKeys = Object.keys(data).join(",");
    const notificationKeys = notification ? Object.keys(notification).join(",") : "";
    api.logger.info?.(
      `linear delegation issue id missing kind=${kind || "unknown"} notificationType=${notificationType || "-"} keys=[${topKeys}] notificationKeys=[${notificationKeys}]`,
    );
    return { sessionId: "", issueId: "", reason: "missing-issue-id" };
  }

  const recent = delegationByIssue.get(issueId);
  if (recent?.sessionId) {
    return {
      sessionId: recent.sessionId,
      issueId,
      reason: "existing-issue-session-cache",
    };
  }
  const existingSession = await resolveKnownSessionForIssue(api, cfg, issueId);
  if (existingSession) {
    delegationByIssue.set(issueId, { sessionId: existingSession, at: Date.now() });
    return {
      sessionId: existingSession,
      issueId,
      reason: "existing-issue-session-linear",
    };
  }

  const viewerId = await resolveViewer(api, cfg);
  const targetHandle = normalizeMentionHandle(cfg.mentionHandle);
  if (!viewerId && !targetHandle) {
    return { sessionId: "", issueId, reason: "missing-viewer-and-mentionHandle" };
  }
  if (
    requireDelegateChange &&
    !isIssueAssignedNotification &&
    !didDelegateChangeToTarget(data, viewerId, targetHandle)
  ) {
    return { sessionId: "", issueId, reason: "delegate-change-not-targeted" };
  }

  const delegate = readObject(issue?.delegate);
  let delegateId = readString(delegate?.id) ?? "";
  let delegateName =
    readString(delegate?.name) ??
    readString(delegate?.displayName) ??
    "";
  if (!delegateId) {
    const info = await resolveIssueInfo(api, cfg, issueId);
    delegateId = info?.delegateId ?? "";
    delegateName = info?.delegateName ?? delegateName;
  }
  if (!isDelegatedToTarget(delegateId, delegateName, viewerId, cfg.mentionHandle)) {
    return {
      sessionId: "",
      issueId,
      reason: `delegate-not-target id=${delegateId || "-"} name=${delegateName || "-"}`,
    };
  }

  const result = await callLinear(api, cfg, "agentSessionCreateOnIssue(delegate)", {
    query: AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
    variables: { input: { issueId } },
  });
  if (!result.ok) return { sessionId: "", issueId, reason: "agentSessionCreateOnIssue-failed" };
  const root = readObject(result.data?.agentSessionCreateOnIssue);
  if (!root || root.success !== true) return { sessionId: "", issueId, reason: "agentSessionCreateOnIssue-unsuccessful" };
  const session = readObject(root.agentSession);
  const sessionId = readString(session?.id) ?? "";
  if (sessionId) {
    delegationByIssue.set(issueId, { sessionId, at: Date.now() });
    api.logger.info?.(
      `linear handler: created session from delegation issue=${issueId.slice(0, 8)} session=${sessionId.slice(0, 8)}`,
    );
  }
  return {
    sessionId,
    issueId,
    reason: sessionId ? "ok" : "missing-session-id",
  };
}

function didDelegateChangeToTarget(
  data: Record<string, unknown>,
  viewerId: string,
  targetHandle: string,
): boolean {
  if (!viewerId && !targetHandle) return false;
  const updatedFrom = readObject(data.updatedFrom);
  const updatedTo = readObject(data.updatedTo);

  const fromDelegate = readDelegateField(updatedFrom);
  const toDelegate = readDelegateField(updatedTo);

  const fromMatches = delegateFieldMatchesTarget(fromDelegate, viewerId, targetHandle);
  const toMatches = delegateFieldMatchesTarget(toDelegate, viewerId, targetHandle);

  if (toMatches) {
    return !fromMatches;
  }
  if (updatedFrom) {
    const touchedDelegateField =
      "delegateId" in updatedFrom ||
      "delegate" in updatedFrom;
    if (touchedDelegateField) {
      return !fromMatches;
    }
  }
  return false;
}

function readDelegateField(obj: Record<string, unknown> | undefined): string {
  if (!obj) return "";
  const delegateObj = readObject(obj.delegate);
  return (
    readString(obj.delegateId) ??
    readString(delegateObj?.id) ??
    readString(delegateObj?.name) ??
    readString(delegateObj?.displayName) ??
    ""
  );
}

function normalizeMentionHandle(input: string | undefined): string {
  return (input ?? "").trim().toLowerCase().replace(/^@/, "");
}

function normalizeDelegateName(input: string): string {
  return (input ?? "").trim().toLowerCase().replace(/^@/, "");
}

function isDelegatedToTarget(
  delegateId: string,
  delegateName: string,
  viewerId: string,
  mentionHandle: string | undefined,
): boolean {
  if (viewerId && delegateId && delegateId === viewerId) return true;
  const targetHandle = normalizeMentionHandle(mentionHandle);
  if (!targetHandle) return false;
  return normalizeDelegateName(delegateName) === targetHandle;
}

function delegateFieldMatchesTarget(
  rawValue: string,
  viewerId: string,
  targetHandle: string,
): boolean {
  const v = (rawValue ?? "").trim().toLowerCase();
  if (!v) return false;
  if (viewerId && v === viewerId.toLowerCase()) return true;
  if (targetHandle && normalizeDelegateName(v) === targetHandle) return true;
  return false;
}

function extractMentionHandles(text: string): Set<string> {
  const matches = Array.from((text ?? "").matchAll(/@([a-z0-9._-]+)/gi));
  return new Set(matches.map((m) => (m[1] ?? "").toLowerCase()).filter(Boolean));
}

function pickBotLikeHandle(handles: Set<string>): string {
  for (const h of handles) {
    if (h.includes("openclaw") || h.endsWith("-bot") || h.endsWith("bot")) return h;
  }
  return "";
}

async function resolveThreadOwnerHandle(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  commentId: string,
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
      return pickBotLikeHandle(handles);
    }

    const parent = readObject(node.parent);
    const parentObjId = readString(parent?.id) ?? "";
    const parentObjParentId = readString(parent?.parentId) ?? "";
    if (parent && parentObjId && !parentObjParentId) {
      const rootBody = readString(parent.body) ?? "";
      const handles = extractMentionHandles(rootBody.toLowerCase());
      return pickBotLikeHandle(handles);
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
