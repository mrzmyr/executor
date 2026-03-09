import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import * as Effect from "effect/Effect";

const serializeJson = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
};

const decodeJson = <A>(input: {
  value: string | null;
  fallback: A;
}): A => {
  if (input.value === null) {
    return input.fallback;
  }

  try {
    return JSON.parse(input.value) as A;
  } catch {
    return input.fallback;
  }
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const createClientMetadata = (redirectUrl: string) => ({
  redirect_uris: [redirectUrl],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_name: "Executor Local",
});

export type McpOAuthStartResult = {
  authorizationUrl: string;
  codeVerifier: string;
  resourceMetadataUrl: string | null;
  authorizationServerUrl: string | null;
  resourceMetadataJson: string | null;
  authorizationServerMetadataJson: string | null;
  clientInformationJson: string | null;
};

export type McpOAuthSession = {
  endpoint: string;
  redirectUrl: string;
  codeVerifier: string;
  resourceMetadataUrl: string | null;
  authorizationServerUrl: string | null;
  resourceMetadataJson: string | null;
  authorizationServerMetadataJson: string | null;
  clientInformationJson: string | null;
};

export type McpOAuthExchangeResult = {
  tokens: OAuthTokens;
  resourceMetadataUrl: string | null;
  authorizationServerUrl: string | null;
  resourceMetadataJson: string | null;
  authorizationServerMetadataJson: string | null;
  clientInformationJson: string | null;
};

export const startMcpOAuthAuthorization = (input: {
  endpoint: string;
  redirectUrl: string;
  state: string;
}): Effect.Effect<McpOAuthStartResult, Error, never> =>
  Effect.gen(function* () {
    const captured: {
      authorizationUrl?: URL;
      codeVerifier?: string;
      discoveryState?: OAuthDiscoveryState;
      clientInformation?: OAuthClientInformationMixed;
    } = {};

    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return input.redirectUrl;
      },
      get clientMetadata() {
        return createClientMetadata(input.redirectUrl);
      },
      state: () => input.state,
      clientInformation: () => captured.clientInformation,
      saveClientInformation: (clientInformation) => {
        captured.clientInformation = clientInformation;
      },
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: (authorizationUrl) => {
        captured.authorizationUrl = authorizationUrl;
      },
      saveCodeVerifier: (codeVerifier) => {
        captured.codeVerifier = codeVerifier;
      },
      codeVerifier: () => {
        if (!captured.codeVerifier) {
          throw new Error("OAuth code verifier was not captured");
        }

        return captured.codeVerifier;
      },
      saveDiscoveryState: (state) => {
        captured.discoveryState = state;
      },
      discoveryState: () => captured.discoveryState,
    };

    const result = yield* Effect.tryPromise({
      try: () =>
        auth(provider, {
          serverUrl: input.endpoint,
        }),
      catch: toError,
    });

    if (result !== "REDIRECT" || !captured.authorizationUrl || !captured.codeVerifier) {
      return yield* Effect.fail(
        new Error("OAuth flow did not produce an authorization redirect"),
      );
    }

    return {
      authorizationUrl: captured.authorizationUrl.toString(),
      codeVerifier: captured.codeVerifier,
      resourceMetadataUrl: captured.discoveryState?.resourceMetadataUrl ?? null,
      authorizationServerUrl: captured.discoveryState?.authorizationServerUrl ?? null,
      resourceMetadataJson: serializeJson(captured.discoveryState?.resourceMetadata),
      authorizationServerMetadataJson: serializeJson(
        captured.discoveryState?.authorizationServerMetadata,
      ),
      clientInformationJson: serializeJson(captured.clientInformation),
    } satisfies McpOAuthStartResult;
  });

export const exchangeMcpOAuthAuthorizationCode = (input: {
  session: McpOAuthSession;
  code: string;
}): Effect.Effect<McpOAuthExchangeResult, Error, never> =>
  Effect.gen(function* () {
    const captured: {
      tokens?: OAuthTokens;
      discoveryState?: OAuthDiscoveryState;
      clientInformation?: OAuthClientInformationMixed;
    } = {
      discoveryState: {
        authorizationServerUrl:
          input.session.authorizationServerUrl ?? new URL("/", input.session.endpoint).toString(),
        resourceMetadataUrl: input.session.resourceMetadataUrl ?? undefined,
        resourceMetadata: decodeJson({
          value: input.session.resourceMetadataJson,
          fallback: undefined,
        }),
        authorizationServerMetadata: decodeJson({
          value: input.session.authorizationServerMetadataJson,
          fallback: undefined,
        }),
      },
      clientInformation: decodeJson<OAuthClientInformationMixed | undefined>({
        value: input.session.clientInformationJson,
        fallback: undefined,
      }),
    };

    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return input.session.redirectUrl;
      },
      get clientMetadata() {
        return createClientMetadata(input.session.redirectUrl);
      },
      clientInformation: () => captured.clientInformation,
      saveClientInformation: (clientInformation) => {
        captured.clientInformation = clientInformation;
      },
      tokens: () => undefined,
      saveTokens: (tokens) => {
        captured.tokens = tokens;
      },
      redirectToAuthorization: () => {
        throw new Error("Unexpected redirect while completing MCP OAuth");
      },
      saveCodeVerifier: () => undefined,
      codeVerifier: () => input.session.codeVerifier,
      saveDiscoveryState: (state) => {
        captured.discoveryState = state;
      },
      discoveryState: () => captured.discoveryState,
    };

    const result = yield* Effect.tryPromise({
      try: () =>
        auth(provider, {
          serverUrl: input.session.endpoint,
          authorizationCode: input.code,
        }),
      catch: toError,
    });

    if (result !== "AUTHORIZED" || !captured.tokens) {
      return yield* Effect.fail(
        new Error("OAuth redirect did not complete MCP OAuth setup"),
      );
    }

    return {
      tokens: captured.tokens,
      resourceMetadataUrl: captured.discoveryState?.resourceMetadataUrl ?? null,
      authorizationServerUrl: captured.discoveryState?.authorizationServerUrl ?? null,
      resourceMetadataJson: serializeJson(captured.discoveryState?.resourceMetadata),
      authorizationServerMetadataJson: serializeJson(
        captured.discoveryState?.authorizationServerMetadata,
      ),
      clientInformationJson: serializeJson(captured.clientInformation),
    } satisfies McpOAuthExchangeResult;
  });
