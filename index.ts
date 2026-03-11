import type { OpenClawPluginApi } from "./src/types.js";
import { createLinearWebhook } from "./src/webhook/handler.js";
import { createApiRouter } from "./src/api/router.js";
import { createLinearOauthRoute } from "./src/oauth/route.js";

// Side-effect imports: register all API endpoint handlers
import "./src/api/issue-ops.js";
import "./src/api/activity-ops.js";
import "./src/api/session-ops.js";
import "./src/api/delegation-ops.js";
import "./src/api/query-ops.js";

export default function register(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/plugins/linear/linear",
    auth: "plugin",
    handler: createLinearWebhook(api),
  });

  api.registerHttpRoute({
    path: "/plugins/linear/api",
    auth: "plugin",
    handler: createApiRouter(api),
  });

  api.registerHttpRoute({
    path: "/plugins/linear/oauth/callback",
    auth: "plugin",
    handler: createLinearOauthRoute(api),
  });

  api.registerHttpRoute({
    path: "/plugins/linear/oauth/exchange",
    auth: "plugin",
    handler: createLinearOauthRoute(api),
  });
}
