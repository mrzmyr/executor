import {
  type UpsertCredentialBindingPayload,
} from "@executor-v2/management-api";
import {
  AuthConnectionSchema,
  AuthMaterialSchema,
  OAuthStateSchema,
  SourceAuthBindingSchema,
  SourceCredentialBindingSchema,
  type AuthConnection,
  type AuthConnectionStatus,
  type AuthConnectionStrategy,
  type AuthMaterial,
  type OAuthState,
  type SourceAuthBinding,
  type SourceCredentialBinding,
} from "@executor-v2/schema";
import { v } from "convex/values";
import * as Schema from "effect/Schema";

import { internal } from "../_generated/api";
import {
  currentCredentialEncryptionKeyVersion,
  decryptSecretValue,
  encryptSecretValue,
} from "../credential_crypto";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";

const runtimeInternal = internal;

const decodeAuthConnection = Schema.decodeUnknownSync(AuthConnectionSchema);
const decodeSourceAuthBinding = Schema.decodeUnknownSync(SourceAuthBindingSchema);
const decodeAuthMaterial = Schema.decodeUnknownSync(AuthMaterialSchema);
const decodeOAuthState = Schema.decodeUnknownSync(OAuthStateSchema);
const decodeCompatSourceCredentialBinding = Schema.decodeUnknownSync(
  SourceCredentialBindingSchema,
);

const credentialProviderValidator = v.union(
  v.literal("api_key"),
  v.literal("bearer"),
  v.literal("oauth2"),
  v.literal("basic"),
  v.literal("custom"),
);

const credentialSecretProviderValidator = v.literal("local");

const credentialScopeTypeValidator = v.union(
  v.literal("workspace"),
  v.literal("organization"),
  v.literal("account"),
);

const sourceCredentialBindingPayloadValidator = v.object({
  id: v.optional(v.string()),
  credentialId: v.string(),
  scopeType: credentialScopeTypeValidator,
  sourceKey: v.string(),
  provider: credentialProviderValidator,
  secretProvider: v.optional(credentialSecretProviderValidator),
  secretRef: v.string(),
  accountId: v.optional(v.union(v.string(), v.null())),
  additionalHeadersJson: v.optional(v.union(v.string(), v.null())),
  boundAuthFingerprint: v.optional(v.union(v.string(), v.null())),
  oauthRefreshToken: v.optional(v.union(v.string(), v.null())),
  oauthExpiresAt: v.optional(v.union(v.number(), v.null())),
  oauthScope: v.optional(v.union(v.string(), v.null())),
  oauthIssuer: v.optional(v.union(v.string(), v.null())),
  oauthTokenEndpoint: v.optional(v.union(v.string(), v.null())),
  oauthAuthorizationServer: v.optional(v.union(v.string(), v.null())),
  oauthClientId: v.optional(v.union(v.string(), v.null())),
  oauthClientSecret: v.optional(v.union(v.string(), v.null())),
  oauthSourceUrl: v.optional(v.union(v.string(), v.null())),
  oauthClientInformationJson: v.optional(v.union(v.string(), v.null())),
});

type ExtendedUpsertCredentialBindingPayload = UpsertCredentialBindingPayload & {
  oauthRefreshToken?: string | null;
  oauthExpiresAt?: number | null;
  oauthScope?: string | null;
  oauthIssuer?: string | null;
  oauthTokenEndpoint?: string | null;
  oauthAuthorizationServer?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  oauthSourceUrl?: string | null;
  oauthClientInformationJson?: string | null;
};

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const toStringRecord = (
  value: Record<string, unknown>,
): Record<string, string> => {
  const record: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeString(rawKey);
    const normalizedValue = normalizeString(rawValue);
    if (!key || !normalizedValue) {
      continue;
    }

    record[key] = normalizedValue;
  }

  return record;
};

const parseAdditionalHeaders = (
  additionalHeadersJson: string | null,
): Record<string, string> => {
  if (!additionalHeadersJson) {
    return {};
  }

  return toStringRecord(parseJsonObject(additionalHeadersJson));
};

const parseConnectionMetadata = (
  metadataJson: string | null,
): Record<string, unknown> => parseJsonObject(metadataJson);

const base64Encode = (value: string): string => {
  if (typeof btoa === "function") {
    return btoa(value);
  }

  const maybeBuffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (maybeBuffer) {
    return maybeBuffer.from(value, "utf8").toString("base64");
  }

  throw new Error("No base64 encoder available");
};

const strategyFromProvider = (
  provider: UpsertCredentialBindingPayload["provider"],
): AuthConnectionStrategy => {
  if (provider === "api_key") return "api_key";
  if (provider === "bearer") return "bearer";
  if (provider === "oauth2") return "oauth2";
  if (provider === "basic") return "basic";
  return "custom";
};

const providerFromStrategy = (
  strategy: AuthConnectionStrategy,
): SourceCredentialBinding["provider"] => {
  if (strategy === "api_key") return "api_key";
  if (strategy === "bearer") return "bearer";
  if (strategy === "oauth2") return "oauth2";
  if (strategy === "basic") return "basic";
  return "custom";
};

const scopeScore = (
  binding: SourceAuthBinding,
  input: {
    workspaceId: string;
    organizationId: string;
    accountId: string | null;
  },
): number => {
  if (!binding.enabled) {
    return -1;
  }

  if (binding.scopeType === "account") {
    if (!input.accountId || binding.accountId !== input.accountId) {
      return -1;
    }

    return binding.organizationId === input.organizationId ? 30 : -1;
  }

  if (binding.scopeType === "workspace") {
    return binding.workspaceId === input.workspaceId ? 20 : -1;
  }

  if (binding.scopeType === "organization") {
    return binding.organizationId === input.organizationId ? 10 : -1;
  }

  return -1;
};

