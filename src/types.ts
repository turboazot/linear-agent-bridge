import type { IncomingMessage, ServerResponse } from "node:http";

export interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  config?: { gateway?: { auth?: { token?: string; password?: string } } };
  logger: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  callGateway?: unknown;
  onAgentEvent?: (
    listener: (event: AgentEventPayload) => void,
    opts?: {
      runId?: string;
      sessionKey?: string;
    },
  ) => () => void;
  registerHttpRoute: (opts: {
    path: string;
    auth: "gateway" | "plugin";
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>;
  }) => void;
}

export interface PluginConfig {
  devAgentId?: string;
  linearWebhookSecret?: string;
  linearApiKey?: string;
  linearOauthClientId?: string;
  linearOauthClientSecret?: string;
  linearOauthRedirectUri?: string;
  linearTokenStorePath?: string;
  notifyChannel?: string;
  notifyTo?: string;
  notifyAccountId?: string;
  repoByTeam?: Record<string, string>;
  repoByProject?: Record<string, string>;
  defaultDir?: string;
  delegateOnCreate?: boolean;
  startOnCreate?: boolean;
  externalUrlBase?: string;
  externalUrlLabel?: string;
  enableAgentApi?: boolean;
  apiBaseUrl?: string;
  mentionHandle?: string;
  agentTimeoutMs?: number;
  linearRequestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export type ActivityType =
  | "thought"
  | "elicitation"
  | "action"
  | "response"
  | "error";

export interface ActivityContent {
  type: ActivityType;
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

export interface ActivityOptions {
  signal?: string;
  signalMeta?: Record<string, unknown>;
  ephemeral?: boolean;
}

export interface PlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface SessionContext {
  sessionId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  teamId: string;
  apiToken: string;
}

export interface LinearCallResult {
  ok: boolean;
  status?: number;
  error?: string;
  data?: Record<string, unknown>;
}

export type TriggerKind =
  | "AgentSessionEvent"
  | "Comment"
  | "AppUserNotification"
  | "Unknown";

export type TriggerAction = "created" | "prompted";

export interface Trigger {
  kind: TriggerKind;
  action: TriggerAction;
  source: "session" | "comment" | "delegation";
  payload: Record<string, unknown>;
}

export interface AddressabilityDecision {
  ok: boolean;
  reason: string;
}

export interface PreparedRun {
  trigger: Trigger;
  sessionId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  issueDescription: string;
  teamId: string;
  repo: string;
  guidance: string;
  prompt: string;
  context: string;
  compactMessage: boolean;
  label: string;
  agentId: string;
  sessionKey: string;
  idempotencyKey: string;
  deliver: boolean;
}

export type ReadBodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: number; error: string };

export interface IssueInfo {
  id: string;
  teamId: string;
  stateType: string;
  delegateId: string;
  delegateName?: string;
}

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export interface AgentEventPayload {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
}
