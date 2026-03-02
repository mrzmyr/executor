import {
  CredentialResolverError,
  extractCredentialResolutionContext,
  makeCredentialResolver,
  sourceIdFromSourceKey,
  type ResolveToolCredentials,
} from "@executor-v2/engine";
import { type LocalStateStore } from "@executor-v2/persistence-local";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const toCredentialResolverError = (
  operation: string,
  message: string,
  details: string | null,
): CredentialResolverError =>
  new CredentialResolverError({
    operation,
    message,
    details,
  });

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

const toStringRecord = (value: Record<string, unknown>): Record<string, string> => {
  const normalized: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeString(rawKey);
    const resolvedValue = normalizeString(rawValue);
    if (!key || !resolvedValue) {
      continue;
    }

    normalized[key] = resolvedValue;
  }

  return normalized;
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

const base64Encode = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64");

const buildSecretHeaders = (
  strategy: string,
  secret: string,
  metadataJson: string | null,
): Record<string, string> => {
  const trimmedSecret = secret.trim();
  if (trimmedSecret.length === 0) {
    return {};
  }

  const metadata = parseJsonObject(metadataJson);

  if (strategy === "api_key") {
    const headerName = normalizeString(metadata.apiKeyHeader) ?? "x-api-key";
    return {
      [headerName]: trimmedSecret,
    };
  }

  if (strategy === "bearer") {
    return {
      Authorization: `Bearer ${trimmedSecret}`,
    };
  }

  if (strategy === "basic") {
    const asJson = parseJsonObject(trimmedSecret);
    const username = normalizeString(asJson.username);
    const password = normalizeString(asJson.password);

    const pair = username && password
      ? `${username}:${password}`
      : trimmedSecret.includes(":")
        ? trimmedSecret
        : null;

    if (!pair) {
      return {};
    }

    return {
      Authorization: `Basic ${base64Encode(pair)}`,
    };
  }

  if (strategy === "custom") {
    const headerName = normalizeString(metadata.customHeaderName);
    if (!headerName) {
      return {};
    }

    return {
      [headerName]: trimmedSecret,
    };
  }

  return {};
};

export const createPmResolveToolCredentials = (
  localStateStore: LocalStateStore,
): ResolveToolCredentials =>
  makeCredentialResolver((input) =>
    Effect.gen(function* () {
      const context = extractCredentialResolutionContext(input);
      if (context === null) {
        return {
          headers: {},
        };
      }

      const snapshotOption = yield* localStateStore.getSnapshot().pipe(
        Effect.mapError((error) =>
          toCredentialResolverError(
            "read_local_state_snapshot",
            "Failed reading local snapshot while resolving credentials",
            error.details ?? error.message,
          ),
        ),
      );

      const snapshot = Option.getOrNull(snapshotOption);
      if (snapshot === null) {
        return {
          headers: {},
        };
      }

      const sourceId = sourceIdFromSourceKey(context.sourceKey);
      if (!sourceId) {
        return {
          headers: {},
        };
      }

      const workspace = snapshot.workspaces.find(
        (item) => item.id === context.workspaceId,
      );
      const organizationId = context.organizationId ?? workspace?.organizationId ?? null;

      const binding = snapshot.sourceAuthBindings
        .filter((candidate) => candidate.sourceId === sourceId)
        .map((candidate) => {
          let score = -1;

          if (candidate.scopeType === "account") {
            if (context.accountId && candidate.accountId === context.accountId) {
              score = organizationId && candidate.organizationId === organizationId ? 30 : -1;
            }
          } else if (candidate.scopeType === "workspace") {
            score = candidate.workspaceId === context.workspaceId ? 20 : -1;
          } else if (candidate.scopeType === "organization") {
            score = organizationId && candidate.organizationId === organizationId ? 10 : -1;
          }

          return {
            candidate,
            score,
          };
        })
        .filter((entry) => entry.score >= 0)
        .sort((left, right) => {
          if (left.score !== right.score) {
            return right.score - left.score;
          }

          if (left.candidate.updatedAt !== right.candidate.updatedAt) {
            return right.candidate.updatedAt - left.candidate.updatedAt;
          }

          return right.candidate.createdAt - left.candidate.createdAt;
        })[0]?.candidate ?? null;

      if (binding === null) {
        return {
          headers: {},
        };
      }

      const connection = snapshot.authConnections.find(
        (candidate) => candidate.id === binding.connectionId,
      );
      if (!connection || connection.status !== "active") {
        return {
          headers: {},
        };
      }

      const additionalHeaders = toStringRecord(
        parseJsonObject(connection.additionalHeadersJson),
      );

      if (connection.strategy === "oauth2") {
        const oauthState = snapshot.oauthStates.find(
          (candidate) => candidate.connectionId === connection.id,
        );

        const accessToken = normalizeString(oauthState?.accessTokenCiphertext);
        const oauthHeaders = accessToken
          ? ({ Authorization: `Bearer ${accessToken}` } as Record<string, string>)
          : {};

        return {
          headers: mergeHeaders(oauthHeaders, additionalHeaders),
        };
      }

      const material = snapshot.authMaterials.find(
        (candidate) => candidate.connectionId === connection.id,
      );

      if (!material) {
        return {
          headers: additionalHeaders,
        };
      }

      return {
        headers: mergeHeaders(
          buildSecretHeaders(
            connection.strategy,
            material.ciphertext,
            connection.metadataJson,
          ),
          additionalHeaders,
        ),
      };
    }),
  );