const selectBestBinding = (
  bindings: ReadonlyArray<SourceAuthBinding>,
  input: {
    workspaceId: string;
    organizationId: string;
    accountId: string | null;
  },
): SourceAuthBinding | null => {
  const ranked = bindings
    .map((binding) => ({
      binding,
      score: scopeScore(binding, input),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      if (left.binding.updatedAt !== right.binding.updatedAt) {
        return right.binding.updatedAt - left.binding.updatedAt;
      }

      return right.binding.createdAt - left.binding.createdAt;
    });

  return ranked[0]?.binding ?? null;
};

const sourceIdFromSourceKey = (sourceKey: string): string | null => {
  const trimmed = sourceKey.trim();
  if (!trimmed.startsWith("source:")) {
    return null;
  }

  const sourceId = trimmed.slice("source:".length).trim();
  return sourceId.length > 0 ? sourceId : null;
};

const sourceKeyFromSourceId = (sourceId: string): string => `source:${sourceId}`;

const toAuthConnection = (document: Record<string, unknown>): AuthConnection =>
  decodeAuthConnection(stripConvexSystemFields(document));

const toSourceAuthBinding = (document: Record<string, unknown>): SourceAuthBinding =>
  decodeSourceAuthBinding(stripConvexSystemFields(document));

const toAuthMaterial = (document: Record<string, unknown>): AuthMaterial =>
  decodeAuthMaterial(stripConvexSystemFields(document));

const toOAuthState = (document: Record<string, unknown>): OAuthState =>
  decodeOAuthState(stripConvexSystemFields(document));

const resolveWorkspaceOrganizationId = async (
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<string> => {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_domainId", (q) => q.eq("id", workspaceId))
    .unique();

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  return workspace.organizationId;
};

const mergeHeaders = (...sets: ReadonlyArray<Record<string, string>>): Record<string, string> => {
  const merged: Record<string, string> = {};
  const keyByLower = new Map<string, string>();

  for (const set of sets) {
    for (const [rawKey, rawValue] of Object.entries(set)) {
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (key.length === 0 || value.length === 0) {
        continue;
      }

      const lower = key.toLowerCase();
      const existing = keyByLower.get(lower);
      if (existing && existing !== key) {
        delete merged[existing];
      }

      keyByLower.set(lower, key);
      merged[key] = value;
    }
  }

  return merged;
};

const buildSecretHeaders = (
  strategy: AuthConnectionStrategy,
  secret: string,
  metadata: Record<string, unknown>,
): Record<string, string> => {
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    return {};
  }

  if (strategy === "api_key") {
    const header = normalizeString(metadata.apiKeyHeader) ?? "x-api-key";
    return { [header]: trimmed };
  }

  if (strategy === "bearer") {
    return { Authorization: `Bearer ${trimmed}` };
  }

  if (strategy === "basic") {
    const asJson = parseJsonObject(trimmed);
    const usernameFromJson = normalizeString(asJson.username);
    const passwordFromJson = normalizeString(asJson.password);

    const pair = usernameFromJson && passwordFromJson
      ? `${usernameFromJson}:${passwordFromJson}`
      : trimmed.includes(":")
        ? trimmed
        : null;

    if (!pair) {
      return {};
    }

    return {
      Authorization: `Basic ${base64Encode(pair)}`,
    };
  }

  if (strategy === "custom") {
    const customHeaderName = normalizeString(metadata.customHeaderName);
    if (customHeaderName) {
      return { [customHeaderName]: trimmed };
    }
  }

  return {};
};

const sortCompatBindings = (
  bindings: ReadonlyArray<SourceCredentialBinding>,
): Array<SourceCredentialBinding> =>
  [...bindings].sort((left, right) => {
    const leftKey = `${left.sourceKey}:${left.provider}`.toLowerCase();
    const rightKey = `${right.sourceKey}:${right.provider}`.toLowerCase();

    if (leftKey === rightKey) {
      return left.id.localeCompare(right.id);
    }

    return leftKey.localeCompare(rightKey);
  });

const maskedSecretRef = (connection: AuthConnection): string => {
  if (connection.strategy === "oauth2") {
    if (connection.status === "reauth_required") {
      return "oauth2://reauth_required";
    }

    if (connection.status === "active") {
      return "oauth2://connected";
    }
  }

  return "********";
};

const toCompatSourceCredentialBinding = (
  binding: SourceAuthBinding,
  connection: AuthConnection,
): SourceCredentialBinding =>
  decodeCompatSourceCredentialBinding({
    id: binding.id,
    credentialId: connection.id,
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    accountId: binding.accountId,
    scopeType: binding.scopeType,
    sourceKey: sourceKeyFromSourceId(binding.sourceId),
    provider: providerFromStrategy(connection.strategy),
    secretProvider: "local",
    secretRef: maskedSecretRef(connection),
    additionalHeadersJson: connection.additionalHeadersJson,
    boundAuthFingerprint: null,
    createdAt: binding.createdAt,
    updatedAt: Math.max(binding.updatedAt, connection.updatedAt),
  });

const normalizeAuthConnectionStatus = (
  connection: AuthConnection,
): AuthConnectionStatus => {
  if (connection.status === "active") return "active";
  if (connection.status === "reauth_required") return "reauth_required";
  if (connection.status === "revoked") return "revoked";
  if (connection.status === "disabled") return "disabled";
  return "error";
};

type OAuthRefreshConfig = {
  tokenEndpoint?: string;
  authorizationServer?: string;
  clientId?: string;
  clientSecretCiphertext?: string;
  sourceUrl?: string;
  clientInformationJson?: string;
};

const parseOAuthRefreshConfig = (value: string | null): OAuthRefreshConfig => {
  if (!value) {
    return {};
  }

  const parsed = parseJsonObject(value);
  return {
    ...(normalizeString(parsed.tokenEndpoint)
      ? { tokenEndpoint: normalizeString(parsed.tokenEndpoint)! }
      : {}),
    ...(normalizeString(parsed.authorizationServer)
      ? { authorizationServer: normalizeString(parsed.authorizationServer)! }
      : {}),
    ...(normalizeString(parsed.clientId)
      ? { clientId: normalizeString(parsed.clientId)! }
      : {}),
    ...(normalizeString(parsed.clientSecretCiphertext)
      ? { clientSecretCiphertext: normalizeString(parsed.clientSecretCiphertext)! }
      : {}),
    ...(normalizeString(parsed.sourceUrl)
      ? { sourceUrl: normalizeString(parsed.sourceUrl)! }
      : {}),
    ...(normalizeString(parsed.clientInformationJson)
      ? { clientInformationJson: normalizeString(parsed.clientInformationJson)! }
      : {}),
  };
};

const encodeOAuthRefreshConfig = (config: OAuthRefreshConfig): string | null => {
  const payload: Record<string, string> = {};

  if (config.tokenEndpoint) payload.tokenEndpoint = config.tokenEndpoint;
  if (config.authorizationServer) payload.authorizationServer = config.authorizationServer;
  if (config.clientId) payload.clientId = config.clientId;
  if (config.clientSecretCiphertext) {
    payload.clientSecretCiphertext = config.clientSecretCiphertext;
  }
  if (config.sourceUrl) payload.sourceUrl = config.sourceUrl;
  if (config.clientInformationJson) {
    payload.clientInformationJson = config.clientInformationJson;
  }

  if (Object.keys(payload).length === 0) {
    return null;
  }

  return JSON.stringify(payload);
};

const oauthRefreshWindowMs = 5 * 60 * 1000;
const oauthRefreshLeaseMs = 30 * 1000;

type OAuthRefreshErrorClass =
  | "transient"
  | "invalid_grant"
  | "invalid_client"
  | "unsupported"
  | "unknown";

const classifyOAuthRefreshFailure = (
  responseStatus: number,
  payload: Record<string, unknown>,
): OAuthRefreshErrorClass => {
  const errorCode = normalizeString(payload.error)?.toLowerCase() ?? "";

  if (errorCode === "invalid_grant") {
    return "invalid_grant";
  }

  if (errorCode === "invalid_client") {
    return "invalid_client";
  }

  if (responseStatus >= 500) {
    return "transient";
  }

  if (responseStatus === 400 || responseStatus === 401 || responseStatus === 403) {
    return errorCode.length > 0 ? "unknown" : "transient";
  }

  return "unknown";
};

const readJsonResponse = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  try {
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const resolveTokenEndpointFromAuthorizationServer = async (
  authorizationServer: string,
): Promise<string | null> => {
  const normalized = normalizeString(authorizationServer);
  if (!normalized) {
    return null;
  }

  try {
    const endpoint = new URL("/.well-known/oauth-authorization-server", normalized);
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = await readJsonResponse(response);
    const tokenEndpoint = normalizeString(payload.token_endpoint);
    return tokenEndpoint ?? null;
  } catch {
    return null;
  }
};

const refreshTokenFromOAuthEndpoint = async (
  oauthState: OAuthState,
  refreshConfig: OAuthRefreshConfig,
): Promise<
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: number | null;
      scope: string | null;
      issuer: string | null;
      tokenType: string | null;
    }
  | {
      ok: false;
      errorClass: OAuthRefreshErrorClass;
      message: string;
    }
> => {
  const refreshTokenCiphertext = oauthState.refreshTokenCiphertext;
  if (!refreshTokenCiphertext) {
    return {
      ok: false,
      errorClass: "unsupported",
      message: "Refresh token is not available",
    };
  }

  const refreshToken = await decryptSecretValue(refreshTokenCiphertext);
  const clientId = normalizeString(refreshConfig.clientId);
  if (!clientId) {
    return {
      ok: false,
      errorClass: "unsupported",
      message: "OAuth client id is required to refresh token",
    };
  }

  const tokenEndpoint = normalizeString(refreshConfig.tokenEndpoint)
    ?? (refreshConfig.authorizationServer
      ? await resolveTokenEndpointFromAuthorizationServer(refreshConfig.authorizationServer)
      : null);

  if (!tokenEndpoint) {
    return {
      ok: false,
      errorClass: "unsupported",
      message: "OAuth token endpoint is not configured",
    };
  }

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", clientId);

  const clientSecretCiphertext = normalizeString(refreshConfig.clientSecretCiphertext);
  if (clientSecretCiphertext) {
    const decryptedClientSecret = await decryptSecretValue(clientSecretCiphertext);
    if (decryptedClientSecret.trim().length > 0) {
      body.set("client_secret", decryptedClientSecret.trim());
    }
  }

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (error) {
    return {
      ok: false,
      errorClass: "transient",
      message: error instanceof Error ? error.message : "OAuth refresh request failed",
    };
  }

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const errorClass = classifyOAuthRefreshFailure(response.status, payload);
    const message = normalizeString(payload.error_description)
      ?? normalizeString(payload.error)
      ?? `OAuth refresh failed (${response.status})`;
    return {
      ok: false,
      errorClass,
      message,
    };
  }

  const accessToken = normalizeString(payload.access_token);
  if (!accessToken) {
    return {
      ok: false,
      errorClass: "unknown",
      message: "OAuth refresh response is missing access_token",
    };
  }

  const maybeExpiresIn = payload.expires_in;
  const expiresAt = typeof maybeExpiresIn === "number" && Number.isFinite(maybeExpiresIn)
    ? Date.now() + Math.max(0, Math.floor(maybeExpiresIn)) * 1000
    : null;

  const refreshTokenFromResponse = normalizeString(payload.refresh_token);
  const scope = normalizeString(payload.scope) ?? oauthState.scope;
  const tokenType = normalizeString(payload.token_type) ?? oauthState.tokenType;

  return {
    ok: true,
    accessToken,
    refreshToken: refreshTokenFromResponse,
    expiresAt,
    scope,
    issuer: oauthState.issuer,
    tokenType,
  };
};

