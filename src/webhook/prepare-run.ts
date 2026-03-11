import type { OpenClawPluginApi, PluginConfig, PreparedRun, Trigger } from "../types.js";
import { resolveIssue } from "./session-resolver.js";
import { readObject, readString, normalizeKey } from "../util.js";
import { shouldSkipPromptedRun } from "./skip-filter.js";
import { resolveContext, resolveKey, resolvePrompt, resolveRepo } from "./message-builder.js";
import { fetchIssueDetail } from "./queries.js";
import { buildLabel } from "./message-builder.js";
import { randomUUID } from "node:crypto";

export async function prepareRun(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  trigger: Trigger,
  sessionId: string,
  delivery: string | undefined,
): Promise<PreparedRun | null> {
  const data = trigger.payload;
  const issue = resolveIssue(data);
  let issueId = readString(issue?.id) ?? "";
  let id = readString(issue?.identifier) ?? "";
  let title = readString(issue?.title) ?? "";
  let url = readString(issue?.url) ?? "";
  let desc = readString(issue?.description) ?? "";
  let teamId = readString(readObject(issue?.team)?.id) ?? "";
  let team = resolveKey(issue?.team);
  let proj = resolveKey(issue?.project);
  const guidance = readString(data.guidance as string) ?? "";
  const prompt = resolvePrompt(data);
  if (trigger.action === "prompted") {
    const skipReason = shouldSkipPromptedRun(prompt);
    if (skipReason) {
      api.logger.info?.(`linear prompted event ignored (${skipReason})`);
      return null;
    }
  }

  const comment = readObject(data.comment);
  const parentId = readString(comment?.parentId) ?? readString(data.parentId as string) ?? "";
  const mentionHandle = (cfg.mentionHandle ?? "").trim().toLowerCase().replace(/^@/, "");
  const mentionSource = `${prompt}\n${readString(comment?.body) ?? ""}`.toLowerCase();
  const mentionedHandles = new Set(
    Array.from(mentionSource.matchAll(/@([a-z0-9._-]+)/gi)).map((m) => (m[1] ?? "").toLowerCase()),
  );
  const isRootMention =
    trigger.kind === "Comment" && !parentId && Boolean(mentionHandle) && mentionedHandles.has(mentionHandle);
  const compactMessage = !(trigger.action === "created" || isRootMention);
  if (
    (trigger.action === "created" || isRootMention) &&
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
  const key = normalizeKey(sessionId || id || randomUUID());
  return {
    trigger,
    sessionId,
    issueId,
    issueIdentifier: id,
    issueTitle: title,
    issueUrl: url,
    issueDescription: desc,
    teamId,
    repo,
    guidance,
    prompt,
    context: resolveContext(data),
    compactMessage,
    label,
    agentId: agent,
    sessionKey: `agent:${agent}:linear:${key}`,
    idempotencyKey: delivery ?? randomUUID(),
    deliver: Boolean(cfg.notifyChannel && cfg.notifyTo),
  };
}
