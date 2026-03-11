import { basename } from "node:path";

import type { ActivityContent } from "../types.js";
import { readObject, readString } from "../util.js";

const MUTATING_TOOL_NAME = /(write|edit|patch|apply|create|delete|update|rename|move|commit)/i;
const QUIET_TOOL_NAME = /^(read|search|find|grep|glob|ls|list|stat|pwd)$/i;

function truncate(text: string, max = 240): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function asBasename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  return basename(trimmed);
}

function collectPathCandidates(value: unknown): string[] {
  const object = readObject(value);
  if (!object) return [];

  const direct = [
    readString(object.filePath),
    readString(object.path),
    readString(object.targetPath),
    readString(object.destinationPath),
    readString(object.newPath),
    readString(object.oldPath),
  ].filter((item): item is string => Boolean(item?.trim()));

  const content = Array.isArray(object.content) ? object.content : [];
  for (const entry of content) {
    const entryObject = readObject(entry);
    if (!entryObject) continue;
    const maybeText = readString(entryObject.text);
    if (!maybeText) continue;
    const match = maybeText.match(/\/[^\s"']+\.[A-Za-z0-9._-]+/);
    if (match) direct.push(match[0]);
  }

  return direct;
}

function summarizeEditLikeResult(name: string, result: unknown): ActivityContent | null {
  const candidates = collectPathCandidates(result);
  const file = asBasename(candidates[0]);
  const label = file ? `Updated ${file}` : "Updated files";
  return {
    type: "action",
    action: name,
    parameter: file ?? "files",
    result: label,
  };
}

function summarizeBashResult(name: string, result: unknown, isError: boolean): ActivityContent | null {
  if (isError) {
    const object = readObject(result);
    const stderr = truncate(
      readString(object?.stderr) ??
        readString(object?.error) ??
        readString(object?.message) ??
        "",
    );
    return {
      type: "action",
      action: name,
      parameter: "failed",
      result: stderr || "Command failed",
    };
  }
  return null;
}

function summarizeFallback(name: string, result: unknown, isError: boolean): ActivityContent | null {
  if (!isError) return null;
  const object = readObject(result);
  const text = truncate(
    readString(object?.error) ??
      readString(object?.message) ??
      readString(object?.stderr) ??
      "",
  );
  return {
    type: "action",
    action: name,
    parameter: "failed",
    result: text || "Tool failed",
  };
}

export function formatToolActivity(params: {
  name: string;
  phase: string;
  result: unknown;
  isError: boolean;
}): ActivityContent | null {
  const { name, phase, result, isError } = params;
  if (phase !== "result") return null;
  if (!isError && QUIET_TOOL_NAME.test(name)) return null;

  if (/^(edit|write|apply_patch|patch|create|delete|rename|move|update)$/i.test(name)) {
    return summarizeEditLikeResult(name, result);
  }

  if (/^(bash|exec|command)$/i.test(name)) {
    return summarizeBashResult(name, result, isError);
  }

  if (!isError && !MUTATING_TOOL_NAME.test(name)) return null;
  return summarizeFallback(name, result, isError);
}