const insertAuthAuditEvent = async (
  ctx: MutationCtx,
  input: {
    organizationId: string;
    connectionId: string;
    sourceId: string | null;
    eventType: "created" | "updated" | "bound" | "unbound" | "refresh_success" | "refresh_failed" | "reauth_required" | "revoked" | "deleted";
    actorType: "system" | "account";
    actorId?: string | null;
    outcome: string;
    reasonCode?: string | null;
    detailsJson?: string | null;
    correlationId?: string | null;
  },
): Promise<void> => {
  const now = Date.now();
  await ctx.db.insert("authAuditEvents", {
    id: `auth_event_${crypto.randomUUID()}`,
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    sourceId: input.sourceId,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    outcome: input.outcome,
    reasonCode: input.reasonCode ?? null,
    detailsJson: input.detailsJson ?? null,
    correlationId: input.correlationId ?? null,
    createdAt: now,
  });
};

const loadAuthConnectionById = async (
  ctx: QueryCtx | MutationCtx,
  connectionId: string,
): Promise<AuthConnection | null> => {
  const row = await ctx.db
    .query("authConnections")
    .withIndex("by_domainId", (q) => q.eq("id", connectionId))
    .unique();

  if (!row) {
    return null;
  }

  return toAuthConnection(row as unknown as Record<string, unknown>);
};

