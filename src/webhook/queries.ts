import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { callLinear } from "../linear-client.js";
import { ISSUE_DETAIL_QUERY } from "../graphql/queries.js";
import { readObject, readString } from "../util.js";

export async function fetchIssueDetail(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
): Promise<{
  identifier: string;
  title: string;
  url: string;
  description: string;
  teamId: string;
  teamKey: string;
  projectId: string;
  projectKey: string;
} | null> {
  if (!issueId) return null;
  const result = await callLinear(api, cfg, "issue(detail)", {
    query: ISSUE_DETAIL_QUERY,
    variables: { id: issueId },
  });
  if (!result.ok) return null;
  const issue = readObject(result.data?.issue);
  if (!issue) return null;
  const team = readObject(issue.team);
  const project = readObject(issue.project);
  return {
    identifier: readString(issue.identifier) ?? "",
    title: readString(issue.title) ?? "",
    url: readString(issue.url) ?? "",
    description: readString(issue.description) ?? "",
    teamId: readString(team?.id) ?? "",
    teamKey: readString(team?.key) ?? "",
    projectId: readString(project?.id) ?? "",
    projectKey: readString(project?.key) ?? "",
  };
}
