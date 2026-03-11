import type { Trigger, TriggerAction, TriggerKind } from "../types.js";
import { readObject, readString } from "../util.js";

export function normalizePayload(
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

export function resolveTriggerAction(data: Record<string, unknown>): TriggerAction | "" {
  const kind = readString(data.type as string) ?? "";
  const rawAction = (readString(data.action as string) ?? "").trim().toLowerCase();
  if (kind === "Comment") {
    if (
      rawAction &&
      rawAction !== "create" &&
      rawAction !== "created" &&
      rawAction !== "prompted"
    ) {
      return "";
    }
    return "prompted";
  }
  if (rawAction === "create" || rawAction === "created") return "created";
  if (rawAction === "prompt" || rawAction === "prompted") return "prompted";
  return "";
}

export function normalizeTrigger(data: Record<string, unknown>): Trigger | null {
  const kind = (readString(data.type as string) ?? "") as TriggerKind | "";
  const action = resolveTriggerAction(data);
  const notificationType = (
    readString(data.notificationType as string) ??
    readString(readObject(data.notification)?.type) ??
    ""
  )
    .trim()
    .toLowerCase();

  const isIssueAssignedNotification =
    kind === "AppUserNotification" &&
    (notificationType === "issueassignedtoyou" ||
      notificationType === "issue_assigned_to_you");
  const isAgentSessionEvent =
    kind === "AgentSessionEvent" && Boolean(action);
  const isCommentCreated =
    kind === "Comment" && action === "prompted";

  if (!isIssueAssignedNotification && !isAgentSessionEvent && !isCommentCreated) {
    return null;
  }

  return {
    kind: kind || "Unknown",
    action: isIssueAssignedNotification ? "created" : (action || "prompted"),
    source:
      isIssueAssignedNotification ? "delegation" : isAgentSessionEvent ? "session" : "comment",
    payload: data,
  };
}