const loadOAuthStateByConnectionId = async (
  ctx: QueryCtx | MutationCtx,
  connectionId: string,
): Promise<OAuthState | null> => {
  const row = await ctx.db
    .query("oauthState")
    .withIndex("by_connectionId", (q) => q.eq("connectionId", connectionId))
    .unique();

  if (!row) {
    return null;
  }

  return toOAuthState(row as unknown as Record<string, unknown>);
};

const loadAuthMaterialByConnectionId = async (
  ctx: QueryCtx | MutationCtx,
  connectionId: string,
): Promise<AuthMaterial | null> => {
  const row = await ctx.db
    .query("authMaterials")
    .withIndex("by_connectionId", (q) => q.eq("connectionId", connectionId))
    .unique();

  if (!row) {
    return null;
  }

  return toAuthMaterial(row as unknown as Record<string, unknown>);
};

const listBindingsForWorkspace = async (
  ctx: QueryCtx,
  input: {
    workspaceId: string;
    organizationId: string;
  },
): Promise<Array<SourceAuthBinding>> => {
  const workspaceRows = await ctx.db
    .query("sourceAuthBindings")
    .withIndex("by_workspaceId", (q) => q.eq("workspaceId", input.workspaceId))
    .collect();

  const organizationRows = await ctx.db
    .query("sourceAuthBindings")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", input.organizationId))
    .collect();

  const bindings = [...workspaceRows, ...organizationRows]
    .map((row) => toSourceAuthBinding(row as unknown as Record<string, unknown>))
    .filter((binding) =>
      binding.workspaceId === input.workspaceId
      || (binding.workspaceId === null && binding.organizationId === input.organizationId)
    );

  return Array.from(new Map(bindings.map((binding) => [binding.id, binding])).values());
};

export const listCredentialBindings = internalQuery({
  args: {
    workspaceId: v.string(),
  },
  handler: async (ctx, args): Promise<Array<SourceCredentialBinding>> => {
    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);
    const bindings = await listBindingsForWorkspace(ctx, {
      workspaceId: args.workspaceId,
      organizationId,
    });

    const compatBindings: Array<SourceCredentialBinding> = [];

    for (const binding of bindings) {
      const connection = await loadAuthConnectionById(ctx, binding.connectionId);
      if (!connection) {
        continue;
      }

      compatBindings.push(toCompatSourceCredentialBinding(binding, connection));
    }

    return sortCompatBindings(compatBindings);
  },
});

export const resolveSourceAuthSelection = internalQuery({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    accountId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    binding: SourceAuthBinding | null;
    connection: AuthConnection | null;
    oauthState: OAuthState | null;
  }> => {
    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);

    const rows = await ctx.db
      .query("sourceAuthBindings")
      .withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId))
      .collect();

    const binding = selectBestBinding(
      rows.map((row) => toSourceAuthBinding(row as unknown as Record<string, unknown>)),
      {
        workspaceId: args.workspaceId,
        organizationId,
        accountId: args.accountId ?? null,
      },
    );

    if (!binding) {
      return {
        binding: null,
        connection: null,
        oauthState: null,
      };
    }

    const connection = await loadAuthConnectionById(ctx, binding.connectionId);
    if (!connection) {
      return {
        binding: null,
        connection: null,
        oauthState: null,
      };
    }

    const oauthState = connection.strategy === "oauth2"
      ? await loadOAuthStateByConnectionId(ctx, connection.id)
      : null;

    return {
      binding,
      connection,
      oauthState,
    };
  },
});

export const beginOAuthRefresh = internalMutation({
  args: {
    connectionId: v.string(),
    leaseHolder: v.string(),
    leaseMs: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        kind: "missing";
      }
    | {
        kind: "locked";
        leaseExpiresAt: number | null;
      }
    | {
        kind: "ready";
        oauthState: OAuthState;
        connection: AuthConnection;
      }
  > => {
    const stateRow = await ctx.db
      .query("oauthState")
      .withIndex("by_connectionId", (q) => q.eq("connectionId", args.connectionId))
      .unique();
    const connectionRow = await ctx.db
      .query("authConnections")
      .withIndex("by_domainId", (q) => q.eq("id", args.connectionId))
      .unique();

    if (!stateRow || !connectionRow) {
      return { kind: "missing" };
    }

    const state = toOAuthState(stateRow as unknown as Record<string, unknown>);
    const connection = toAuthConnection(connectionRow as unknown as Record<string, unknown>);
    const now = Date.now();
    const leaseExpiresAt = state.leaseExpiresAt;
    const leaseActive =
      state.leaseHolder !== null
      && leaseExpiresAt !== null
      && leaseExpiresAt > now
      && state.leaseHolder !== args.leaseHolder;

    if (leaseActive) {
      return {
        kind: "locked",
        leaseExpiresAt,
      };
    }

    await ctx.db.patch(stateRow._id, {
      leaseHolder: args.leaseHolder,
      leaseExpiresAt: now + Math.max(1_000, Math.floor(args.leaseMs)),
      leaseFence: state.leaseFence + 1,
      lastRefreshErrorClass: null,
      lastRefreshError: null,
      updatedAt: now,
    });

    const nextState = await ctx.db
      .query("oauthState")
      .withIndex("by_connectionId", (q) => q.eq("connectionId", args.connectionId))
      .unique();

    if (!nextState) {
      return { kind: "missing" };
    }

    return {
      kind: "ready",
      oauthState: toOAuthState(nextState as unknown as Record<string, unknown>),
      connection,
    };
  },
});

