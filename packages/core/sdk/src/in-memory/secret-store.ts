import { Effect } from "effect";

import { ScopeId, SecretId } from "../ids";
import { SecretNotFoundError } from "../errors";
import type { Secret } from "../secrets";

export const makeInMemorySecretStore = () => {
  const secrets = new Map<string, Secret & { value: string }>();
  let counter = 0;

  return {
    list: (scopeId: ScopeId) =>
      Effect.succeed(
        [...secrets.values()].filter((s) => s.scopeId === scopeId),
      ),
    get: (secretId: SecretId) =>
      Effect.fromNullable(secrets.get(secretId)).pipe(
        Effect.mapError(() => new SecretNotFoundError({ secretId })),
      ),
    resolve: (secretId: SecretId) =>
      Effect.fromNullable(secrets.get(secretId)).pipe(
        Effect.mapError(() => new SecretNotFoundError({ secretId })),
        Effect.map((s) => s.value),
      ),
    store: (input: {
      readonly scopeId: ScopeId;
      readonly name: string;
      readonly value: string;
      readonly purpose?: string;
    }) =>
      Effect.sync(() => {
        const id = SecretId.make(`secret-${++counter}`);
        const secret = {
          id,
          scopeId: input.scopeId,
          name: input.name,
          purpose: input.purpose,
          createdAt: new Date(),
          value: input.value,
        };
        secrets.set(id, secret);
        return secret;
      }),
    remove: (secretId: SecretId) =>
      Effect.fromNullable(secrets.get(secretId)).pipe(
        Effect.mapError(() => new SecretNotFoundError({ secretId })),
        Effect.map(() => secrets.delete(secretId)),
      ),
  };
};
