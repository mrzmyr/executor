import type { SqlControlPlaneRows } from "#persistence";
import type {
  AccountId,
  CredentialSlot,
  Source,
  SourceAuth,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  authArtifactFromSourceAuth,
  resolveAuthArtifactMaterial,
  type ResolvedSourceAuthMaterial,
} from "./auth-artifacts";
import { resolveAuthArtifactMaterialWithLeases } from "./auth-leases";
import type {
  ResolveSecretMaterial,
  SecretMaterialResolveContext,
} from "./secret-material-providers";

const authForSlot = (input: {
  source: Source;
  slot: CredentialSlot;
}): SourceAuth => {
  if (input.slot === "runtime") {
    return input.source.auth;
  }

  if (input.source.importAuthPolicy === "reuse_runtime") {
    return input.source.auth;
  }

  if (input.source.importAuthPolicy === "none") {
    return { kind: "none" };
  }

  return input.source.importAuth;
};

export const resolveSourceAuthMaterial = (input: {
  source: Source;
  slot?: CredentialSlot;
  actorAccountId?: AccountId | null;
  rows?: SqlControlPlaneRows;
  resolveSecretMaterial: ResolveSecretMaterial;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<ResolvedSourceAuthMaterial, Error, never> =>
  Effect.gen(function* () {
    const slot = input.slot ?? "runtime";

    if (input.rows !== undefined) {
      const candidateSlots =
        slot === "import" && input.source.importAuthPolicy === "reuse_runtime"
          ? ["import", "runtime"] satisfies ReadonlyArray<CredentialSlot>
          : [slot] satisfies ReadonlyArray<CredentialSlot>;

      for (const candidateSlot of candidateSlots) {
        const artifactOption = yield* input.rows.authArtifacts.getByWorkspaceSourceAndActor({
          workspaceId: input.source.workspaceId,
          sourceId: input.source.id,
          actorAccountId: input.actorAccountId ?? null,
          slot: candidateSlot,
        });

        if (Option.isSome(artifactOption)) {
          return yield* resolveAuthArtifactMaterialWithLeases({
            rows: input.rows,
            artifact: artifactOption.value,
            resolveSecretMaterial: input.resolveSecretMaterial,
            context: input.context,
          });
        }
      }
    }

    const artifact = authArtifactFromSourceAuth({
      source: input.source,
      auth: authForSlot({
        source: input.source,
        slot,
      }),
      slot,
      actorAccountId: input.actorAccountId ?? null,
    });

    if (input.rows !== undefined) {
      return yield* resolveAuthArtifactMaterialWithLeases({
        rows: input.rows,
        artifact,
        resolveSecretMaterial: input.resolveSecretMaterial,
        context: input.context,
      });
    }

    if (artifact?.artifactKind === "oauth2_authorized_user") {
      return yield* Effect.fail(
        new Error("Dynamic auth artifacts require persistence-backed lease resolution"),
      );
    }

    return yield* resolveAuthArtifactMaterial({
      artifact,
      resolveSecretMaterial: input.resolveSecretMaterial,
      context: input.context,
    });
  });

export type { ResolvedSourceAuthMaterial } from "./auth-artifacts";