export const finalizeOAuthRefreshSuccess = internalMutation({
  args: {
    connectionId: v.string(),
    leaseHolder: v.string(),
    expectedTokenVersion: v.number(),
    expectedLeaseFence: v.number(),
    accessTokenCiphertext: v.string(),
    refreshTokenCiphertext: v.optional(v.union(v.string(), v.null())),
    expiresAt: v.optional(v.union(v.number(), v.null())),
    scope: v.optional(v.union(v.string(), v.null())),
    tokenType: v.optional(v.union(v.string(), v.null())),
    issuer: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<{ committed: boolean }> => {
    const stateRow = await ctx.db
      .query("oauthState")
      .withIndex("by_connectionId", (q) => q.eq("connectionId", args.connectionId))
      .unique();
    const connectionRow = await ctx.db
      .query("authConnections")
      .withIndex("by_domainId", (q) => q.eq("id", args.connectionId))
      .unique();

    if (!stateRow || !connectionRow) {
      return { committed: false };
    }

    const state = toOAuthState(stateRow as unknown as Record<string, unknown>);
    const connection = toAuthConnection(connectionRow as unknown as Record<string, unknown>);

    if (state.leaseHolder !== args.leaseHolder) {
      return { committed: false };
    }

    if (state.tokenVersion !== args.expectedTokenVersion) {
      return { committed: false };
    }

    if (state.leaseFence !== args.expectedLeaseFence) {
      return { committed: false };
    }

    const now = Date.now();
    const nextRefreshToken = args.refreshTokenCiphertext === undefined
      ? state.refreshTokenCiphertext
      : args.refreshTokenCiphertext;

    await ctx.db.patch(stateRow._id, {
      accessTokenCiphertext: args.accessTokenCiphertext,
      refreshTokenCiphertext: nextRefreshToken,
      expiresAt: args.expiresAt !== undefined ? args.expiresAt : state.expiresAt,
      scope: args.scope !== undefined ? args.scope : state.scope,
      tokenType: args.tokenType !== undefined ? args.tokenType : state.tokenType,
      issuer: args.issuer !== undefined ? args.issuer : state.issuer,
      tokenVersion: state.tokenVersion + 1,
      leaseHolder: null,
      leaseExpiresAt: null,
      lastRefreshAt: now,
      lastRefreshErrorClass: null,
      lastRefreshError: null,
      reauthRequiredAt: null,
      updatedAt: now,
    });

    await ctx.db.patch(connectionRow._id, {
      status: "active",
      statusReason: null,
      lastAuthErrorClass: null,
      lastUsedAt: now,
      updatedAt: now,
    });

    await insertAuthAuditEvent(ctx, {
      organizationId: connection.organizationId,
      connectionId: connection.id,
      sourceId: null,
      eventType: "refresh_success",
      actorType: "system",
      outcome: "success",
    });

    return { committed: true };
  },
});

export const finalizeOAuthRefreshFailure = internalMutation({
  args: {
    connectionId: v.string(),
    leaseHolder: v.string(),
    errorClass: v.string(),
    message: v.string(),
    reauthRequired: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const stateRow = await ctx.db
      .query("oauthState")
      .withIndex("by_connectionId", (q) => q.eq("connectionId", args.connectionId))
      .unique();
    const connectionRow = await ctx.db
      .query("authConnections")
      .withIndex("by_domainId", (q) => q.eq("id", args.connectionId))
      .unique();

    if (!stateRow || !connectionRow) {
      return;
    }

    const state = toOAuthState(stateRow as unknown as Record<string, unknown>);
    const connection = toAuthConnection(connectionRow as unknown as Record<string, unknown>);

    if (state.leaseHolder !== args.leaseHolder) {
      return;
    }

    const now = Date.now();
    await ctx.db.patch(stateRow._id, {
      leaseHolder: null,
      leaseExpiresAt: null,
      lastRefreshErrorClass: args.errorClass,
      lastRefreshError: args.message,
      reauthRequiredAt: args.reauthRequired ? now : state.reauthRequiredAt,
      updatedAt: now,
    });

    await ctx.db.patch(connectionRow._id, {
      status: args.reauthRequired ? "reauth_required" : "error",
      statusReason: args.message,
      lastAuthErrorClass: args.errorClass,
      updatedAt: now,
    });

    await insertAuthAuditEvent(ctx, {
      organizationId: connection.organizationId,
      connectionId: connection.id,
      sourceId: null,
      eventType: args.reauthRequired ? "reauth_required" : "refresh_failed",
      actorType: "system",
      outcome: "failure",
      reasonCode: args.errorClass,
      detailsJson: JSON.stringify({ message: args.message }),
    });
  },
});

const refreshOAuthStateIfNeeded = async (
  ctx: any,
  input: {
    connectionId: string;
    forceRefresh: boolean;
    oauthState: OAuthState;
  },
): Promise<OAuthState | null> => {
  const now = Date.now();
  const isExpiring =
    input.oauthState.expiresAt !== null
    && input.oauthState.expiresAt <= now + oauthRefreshWindowMs;
  const shouldAttemptRefresh = input.forceRefresh || isExpiring;

  if (!shouldAttemptRefresh) {
    return input.oauthState;
  }

  const leaseHolder = `oauth_refresh_${crypto.randomUUID()}`;
  const begin = await ctx.runMutation(
    runtimeInternal.control_plane.credentials.beginOAuthRefresh,
    {
      connectionId: input.connectionId,
      leaseHolder,
      leaseMs: oauthRefreshLeaseMs,
    },
  );

  if (begin.kind === "missing") {
    return null;
  }

  if (begin.kind === "locked") {
    const fallback = await ctx.runQuery(
      runtimeInternal.control_plane.credentials.getOAuthStateByConnection,
      {
        connectionId: input.connectionId,
      },
    );
    return fallback;
  }

  const state = begin.oauthState;
  const refreshConfig = parseOAuthRefreshConfig(state.refreshConfigJson);

  const refreshed = await refreshTokenFromOAuthEndpoint(state, refreshConfig);
  if (!refreshed.ok) {
    await ctx.runMutation(
      runtimeInternal.control_plane.credentials.finalizeOAuthRefreshFailure,
      {
        connectionId: input.connectionId,
        leaseHolder,
        errorClass: refreshed.errorClass,
        message: refreshed.message,
        reauthRequired:
          refreshed.errorClass === "invalid_grant"
          || refreshed.errorClass === "invalid_client"
          || refreshed.errorClass === "unsupported",
      },
    );

    const fallback = await ctx.runQuery(
      runtimeInternal.control_plane.credentials.getOAuthStateByConnection,
      {
        connectionId: input.connectionId,
      },
    );
    return fallback;
  }

  const accessTokenCiphertext = await encryptSecretValue(refreshed.accessToken);
  const refreshTokenCiphertext = refreshed.refreshToken
    ? await encryptSecretValue(refreshed.refreshToken)
    : undefined;

  await ctx.runMutation(
    runtimeInternal.control_plane.credentials.finalizeOAuthRefreshSuccess,
    {
      connectionId: input.connectionId,
      leaseHolder,
      expectedTokenVersion: state.tokenVersion,
      expectedLeaseFence: state.leaseFence,
      accessTokenCiphertext,
      ...(refreshTokenCiphertext !== undefined
        ? { refreshTokenCiphertext }
        : {}),
      ...(refreshed.expiresAt !== null ? { expiresAt: refreshed.expiresAt } : {}),
      ...(refreshed.scope !== null ? { scope: refreshed.scope } : {}),
      ...(refreshed.tokenType !== null ? { tokenType: refreshed.tokenType } : {}),
      ...(refreshed.issuer !== null ? { issuer: refreshed.issuer } : {}),
    },
  );

  return await ctx.runQuery(
    runtimeInternal.control_plane.credentials.getOAuthStateByConnection,
    {
      connectionId: input.connectionId,
    },
  );
};

export const getOAuthStateByConnection = internalQuery({
  args: {
    connectionId: v.string(),
  },
  handler: async (ctx, args): Promise<OAuthState | null> =>
    await loadOAuthStateByConnectionId(ctx, args.connectionId),
});

export const resolveSourceCredentialHeaders = internalAction({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    accountId: v.optional(v.union(v.string(), v.null())),
    forceRefresh: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    headers: Record<string, string>;
    oauthConnectionId: string | null;
  }> => {
    const selected = await ctx.runQuery(
      runtimeInternal.control_plane.credentials.resolveSourceAuthSelection,
      {
        workspaceId: args.workspaceId,
        sourceId: args.sourceId,
        accountId: args.accountId ?? null,
      },
    );

    if (!selected.binding || !selected.connection) {
      return {
        headers: {},
        oauthConnectionId: null,
      };
    }

    const connection = selected.connection;
    const connectionStatus = normalizeAuthConnectionStatus(connection);
    if (connectionStatus !== "active") {
      return {
        headers: {},
        oauthConnectionId: connection.strategy === "oauth2" ? connection.id : null,
      };
    }

    const metadata = parseConnectionMetadata(connection.metadataJson);
    const additionalHeaders = parseAdditionalHeaders(connection.additionalHeadersJson);

    if (connection.strategy === "oauth2") {
      let oauthState = selected.oauthState;
      if (!oauthState) {
        return {
          headers: additionalHeaders,
          oauthConnectionId: connection.id,
        };
      }

      oauthState = await refreshOAuthStateIfNeeded(ctx, {
        connectionId: connection.id,
        forceRefresh: args.forceRefresh === true,
        oauthState,
      });

      if (!oauthState) {
        return {
          headers: additionalHeaders,
          oauthConnectionId: connection.id,
        };
      }

      const now = Date.now();
      if (oauthState.expiresAt !== null && oauthState.expiresAt <= now) {
        return {
          headers: additionalHeaders,
          oauthConnectionId: connection.id,
        };
      }

      const accessToken = await decryptSecretValue(oauthState.accessTokenCiphertext);
      const oauthHeaders = accessToken.trim().length > 0
        ? ({ Authorization: `Bearer ${accessToken}` } as Record<string, string>)
        : {};

      return {
        headers: mergeHeaders(oauthHeaders, additionalHeaders),
        oauthConnectionId: connection.id,
      };
    }

    const material = await ctx.runQuery(
      runtimeInternal.control_plane.credentials.getAuthMaterialByConnection,
      {
        connectionId: connection.id,
      },
    );

    if (!material) {
      return {
        headers: additionalHeaders,
        oauthConnectionId: null,
      };
    }

    const secret = await decryptSecretValue(material.ciphertext);
    const strategyHeaders = buildSecretHeaders(connection.strategy, secret, metadata);

    return {
      headers: mergeHeaders(strategyHeaders, additionalHeaders),
      oauthConnectionId: null,
    };
  },
});

