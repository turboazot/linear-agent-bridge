import type { ActivityContent, AgentEventPayload } from "../types.js";
import { formatToolActivity } from "./tool-activity.js";
import { readObject, readString } from "../util.js";

const ASSISTANT_MIN_CHARS = 120;
const ASSISTANT_FORCE_CHARS = 260;
const ASSISTANT_TERMINATORS = /[.!?\n]\s*$/;
function truncate(text: string, max = 400): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

export class AgentEventReducer {
  private started = false;
  private assistantBuffer = "";
  private lastAssistantSnapshot = "";
  private lastToolResultKey = "";

  constructor(private readonly issueLabel: string) {}

  private flushAssistantBuffer(): ActivityContent[] {
    const text = truncate(this.assistantBuffer);
    this.assistantBuffer = "";
    if (!text) return [];
    return [{ type: "thought", body: text }];
  }

  reduce(event: AgentEventPayload): ActivityContent[] {
    const data = readObject(event.data) ?? {};

    if (event.stream === "lifecycle") {
      const phase = readString(data.phase);
      if (phase === "start") {
        if (this.started) return [];
        this.started = true;
        return [{ type: "thought", body: `Starting work on ${this.issueLabel || "this issue"}.` }];
      }
      if (phase === "error") {
        const flushed = this.flushAssistantBuffer();
        const error = truncate(readString(data.error) ?? "Agent run failed.");
        return [...flushed, { type: "error", body: error || "Agent run failed." }];
      }
      if (phase === "end" || phase === "complete" || phase === "completed" || phase === "stop") {
        return this.flushAssistantBuffer();
      }
      return [];
    }

    if (event.stream === "assistant") {
      const nextText = readString(data.text) ?? "";
      const delta = readString(data.delta) ?? "";
      let appended = "";

      if (nextText) {
        const normalized = nextText.trimStart();
        if (!normalized) return [];
        if (normalized === this.lastAssistantSnapshot) return [];
        if (normalized.startsWith(this.lastAssistantSnapshot)) {
          appended = normalized.slice(this.lastAssistantSnapshot.length);
        } else {
          appended = normalized;
          this.assistantBuffer = "";
        }
        this.lastAssistantSnapshot = normalized;
      } else if (delta) {
        appended = delta;
      } else {
        return [];
      }

      this.assistantBuffer += appended;
      const candidate = this.assistantBuffer.trim();
      if (!candidate) return [];
      if (
        candidate.length >= ASSISTANT_FORCE_CHARS ||
        (candidate.length >= ASSISTANT_MIN_CHARS && ASSISTANT_TERMINATORS.test(candidate))
      ) {
        return this.flushAssistantBuffer();
      }
      return [];
    }

    if (event.stream === "tool") {
      const flushed = this.flushAssistantBuffer();
      const name = readString(data.name) ?? "tool";
      const phase = readString(data.phase) ?? "";
      if (phase === "result") {
        const isError = data.isError === true;
        const formatted = formatToolActivity({
          name,
          phase,
          result: data.result ?? data.meta,
          isError,
        });
        const summary = truncate(
          formatted?.result ??
            (isError ? "failed" : "completed"),
        );
        const dedupeKey = `${name}:${summary}:${isError ? "error" : "ok"}`;
        if (dedupeKey === this.lastToolResultKey) return flushed;
        this.lastToolResultKey = dedupeKey;
        if (!formatted) return flushed;
        return [...flushed, formatted];
      }
      return flushed;
    }

    if (event.stream === "error") {
      const flushed = this.flushAssistantBuffer();
      const error = truncate(readString(data.error) ?? JSON.stringify(data));
      if (!error) return flushed;
      return [...flushed, { type: "error", body: error }];
    }

    return [];
  }
}
