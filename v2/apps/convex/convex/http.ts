import { httpRouter } from "convex/server";

import { controlPlaneHttpHandler } from "./controlPlane";
import { mcpHandler } from "./mcp";
import {
  oauthAuthorizationServerHandler,
  oauthProtectedResourceHandler,
} from "./mcp_auth";
import { handleToolCallHttp } from "./runtimeCallbacks";

const http = httpRouter();

http.route({ path: "/v1/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/v1/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/v1/mcp", method: "DELETE", handler: mcpHandler });
http.route({
  path: "/.well-known/oauth-protected-resource",
  method: "GET",
  handler: oauthProtectedResourceHandler,
});
http.route({
  path: "/.well-known/oauth-authorization-server",
  method: "GET",
  handler: oauthAuthorizationServerHandler,
});
http.route({
  path: "/v1/runtime/tool-call",
  method: "POST",
  handler: handleToolCallHttp,
});
http.route({
  pathPrefix: "/v1/",
  method: "GET",
  handler: controlPlaneHttpHandler,
});
http.route({
  pathPrefix: "/v1/",
  method: "POST",
  handler: controlPlaneHttpHandler,
});
http.route({
  pathPrefix: "/v1/",
  method: "PUT",
  handler: controlPlaneHttpHandler,
});
http.route({
  pathPrefix: "/v1/",
  method: "PATCH",
  handler: controlPlaneHttpHandler,
});
http.route({
  pathPrefix: "/v1/",
  method: "DELETE",
  handler: controlPlaneHttpHandler,
});
http.route({
  pathPrefix: "/v1/",
  method: "OPTIONS",
  handler: controlPlaneHttpHandler,
});

export default http;