export const getAuthMaterialByConnection = internalQuery({
  args: {
    connectionId: v.string(),
  },
  handler: async (ctx, args): Promise<AuthMaterial | null> =>
    await loadAuthMaterialByConnectionId(ctx, args.connectionId),
});

const coerceScopeOwnerType = (
  scopeType: SourceCredentialBinding["scopeType"],
): AuthConnection["ownerType"] => {
  if (scopeType === "organization") return "organization";
  if (scopeType === "account") return "account";
  return "workspace";
};

const buildOAuthRefreshConfigFromPayload = (
  payload: ExtendedUpsertCredentialBindingPayload,
  existing: OAuthRefreshConfig,
  encryptedClientSecret: string | null,
): OAuthRefreshConfig => ({
  tokenEndpoint:
    normalizeString(payload.oauthTokenEndpoint)
    ?? existing.tokenEndpoint,
  authorizationServer:
    normalizeString(payload.oauthAuthorizationServer)
    ?? existing.authorizationServer,
  clientId: normalizeString(payload.oauthClientId) ?? existing.clientId,
  clientSecretCiphertext:
    encryptedClientSecret
    ?? existing.clientSecretCiphertext,
  sourceUrl: normalizeString(payload.oauthSourceUrl) ?? existing.sourceUrl,
  clientInformationJson:
    normalizeString(payload.oauthClientInformationJson)
    ?? existing.clientInformationJson,
});

