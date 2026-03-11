import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi, PluginConfig, PreparedRun } from "../types.js";
import { buildMessage, buildStopText, buildThought, resolveExternal } from "./message-builder.js";
import { buildEnrichedMessage } from "../agent/context-builder.js";
import { buildAgentResponse } from "./response-parser.js";
import { createSessionToken } from "../agent/session-token.js";
import { hasPostedResponse, clearResponseFlag } from "../agent/response-tracker.js";
import { createAgentEventToLinearMapper } from "../agent/event-to-linear.js";
import {
  attachSessionToken,
  cleanupRun,
  clearSessionInflight,
  registerSessionSubscription,
} from "../runtime/run-registry.js";
import {
  postLinearActivity,
  resetLinearSessionActivityState,
  updateLinearSessionExternalUrl,
} from "../linear-session-service.js";
import { applyIssuePolicy } from "./issue-policy.js";
import { isCloseIntentPrompt, closeIssueFromPrompt } from "./close-intent.js";
import { normalizeKey, readObject, readString } from "../util.js";

export async function executePreparedRun(params: {
  api: OpenClawPluginApi;
  cfg: PluginConfig;
  sessionId: string;
  prepared: PreparedRun;
  loadCallGateway: (api: OpenClawPluginApi) => Promise<(opts: Record<string, unknown>) => Promise<unknown>>;
  defaultAgentTimeoutMs: number;
  defaultHeartbeatIntervalMs: number;
}): Promise<void> {
  const { api, cfg, sessionId, prepared, loadCallGateway, defaultAgentTimeoutMs, defaultHeartbeatIntervalMs } = params;
  resetLinearSessionActivityState(sessionId);

  const signal = readString(prepared.trigger.payload.signal as string) ??
    readString(readObject(prepared.trigger.payload.agentActivity)?.signal) ??
    "";

  if (signal === "stop") {
    clearSessionInflight(sessionId);
    const text = buildStopText(prepared.issueIdentifier, prepared.issueTitle);
    await postLinearActivity(api, cfg, sessionId, { type: "response", body: text });
    return;
  }

  await postLinearActivity(api, cfg, sessionId, {
    type: "thought",
    body: buildThought(prepared.trigger.action, prepared.issueIdentifier, prepared.issueTitle),
  });

  if (isCloseIntentPrompt(prepared.prompt)) {
    clearSessionInflight(sessionId);
    const closeText = prepared.issueId
      ? await closeIssueFromPrompt(api, cfg, prepared.issueId, prepared.issueIdentifier, prepared.issueTitle)
      : "Не удалось определить задачу для закрытия.";
    await postLinearActivity(api, cfg, sessionId, { type: "response", body: closeText });
    return;
  }

  if (prepared.trigger.action === "created") {
    const external = resolveExternal(cfg, sessionId, prepared.issueId);
    if (external) {
      void updateLinearSessionExternalUrl(api, cfg, sessionId, external.url, external.label);
    }
    void applyIssuePolicy(api, cfg, prepared.issueId);
  }

  const enableApi = cfg.enableAgentApi !== false;
  api.logger.info?.(
    `linear handler: enableApi=${enableApi} session=${sessionId.slice(0, 8)}... issueId=${prepared.issueId.slice(0, 8) || "(none)"}`,
  );

  let apiToken = "";
  if (enableApi) {
    const sessionCtx = {
      sessionId,
      issueId: prepared.issueId,
      issueIdentifier: prepared.issueIdentifier,
      issueTitle: prepared.issueTitle,
      issueUrl: prepared.issueUrl,
      teamId: prepared.teamId,
      apiToken: "",
    };
    apiToken = createSessionToken(sessionCtx);
    sessionCtx.apiToken = apiToken;
    attachSessionToken(sessionCtx);
  }

  let message: string;
  if (enableApi && apiToken) {
    const { getBaseUrl } = await import("../api/base-url.js");
    const apiBaseUrl = cfg.apiBaseUrl || getBaseUrl();
    api.logger.info?.(`linear handler: ENRICHED message, apiBaseUrl=${apiBaseUrl}, tokenLen=${apiToken.length}`);
    message = buildEnrichedMessage({
      action: prepared.trigger.action,
      id: prepared.issueIdentifier,
      title: prepared.issueTitle,
      url: prepared.issueUrl,
      desc: prepared.issueDescription,
      guidance: prepared.guidance,
      prompt: prepared.prompt,
      repo: prepared.repo,
      session: sessionId,
      context: prepared.context,
      compact: prepared.compactMessage,
      apiBaseUrl,
      apiToken,
      issueId: prepared.issueId,
      teamId: prepared.teamId,
    });
  } else {
    message = buildMessage({
      action: prepared.trigger.action,
      id: prepared.issueIdentifier,
      title: prepared.issueTitle,
      url: prepared.issueUrl,
      desc: prepared.issueDescription,
      guidance: prepared.guidance,
      prompt: prepared.prompt,
      repo: prepared.repo,
      session: sessionId,
      context: prepared.context,
      compact: prepared.compactMessage,
    });
  }

  const call = await loadCallGateway(api);
  const agentTimeoutMs = cfg.agentTimeoutMs ?? defaultAgentTimeoutMs;
  const heartbeatIntervalMs = cfg.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribeAgentEvents: (() => void) | undefined;

  if (typeof api.onAgentEvent === "function") {
    const mapEvent = createAgentEventToLinearMapper({
      issueLabel: `${prepared.issueIdentifier} ${prepared.issueTitle}`.trim() || "this issue",
    });
    const unsubscribe = api.onAgentEvent(
      (event) => {
        const activities = mapEvent(event);
        for (const activity of activities) {
          void postLinearActivity(api, cfg, sessionId, activity);
        }
      },
      { sessionKey: prepared.sessionKey },
    );
    unsubscribeAgentEvents = unsubscribe;
    registerSessionSubscription(sessionId, unsubscribe);
  }

  const runAgent = (sessionKey: string, idempotencyKey: string) =>
    call({
      method: "agent",
      params: {
        message,
        agentId: prepared.agentId,
        sessionKey,
        label: prepared.label,
        idempotencyKey,
        deliver: prepared.deliver,
        channel: cfg.notifyChannel,
        to: cfg.notifyTo,
        accountId: cfg.notifyAccountId,
      },
      expectFinal: true,
      timeoutMs: agentTimeoutMs,
    });

  const handleSuccess = async (result: unknown) => {
    unsubscribeAgentEvents?.();
    unsubscribeAgentEvents = undefined;
    cleanupRun(sessionId);

    const text = buildAgentResponse(result);
    const payload = readObject(result);
    const status = readString(payload?.status) ?? "";
    const error = readString(payload?.error) ?? "";
    const resultObj = readObject(payload?.result);
    const stopReason = readString(resultObj?.stopReason) ?? "";

    if (hasPostedResponse(sessionId)) {
      clearResponseFlag(sessionId);
      return;
    }

    if (!text || text === "Agent completed with no reply.") {
      const reason = error || stopReason || status || "empty-result";
      await postLinearActivity(api, cfg, sessionId, {
        type: "error",
        body: `Agent run ended without a final response (${reason}). Please retry.`,
      });
      return;
    }
    await postLinearActivity(api, cfg, sessionId, { type: "response", body: text });
  };

  try {
    if (!unsubscribeAgentEvents && heartbeatIntervalMs >= 5_000) {
      heartbeat = setInterval(() => {
        void postLinearActivity(api, cfg, sessionId, {
          type: "thought",
          body: `Still working on ${prepared.issueIdentifier || "this issue"}...`,
        });
      }, heartbeatIntervalMs);
    }
    const result = await runAgent(prepared.sessionKey, prepared.idempotencyKey);
    await handleSuccess(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAgentSessionMismatch =
      msg.includes("does not match session key agent") ||
      (msg.includes("invalid agent params") && msg.includes("session key agent"));

    if (isAgentSessionMismatch) {
      const freshSessionKey = `agent:${prepared.agentId}:linear:${normalizeKey(randomUUID())}`;
      const retryIdem = randomUUID();
      api.logger.warn?.(`linear agent/session mismatch detected; retrying with fresh session key (${freshSessionKey})`);
      try {
        const retryResult = await runAgent(freshSessionKey, retryIdem);
        await handleSuccess(retryResult);
        return;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        unsubscribeAgentEvents?.();
        cleanupRun(sessionId);
        await postLinearActivity(api, cfg, sessionId, {
          type: "error",
          body: `Agent run failed: ${retryMsg}`,
        });
        return;
      }
    }

    unsubscribeAgentEvents?.();
    cleanupRun(sessionId);
    await postLinearActivity(api, cfg, sessionId, {
      type: "error",
      body: `Agent run failed: ${msg}`,
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
