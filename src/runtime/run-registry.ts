import type { SessionContext } from "../types.js";
import { cleanupSession as cleanupPlan } from "../agent/plan-manager.js";
import { clearResponseFlag } from "../agent/response-tracker.js";
import { revokeSessionToken } from "../agent/session-token.js";

const inflightSessions = new Map<string, number>();
const delegationByIssue = new Map<string, { sessionId: string; at: number }>();
const sessionTokens = new Map<string, string>();
const sessionSubscriptions = new Map<string, () => void>();

export const DEDUP_WINDOW_MS = 5_000;

export function isSessionInflight(sessionId: string): boolean {
  return inflightSessions.has(sessionId);
}

export function getInflightSince(sessionId: string): number | undefined {
  return inflightSessions.get(sessionId);
}

export function markSessionInflight(sessionId: string): void {
  inflightSessions.set(sessionId, Date.now());
}

export function clearSessionInflight(sessionId: string): void {
  inflightSessions.delete(sessionId);
}

export function rememberDelegationSession(issueId: string, sessionId: string): void {
  if (!issueId || !sessionId) return;
  delegationByIssue.set(issueId, { sessionId, at: Date.now() });
}

export function getDelegationSession(issueId: string): string {
  return delegationByIssue.get(issueId)?.sessionId ?? "";
}

export function attachSessionToken(context: SessionContext): void {
  if (!context.sessionId || !context.apiToken) return;
  sessionTokens.set(context.sessionId, context.apiToken);
}

export function registerSessionSubscription(
  sessionId: string,
  unsubscribe: (() => void) | undefined,
): void {
  if (!sessionId || !unsubscribe) return;
  const previous = sessionSubscriptions.get(sessionId);
  previous?.();
  sessionSubscriptions.set(sessionId, unsubscribe);
}

export function cleanupRun(sessionId: string): void {
  if (!sessionId) return;
  clearSessionInflight(sessionId);
  sessionSubscriptions.get(sessionId)?.();
  sessionSubscriptions.delete(sessionId);
  const token = sessionTokens.get(sessionId);
  if (token) {
    revokeSessionToken(token);
    sessionTokens.delete(sessionId);
  }
  cleanupPlan(sessionId);
  clearResponseFlag(sessionId);
}
