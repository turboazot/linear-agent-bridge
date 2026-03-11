import type { ActivityContent, AgentEventPayload } from "../types.js";
import { AgentEventReducer } from "./event-reducer.js";

export function createAgentEventToLinearMapper(params: {
  issueLabel: string;
}): (event: AgentEventPayload) => ActivityContent[] {
  const reducer = new AgentEventReducer(params.issueLabel);
  return (event) => reducer.reduce(event);
}
