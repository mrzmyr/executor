import { createRemoteJWKSet, jwtVerify } from "jose";

import { httpAction } from "./_generated/server";

export const MCP_PATH = "/v1/mcp";

type McpAuthConfig = {
  required: boolean;
  enabled: boolean;
  authorizationServer: string | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
};

type VerifiedMcpToken = {
  provider: "workos";
  subject: string;
};

const isTruthyEnvValue = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const mcpAuthRequired = (): boolean => {
  const deploymentMode = (process.env.EXECUTOR_DEPLOYMENT_MODE ?? "").trim().toLowerCase();
  if (
    deploymentMode === "cloud"
    || deploymentMode === "hosted"
    || deploymentMode === "production"
    || deploymentMode === "prod"
  ) {
    return true;
  }

  if (
    deploymentMode === "self-hosted"
    || deploymentMode === "self_hosted"
    || deploymentMode === "selfhosted"
  ) {
    return false;
  }

  return isTruthyEnvValue(process.env.EXECUTOR_ENFORCE_MCP_AUTH);
};

const getMcpAuthorizationServer = (): string | null =>
  process.env.MCP_AUTHORIZATION_SERVER
  ?? process.env.MCP_AUTHORIZATION_SERVER_URL
  ?? process.env.WORKOS_AUTHKIT_ISSUER
  ?? process.env.WORKOS_AUTHKIT_DOMAIN
  ?? null;

export const getMcpAuthConfig = (): McpAuthConfig => {
  const required = mcpAuthRequired();
  const authorizationServer = getMcpAuthorizationServer();

  if (!authorizationServer) {
    return {
      required,
      enabled: false,
      authorizationServer: null,
      jwks: null,
    };
  }

  return {
    required,
    enabled: true,
    authorizationServer,
    jwks: createRemoteJWKSet(new URL("/oauth2/jwks", authorizationServer)),
  };
};

const parseBearerToken = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
};

const resourceMetadataUrl = (request: Request): string => {
  const url = new URL(request.url);
  const metadata = new URL("/.well-known/oauth-protected-resource", url.origin);
  metadata.search = url.search;

  const resource = new URL(url.pathname, url.origin);
  resource.search = url.search;
  metadata.searchParams.set("resource", resource.toString());

  return metadata.toString();
};

export const unauthorizedMcpResponse = (request: Request, message: string): Response => {
  const challenge = [
    'Bearer error="unauthorized"',
    'error_description="Authorization needed"',
    `resource_metadata="${resourceMetadataUrl(request)}"`,
  ].join(", ");

  return Response.json(
    { error: message },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": challenge,
      },
    },
  );
};

export const verifyMcpToken = async (
  request: Request,
  config: McpAuthConfig,
): Promise<VerifiedMcpToken | null> => {
  if (!config.enabled || !config.jwks || !config.authorizationServer) {
    return null;
  }

  const token = parseBearerToken(request);
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, config.jwks, {
      issuer: config.authorizationServer,
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }

    const providerClaim = typeof payload.provider === "string" ? payload.provider : undefined;
    if (providerClaim === "anonymous") {
      return null;
    }

    return {
      provider: "workos",
      subject: payload.sub,
    };
  } catch (error) {
    console.error("MCP token verification failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
};

const errorResponseForMissingConfig = (config: McpAuthConfig): Response =>
  Response.json(
    {
      error: config.required
        ? "MCP OAuth must be configured for cloud deployments"
        : "MCP OAuth is not configured",
    },
    { status: config.required ? 503 : 404 },
  );

export const oauthProtectedResourceHandler = httpAction(async (_ctx, request) => {
  const config = getMcpAuthConfig();
  if (!config.enabled || !config.authorizationServer) {
    return errorResponseForMissingConfig(config);
  }

  const url = new URL(request.url);
  let resource = new URL(MCP_PATH, url.origin);
  resource.search = url.search;

  const resourceHint = url.searchParams.get("resource");
  if (resourceHint) {
    try {
      const parsed = new URL(resourceHint);
      if (parsed.origin !== url.origin) {
        return Response.json({ error: "resource hint origin must match this server" }, { status: 400 });
      }

      if (parsed.pathname === MCP_PATH) {
        resource = new URL(MCP_PATH, url.origin);
        resource.search = parsed.search;
      }
    } catch {
      return Response.json({ error: "Invalid resource hint" }, { status: 400 });
    }
  }

  return Response.json({
    resource: resource.toString(),
    authorization_servers: [config.authorizationServer],
    bearer_methods_supported: ["header"],
  });
});

export const oauthAuthorizationServerHandler = httpAction(async (_ctx, _request) => {
  const config = getMcpAuthConfig();
  if (!config.enabled || !config.authorizationServer) {
    return errorResponseForMissingConfig(config);
  }

  const upstream = new URL("/.well-known/oauth-authorization-server", config.authorizationServer);
  const response = await fetch(upstream.toString(), {
    headers: {
      accept: "application/json",
    },
  });

  const body = await response.text();

  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
});
