import type {
  ActivityContent,
  ActivityOptions,
  OpenClawPluginApi,
  PlanStep,
  PluginConfig,
} from "./types.js";
import { callLinear } from "./linear-client.js";
import {
  ACTIVITY_MUTATION,
  AGENT_SESSION_CREATE_ON_COMMENT_MUTATION,
  AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
  SESSION_UPDATE_MUTATION,
} from "./graphql/mutations.js";
import { readObject, readString } from "./util.js";

const activityQueueBySession = new Map<string, Promise<boolean>>();
const terminalSessions = new Set<string>();

function isTerminalActivity(content: ActivityContent): boolean {
  return content.type === "response" || content.type === "error";
}

function enqueueSessionActivity(
  session: string,
  task: () => Promise<boolean>,
): Promise<boolean> {
  const previous = activityQueueBySession.get(session) ?? Promise.resolve(true);
  const next = previous
    .catch(() => false)
    .then(task);
  activityQueueBySession.set(session, next);
  void next.finally(() => {
    if (activityQueueBySession.get(session) === next) {
      activityQueueBySession.delete(session);
    }
  });
  return next;
}

export async function postLinearActivity(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  content: ActivityContent,
  opts: ActivityOptions = {},
): Promise<boolean> {
  if (!session) return false;
  if (terminalSessions.has(session) && !isTerminalActivity(content)) {
    api.logger.info?.(
      `linear activity: skipping session=${session.slice(0, 8)}... type=${content.type} after terminal activity`,
    );
    return false;
  }

  if (isTerminalActivity(content)) {
    terminalSessions.add(session);
  }

  return enqueueSessionActivity(session, async () => {
    api.logger.info?.(
      `linear activity: posting session=${session.slice(0, 8)}... type=${content.type}${content.action ? ` action=${content.action}` : ""}`,
    );
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
    if (!result.ok) {
      api.logger.warn?.(`linear activity failed: ${result.error ?? "unknown error"}`);
      if (isTerminalActivity(content)) {
        terminalSessions.delete(session);
      }
      return false;
    }
    const root = readObject(result.data?.agentActivityCreate);
    if (root?.success === true) {
      api.logger.info?.("linear activity: posted successfully");
      return true;
    }
    api.logger.warn?.("linear activity failed");
    if (isTerminalActivity(content)) {
      terminalSessions.delete(session);
    }
    return false;
  });
}

export function resetLinearSessionActivityState(session: string): void {
  if (!session) return;
  terminalSessions.delete(session);
  activityQueueBySession.delete(session);
}

export async function updateLinearSessionExternalUrl(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  url: string,
  label: string,
): Promise<boolean> {
  if (!session || !url) return false;
  const input = { addedExternalUrls: [{ label, url }] };
  const result = await callLinear(api, cfg, "agentSessionUpdate", {
    query: SESSION_UPDATE_MUTATION,
    variables: { id: session, input },
  });
  if (!result.ok) return false;
  const root = readObject(result.data?.agentSessionUpdate);
  return root?.success === true;
}

export async function updateLinearSessionPlan(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  session: string,
  plan: PlanStep[],
): Promise<boolean> {
  const result = await callLinear(api, cfg, "agentSessionUpdate(plan)", {
    query: SESSION_UPDATE_MUTATION,
    variables: { id: session, input: { plan } },
  });
  if (!result.ok) return false;
  const root = readObject(result.data?.agentSessionUpdate);
  return root?.success === true;
}

export async function createLinearSessionOnIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
): Promise<string> {
  const result = await callLinear(api, cfg, "agentSessionCreateOnIssue", {
    query: AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
    variables: { input: { issueId } },
  });
  if (!result.ok) return "";
  const root = readObject(result.data?.agentSessionCreateOnIssue);
  const session = readObject(root?.agentSession);
  return root?.success === true ? (readString(session?.id) ?? "") : "";
}

export async function createLinearSessionOnComment(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  commentId: string,
): Promise<string> {
  const result = await callLinear(api, cfg, "agentSessionCreateOnComment", {
    query: AGENT_SESSION_CREATE_ON_COMMENT_MUTATION,
    variables: { input: { commentId } },
  });
  if (!result.ok) return "";
  const root = readObject(result.data?.agentSessionCreateOnComment);
  const session = readObject(root?.agentSession);
  return root?.success === true ? (readString(session?.id) ?? "") : "";
}
