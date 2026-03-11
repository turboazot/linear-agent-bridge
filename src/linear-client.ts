import type {
  OpenClawPluginApi,
  PluginConfig,
  LinearCallResult,
} from "./types.js";
import { readObject, readString } from "./util.js";
import { getStoredAccessToken, refreshStoredToken } from "./oauth/refresh.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_TIMEOUT_MS = 15_000;

const warnRef = { value: false };
const viewerRef: { value?: string } = {};

export async function callLinear(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  label: string,
  body: { query: string; variables: Record<string, unknown> },
): Promise<LinearCallResult> {
  const timeoutMs = cfg.linearRequestTimeoutMs ?? DEFAULT_LINEAR_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let token = cfg.linearApiKey;
  if (!token) {
    const stored = await getStoredAccessToken(cfg.linearTokenStorePath);
    token = stored?.accessToken;
  }
  if (!token) {
    warnMissingApiKey(api);
    return { ok: false, error: "missing-token" };
  }
  let res = await fetch(LINEAR_API_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }).catch(() => null);

  // Try one refresh cycle if OAuth credentials are configured.
  if (res?.status === 401 && !cfg.linearApiKey) {
    const refreshed = await refreshStoredToken(api, {
      tokenStorePath: cfg.linearTokenStorePath,
      clientId: cfg.linearOauthClientId,
      clientSecret: cfg.linearOauthClientSecret,
    });
    if (refreshed?.accessToken) {
      token = refreshed.accessToken;
      res = await fetch(LINEAR_API_URL, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }).catch(() => null);
    }
  }

  if (!res) {
    api.logger.warn?.(`linear ${label} failed: fetch error`);
    return { ok: false, error: "fetch error" };
  }
  if (!res.ok) {
    const detail = await res.text();
    api.logger.warn?.(`linear ${label} failed (${res.status}): ${detail}`);
    return { ok: false, status: res.status, error: detail || `http-${res.status}` };
  }
  const json = await res.json().catch(() => null);
  const root = readObject(json);
  if (!root) {
    api.logger.warn?.(`linear ${label} invalid response`);
    return { ok: false, status: res.status, error: "invalid response" };
  }
  const errors = root.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = (errors as unknown[])
      .map((item) => readString(readObject(item)?.message) ?? "error")
      .filter(Boolean)
      .join("; ");
    api.logger.warn?.(`linear ${label} failed: ${detail}`);
    return { ok: false, status: res.status, error: detail || "graphql error" };
  }
  const data = readObject(root.data);
  if (!data) {
    api.logger.warn?.(`linear ${label} missing data`);
    return { ok: false, status: res.status, error: "missing data" };
  }
  return { ok: true, data };
}

export async function resolveViewer(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
): Promise<string> {
  const { VIEWER_QUERY } = await import("./graphql/queries.js");
  const result = await callLinear(api, cfg, "viewer", {
    query: VIEWER_QUERY,
    variables: {},
  });
  if (!result.ok) return "";
  const viewer = readObject(result.data!.viewer);
  const id = readString(viewer?.id) ?? "";
  if (id) viewerRef.value = id;
  return id || viewerRef.value || "";
}

function warnMissingApiKey(api: OpenClawPluginApi): void {
  if (warnRef.value) return;
  warnRef.value = true;
  api.logger.warn?.(
    "linear API token missing; set linearApiKey or configure OAuth exchange + token store",
  );
}
