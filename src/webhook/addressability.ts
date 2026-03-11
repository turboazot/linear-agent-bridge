import type { OpenClawPluginApi, PluginConfig, AddressabilityDecision } from "../types.js";
import { callLinear } from "../linear-client.js";
import { resolveIssueInfo } from "./issue-policy.js";
import { resolveIssue } from "./session-resolver.js";
import { readObject, readString } from "../util.js";

export async function decideAddressability(input: {
  api: OpenClawPluginApi;
  cfg: PluginConfig;
  kind: string;
  action: string;
  data: Record<string, unknown>;
  prompt: string;
  viewerId: string;
  mentionHandle?: string;
}): Promise<AddressabilityDecision> {
  const { api, cfg, kind, action, data, prompt, viewerId, mentionHandle } = input;

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
    const handle = normalizeMentionHandle(mentionHandle);
    const createdMentions = extractMentionHandles((prompt ?? "").toLowerCase());
    if (handle && createdMentions.has(handle)) {
      return { ok: true, reason: "explicit-mention-on-create" };
    }
    return { ok: false, reason: "created-without-delegation" };
  }

  const comment = readObject(data.comment);
  const bodyRaw = `${prompt}\n${readString(comment?.body) ?? ""}`;
  const body = bodyRaw.toLowerCase();
  const handle = normalizeMentionHandle(mentionHandle);
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
    const ownerHandle = await resolveThreadOwnerHandle(api, cfg, commentId);
    if (ownerHandle) {
      if (handle && ownerHandle === handle) {
        return { ok: true, reason: "thread-owned-by-us" };
      }
      return { ok: false, reason: `thread-owned-by-${ownerHandle}` };
    }
    const issue = resolveIssue(data);
    const issueId = readString(issue?.id) ?? readString(data.issueId as string) ?? "";
    if (issueId) {
      const info = await resolveIssueInfo(api, cfg, issueId);
      const delegateId = info?.delegateId ?? "";
      const delegateName = info?.delegateName ?? "";
      if (isDelegatedToTarget(delegateId, delegateName, viewerId, cfg.mentionHandle)) {
        return { ok: true, reason: "delegated-fallback" };
      }
    }
    return { ok: false, reason: "thread-owner-unknown" };
  }

  return { ok: false, reason: "not-addressed" };
}

export function normalizeMentionHandle(input: string | undefined): string {
  return (input ?? "").trim().toLowerCase().replace(/^@/, "");
}

function normalizeDelegateName(input: string): string {
  return (input ?? "").trim().toLowerCase().replace(/^@/, "");
}

export function extractMentionHandles(text: string): Set<string> {
  const matches = Array.from((text ?? "").matchAll(/@([a-z0-9._-]+)/gi));
  return new Set(matches.map((m) => (m[1] ?? "").toLowerCase()).filter(Boolean));
}

function pickBotLikeHandle(handles: Set<string>): string {
  for (const h of handles) {
    if (h.includes("openclaw") || h.endsWith("-bot") || h.endsWith("bot")) return h;
  }
  return "";
}

export function isDelegatedToTarget(
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