export const upsertCredentialBindingRecord = internalMutation({
  args: {
    workspaceId: v.string(),
    payload: sourceCredentialBindingPayloadValidator,
    secretCiphertext: v.string(),
    oauthRefreshCiphertext: v.optional(v.union(v.string(), v.null())),
    oauthClientSecretCiphertext: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args): Promise<SourceCredentialBinding> => {
    const payload = args.payload as ExtendedUpsertCredentialBindingPayload;
    const now = Date.now();
    const sourceId = sourceIdFromSourceKey(payload.sourceKey);
    if (!sourceId) {
      throw new Error("Credentials require sourceKey in the form 'source:<id>'");
    }

    if (payload.scopeType === "account" && payload.accountId === null) {
      throw new Error("Account scope credentials require accountId");
    }

    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);

    const existingBindingRow = payload.id
      ? await ctx.db
          .query("sourceAuthBindings")
          .withIndex("by_domainId", (q) => q.eq("id", payload.id!))
          .unique()
      : null;
    const existingBinding = existingBindingRow
      ? toSourceAuthBinding(existingBindingRow as unknown as Record<string, unknown>)
      : null;

    const scopeWorkspaceId = payload.scopeType === "workspace" ? args.workspaceId : null;
    const scopeAccountId = payload.scopeType === "account" ? (payload.accountId ?? null) : null;

    const resolvedBindingId = existingBinding?.id
      ?? payload.id
      ?? (() => {
        return `auth_binding_${crypto.randomUUID()}`;
      })();

    const requestedConnectionId = normalizeString(payload.credentialId)
      ?? existingBinding?.connectionId
      ?? `conn_${crypto.randomUUID()}`;

    const existingConnectionRow = await ctx.db
      .query("authConnections")
      .withIndex("by_domainId", (q) => q.eq("id", requestedConnectionId))
      .unique();
    const existingConnection = existingConnectionRow
      ? toAuthConnection(existingConnectionRow as unknown as Record<string, unknown>)
      : null;

    if (existingConnection && existingConnection.organizationId !== organizationId) {
      throw new Error("Connection id belongs to another organization");
    }

    const nextConnection = decodeAuthConnection({
      id: requestedConnectionId,
      organizationId,
      workspaceId: scopeWorkspaceId,
      accountId: scopeAccountId,
      ownerType: coerceScopeOwnerType(payload.scopeType),
      strategy: strategyFromProvider(payload.provider),
      displayName:
        normalizeString(existingConnection?.displayName)
        ?? sourceKeyFromSourceId(sourceId),
      status: "active",
      statusReason: null,
      lastAuthErrorClass: null,
      metadataJson: existingConnection?.metadataJson ?? null,
      additionalHeadersJson:
        payload.additionalHeadersJson !== undefined
          ? payload.additionalHeadersJson
          : existingConnection?.additionalHeadersJson ?? null,
      createdByAccountId: existingConnection?.createdByAccountId ?? null,
      createdAt: existingConnection?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existingConnection?.lastUsedAt ?? null,
    });

    if (existingConnectionRow) {
      await ctx.db.patch(existingConnectionRow._id, nextConnection);
    } else {
      await ctx.db.insert("authConnections", nextConnection);
    }

    const nextBinding = decodeSourceAuthBinding({
      id: resolvedBindingId,
      sourceId,
      connectionId: requestedConnectionId,
      organizationId,
      workspaceId: scopeWorkspaceId,
      accountId: scopeAccountId,
      scopeType: payload.scopeType,
      selector: existingBinding?.selector ?? null,
      enabled: true,
      createdAt: existingBinding?.createdAt ?? now,
      updatedAt: now,
    });

    if (existingBindingRow) {
      await ctx.db.patch(existingBindingRow._id, nextBinding);
    } else {
      await ctx.db.insert("sourceAuthBindings", nextBinding);
    }

    if (nextConnection.strategy === "oauth2") {
      const existingOAuthRow = await ctx.db
        .query("oauthState")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", requestedConnectionId))
        .unique();
      const existingOAuth = existingOAuthRow
        ? toOAuthState(existingOAuthRow as unknown as Record<string, unknown>)
        : null;

      const existingRefreshConfig = existingOAuth
        ? parseOAuthRefreshConfig(existingOAuth.refreshConfigJson)
        : {};
      const refreshConfig = buildOAuthRefreshConfigFromPayload(
        payload,
        existingRefreshConfig,
        args.oauthClientSecretCiphertext ?? null,
      );
      const refreshConfigJson = encodeOAuthRefreshConfig(refreshConfig);

      const oauthState = decodeOAuthState({
        id: existingOAuth?.id ?? `oauth_state_${crypto.randomUUID()}`,
        connectionId: requestedConnectionId,
        accessTokenCiphertext: args.secretCiphertext,
        refreshTokenCiphertext:
          args.oauthRefreshCiphertext !== undefined
            ? args.oauthRefreshCiphertext
            : existingOAuth?.refreshTokenCiphertext ?? null,
        keyVersion: currentCredentialEncryptionKeyVersion(),
        expiresAt:
          payload.oauthExpiresAt !== undefined
            ? payload.oauthExpiresAt
            : existingOAuth?.expiresAt ?? null,
        scope:
          payload.oauthScope !== undefined
            ? payload.oauthScope
            : existingOAuth?.scope ?? null,
        tokenType: existingOAuth?.tokenType ?? "Bearer",
        issuer:
          payload.oauthIssuer !== undefined
            ? payload.oauthIssuer
            : existingOAuth?.issuer ?? null,
        refreshConfigJson,
        tokenVersion: (existingOAuth?.tokenVersion ?? 0) + 1,
        leaseHolder: null,
        leaseExpiresAt: null,
        leaseFence: existingOAuth?.leaseFence ?? 0,
        lastRefreshAt: existingOAuth?.lastRefreshAt ?? null,
        lastRefreshErrorClass: null,
        lastRefreshError: null,
        reauthRequiredAt: null,
        createdAt: existingOAuth?.createdAt ?? now,
        updatedAt: now,
      });

      if (existingOAuthRow) {
        await ctx.db.patch(existingOAuthRow._id, oauthState);
      } else {
        await ctx.db.insert("oauthState", oauthState);
      }

      const existingMaterialRow = await ctx.db
        .query("authMaterials")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", requestedConnectionId))
        .unique();
      if (existingMaterialRow) {
        await ctx.db.delete(existingMaterialRow._id);
      }
    } else {
      const existingMaterialRow = await ctx.db
        .query("authMaterials")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", requestedConnectionId))
        .unique();
      const existingMaterial = existingMaterialRow
        ? toAuthMaterial(existingMaterialRow as unknown as Record<string, unknown>)
        : null;

      const material = decodeAuthMaterial({
        id: existingMaterial?.id ?? `auth_material_${crypto.randomUUID()}`,
        connectionId: requestedConnectionId,
        ciphertext: args.secretCiphertext,
        keyVersion: currentCredentialEncryptionKeyVersion(),
        createdAt: existingMaterial?.createdAt ?? now,
        updatedAt: now,
      });

      if (existingMaterialRow) {
        await ctx.db.patch(existingMaterialRow._id, material);
      } else {
        await ctx.db.insert("authMaterials", material);
      }

      const existingOAuthRow = await ctx.db
        .query("oauthState")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", requestedConnectionId))
        .unique();
      if (existingOAuthRow) {
        await ctx.db.delete(existingOAuthRow._id);
      }
    }

    await insertAuthAuditEvent(ctx, {
      organizationId,
      connectionId: requestedConnectionId,
      sourceId,
      eventType: existingConnection ? "updated" : "created",
      actorType: "system",
      outcome: "success",
    });

    await insertAuthAuditEvent(ctx, {
      organizationId,
      connectionId: requestedConnectionId,
      sourceId,
      eventType: "bound",
      actorType: "system",
      outcome: "success",
    });

    return toCompatSourceCredentialBinding(nextBinding, nextConnection);
  },
});

