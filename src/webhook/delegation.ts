import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { callLinear, resolveViewer } from "../linear-client.js";
import { AGENT_SESSION_CREATE_ON_ISSUE_MUTATION } from "../graphql/mutations.js";
import { readObject, readString } from "../util.js";
import { resolveKnownSessionForIssue, resolveIssue } from "./session-resolver.js";
import { resolveIssueInfo } from "./issue-policy.js";
import { getDelegationSession, rememberDelegationSession } from "../runtime/run-registry.js";
import { isDelegatedToTarget, normalizeMentionHandle } from "./addressability.js";

export async function createSessionForDelegatedIssue(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  data: Record<string, unknown>,
): Promise<{ sessionId: string; issueId: string; reason: string }> {
  const kind = readString(data.type as string) ?? "";
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
  if (!isIssueAssignedNotification) {
    return { sessionId: "", issueId: "", reason: `unsupported-kind:${kind || "unknown"}` };
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

  const recentSession = getDelegationSession(issueId);
  if (recentSession) {
    return {
      sessionId: recentSession,
      issueId,
      reason: "existing-issue-session-cache",
    };
  }
  const existingSession = await resolveKnownSessionForIssue(api, cfg, issueId);
  if (existingSession) {
    rememberDelegationSession(issueId, existingSession);
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
  if (!root || root.success !== true) {
    return { sessionId: "", issueId, reason: "agentSessionCreateOnIssue-unsuccessful" };
  }
  const session = readObject(root.agentSession);
  const sessionId = readString(session?.id) ?? "";
  if (sessionId) {
    rememberDelegationSession(issueId, sessionId);
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