export const upsertCredentialBinding = internalAction({
  args: {
    workspaceId: v.string(),
    payload: sourceCredentialBindingPayloadValidator,
  },
  handler: async (ctx, args): Promise<SourceCredentialBinding> => {
    const payload = args.payload as ExtendedUpsertCredentialBindingPayload;
    const requestedSecretRef = payload.secretRef.trim();
    if (requestedSecretRef.length === 0) {
      throw new Error("Credential secret is required");
    }

    const encryptedSecretRef = await encryptSecretValue(requestedSecretRef);
    const refreshToken = normalizeString(payload.oauthRefreshToken);
    const encryptedOauthRefreshToken = refreshToken
      ? await encryptSecretValue(refreshToken)
      : payload.oauthRefreshToken !== undefined
        ? null
        : undefined;

    const clientSecret = normalizeString(payload.oauthClientSecret);
    const encryptedOauthClientSecret = clientSecret
      ? await encryptSecretValue(clientSecret)
      : payload.oauthClientSecret !== undefined
        ? null
        : undefined;

    return await ctx.runMutation(
      runtimeInternal.control_plane.credentials.upsertCredentialBindingRecord,
      {
        workspaceId: args.workspaceId,
        payload,
        secretCiphertext: encryptedSecretRef,
        ...(encryptedOauthRefreshToken !== undefined
          ? { oauthRefreshCiphertext: encryptedOauthRefreshToken }
          : {}),
        ...(encryptedOauthClientSecret !== undefined
          ? { oauthClientSecretCiphertext: encryptedOauthClientSecret }
          : {}),
      },
    );
  },
});

export const removeCredentialBinding = internalMutation({
  args: {
    workspaceId: v.string(),
    credentialBindingId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    removed: boolean;
  }> => {
    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);

    const bindingRow = await ctx.db
      .query("sourceAuthBindings")
      .withIndex("by_domainId", (q) => q.eq("id", args.credentialBindingId))
      .unique();

    if (!bindingRow) {
      return { removed: false };
    }

    const binding = toSourceAuthBinding(bindingRow as unknown as Record<string, unknown>);
    if (
      binding.workspaceId !== args.workspaceId
      && !(binding.workspaceId === null && binding.organizationId === organizationId)
    ) {
      return { removed: false };
    }

    await ctx.db.delete(bindingRow._id);

    const remainingBindings = await ctx.db
      .query("sourceAuthBindings")
      .withIndex("by_connectionId", (q) => q.eq("connectionId", binding.connectionId))
      .collect();

    const connectionRow = await ctx.db
      .query("authConnections")
      .withIndex("by_domainId", (q) => q.eq("id", binding.connectionId))
      .unique();

    if (remainingBindings.length === 0) {
      const materialRow = await ctx.db
        .query("authMaterials")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", binding.connectionId))
        .unique();
      if (materialRow) {
        await ctx.db.delete(materialRow._id);
      }

      const oauthRow = await ctx.db
        .query("oauthState")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", binding.connectionId))
        .unique();
      if (oauthRow) {
        await ctx.db.delete(oauthRow._id);
      }

      if (connectionRow) {
        await ctx.db.delete(connectionRow._id);
      }
    }

    if (connectionRow) {
      const connection = toAuthConnection(connectionRow as unknown as Record<string, unknown>);
      await insertAuthAuditEvent(ctx, {
        organizationId: connection.organizationId,
        connectionId: connection.id,
        sourceId: binding.sourceId,
        eventType: "unbound",
        actorType: "system",
        outcome: "success",
      });

      if (remainingBindings.length === 0) {
        await insertAuthAuditEvent(ctx, {
          organizationId: connection.organizationId,
          connectionId: connection.id,
          sourceId: null,
          eventType: "deleted",
          actorType: "system",
          outcome: "success",
        });
      }
    }

    return { removed: true };
  },
});

export const removeSourceAuthBindings = internalMutation({
  args: {
    sourceId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const rows = await ctx.db
      .query("sourceAuthBindings")
      .withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId))
      .collect();

    const bindingIds = rows.map((row) => (row as unknown as { id: string }).id);

    for (const bindingId of bindingIds) {
      const row = await ctx.db
        .query("sourceAuthBindings")
        .withIndex("by_domainId", (q) => q.eq("id", bindingId))
        .unique();
      if (!row) {
        continue;
      }

      const binding = toSourceAuthBinding(row as unknown as Record<string, unknown>);
      await ctx.db.delete(row._id);

      const remaining = await ctx.db
        .query("sourceAuthBindings")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", binding.connectionId))
        .collect();
      if (remaining.length > 0) {
        continue;
      }

      const material = await ctx.db
        .query("authMaterials")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", binding.connectionId))
        .unique();
      if (material) {
        await ctx.db.delete(material._id);
      }

      const oauth = await ctx.db
        .query("oauthState")
        .withIndex("by_connectionId", (q) => q.eq("connectionId", binding.connectionId))
        .unique();
      if (oauth) {
        await ctx.db.delete(oauth._id);
      }

      const connection = await ctx.db
        .query("authConnections")
        .withIndex("by_domainId", (q) => q.eq("id", binding.connectionId))
        .unique();
      if (connection) {
        await ctx.db.delete(connection._id);
      }
    }
  },
});
