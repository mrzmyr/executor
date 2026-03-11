import type {
  AccountId,
  AuthArtifact,
  CredentialSlot,
  Source,
  SourceRecipeId,
  SourceRecipeRevisionId,
  WorkspaceId,
} from "#schema";
import { type SqlControlPlaneRows } from "#persistence";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  createSourceRecipeRecord,
  createSourceRecipeRevisionRecord,
  projectSourceFromStorage,
  projectSourcesFromStorage,
  stableSourceRecipeId,
  stableSourceRecipeRevisionId,
  splitSourceForStorage,
} from "./source-definitions";
import { createDefaultSecretMaterialDeleter } from "./secret-material-providers";
import { authArtifactSecretMaterialRefs } from "./auth-artifacts";
import { removeAuthLeaseAndSecrets } from "./auth-leases";

const secretRefKey = (ref: { providerId: string; handle: string }): string =>
  `${ref.providerId}:${ref.handle}`;

const cleanupAuthArtifactSecretRefs = (rows: SqlControlPlaneRows, input: {
  previous: AuthArtifact | null;
  next: AuthArtifact | null;
}) =>
  Effect.gen(function* () {
    if (input.previous === null) {
      return;
    }

    const deleteSecretMaterial = createDefaultSecretMaterialDeleter({ rows });
    const nextRefKeys = new Set(
      (input.next === null ? [] : authArtifactSecretMaterialRefs(input.next)).map(secretRefKey),
    );
    const refsToDelete = authArtifactSecretMaterialRefs(input.previous).filter(
      (ref) => !nextRefKeys.has(secretRefKey(ref)),
    );

    yield* Effect.forEach(
      refsToDelete,
      (ref) => Effect.either(deleteSecretMaterial(ref)),
      { discard: true },
    );
  });

const selectPreferredAuthArtifact = (input: {
  authArtifacts: ReadonlyArray<AuthArtifact>;
  actorAccountId?: AccountId | null;
  slot: CredentialSlot;
}): AuthArtifact | null => {
  const matchingSlot = input.authArtifacts.filter((artifact) => artifact.slot === input.slot);

  if (input.actorAccountId !== undefined) {
    const exact = matchingSlot.find((artifact) => artifact.actorAccountId === input.actorAccountId);
    if (exact) {
      return exact;
    }
  }

  return matchingSlot.find((artifact) => artifact.actorAccountId === null) ?? null;
};

const selectExactAuthArtifact = (input: {
  authArtifacts: ReadonlyArray<AuthArtifact>;
  actorAccountId?: AccountId | null;
  slot: CredentialSlot;
}): AuthArtifact | null =>
  input.authArtifacts.find(
    (artifact) =>
      artifact.slot === input.slot
      && artifact.actorAccountId === (input.actorAccountId ?? null),
  ) ?? null;

export const loadSourcesInWorkspace = (
  rows: SqlControlPlaneRows,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
) =>
  Effect.gen(function* () {
    const sourceRecords = yield* rows.sources.listByWorkspaceId(workspaceId);
    const authArtifacts = yield* rows.authArtifacts.listByWorkspaceId(workspaceId);
    const filteredAuthArtifacts = sourceRecords.flatMap((sourceRecord) => {
      const matches = authArtifacts.filter((artifact) => artifact.sourceId === sourceRecord.id);
      const preferred = selectPreferredAuthArtifact({
        authArtifacts: matches,
        actorAccountId: options.actorAccountId,
        slot: "runtime",
      });
      const preferredImport = selectPreferredAuthArtifact({
        authArtifacts: matches,
        actorAccountId: options.actorAccountId,
        slot: "import",
      });
      return [preferred, preferredImport].filter(
        (artifact): artifact is AuthArtifact => artifact !== null,
      );
    });

    return yield* projectSourcesFromStorage({
      sourceRecords,
      authArtifacts: filteredAuthArtifacts,
    });
  });

export const loadSourceById = (rows: SqlControlPlaneRows, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  actorAccountId?: AccountId | null;
}) =>
  Effect.gen(function* () {
    const sourceRecord = yield* rows.sources.getByWorkspaceAndId(
      input.workspaceId,
      input.sourceId,
    );

    if (Option.isNone(sourceRecord)) {
      return yield* Effect.fail(
        new Error(`Source not found: workspaceId=${input.workspaceId} sourceId=${input.sourceId}`),
      );
    }

    const authArtifacts = yield* rows.authArtifacts.listByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    const authArtifact = selectPreferredAuthArtifact({
      authArtifacts,
      actorAccountId: input.actorAccountId,
      slot: "runtime",
    });
    const importAuthArtifact = selectPreferredAuthArtifact({
      authArtifacts,
      actorAccountId: input.actorAccountId,
      slot: "import",
    });

    return yield* projectSourceFromStorage({
      sourceRecord: sourceRecord.value,
      runtimeAuthArtifact: authArtifact,
      importAuthArtifact,
    });
  });

const removeAuthArtifactsForSource = (rows: SqlControlPlaneRows, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
}) =>
  Effect.gen(function* () {
    const existingAuthArtifacts = yield* rows.authArtifacts.listByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    yield* rows.authArtifacts.removeByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    yield* Effect.forEach(
      existingAuthArtifacts,
      (artifact) =>
        removeAuthLeaseAndSecrets(rows, {
          authArtifactId: artifact.id,
        }),
      { discard: true },
    );

    yield* Effect.forEach(
      existingAuthArtifacts,
      (artifact) =>
        cleanupAuthArtifactSecretRefs(rows, {
          previous: artifact,
          next: null,
        }),
      { discard: true },
    );

    return existingAuthArtifacts.length;
  });

const cleanupOrphanedRecipeData = (rows: SqlControlPlaneRows, input: {
  recipeId: SourceRecipeId;
  recipeRevisionId: SourceRecipeRevisionId;
}) =>
  Effect.gen(function* () {
    const revisionReferenceCount = yield* rows.sources.countByRecipeRevisionId(
      input.recipeRevisionId,
    );
    if (revisionReferenceCount === 0) {
      yield* rows.sourceRecipeDocuments.removeByRevisionId(input.recipeRevisionId);
      yield* rows.sourceRecipeSchemaBundles.removeByRevisionId(input.recipeRevisionId);
      yield* rows.sourceRecipeOperations.removeByRevisionId(input.recipeRevisionId);
    }

    const recipeReferenceCount = yield* rows.sources.countByRecipeId(input.recipeId);
    if (recipeReferenceCount > 0) {
      return;
    }

    const recipeRevisions = yield* rows.sourceRecipeRevisions.listByRecipeId(input.recipeId);
    yield* Effect.forEach(
      recipeRevisions,
      (recipeRevision) =>
        Effect.all([
          rows.sourceRecipeDocuments.removeByRevisionId(recipeRevision.id),
          rows.sourceRecipeSchemaBundles.removeByRevisionId(recipeRevision.id),
          rows.sourceRecipeOperations.removeByRevisionId(recipeRevision.id),
        ]),
      { discard: true },
    );
    yield* rows.sourceRecipeRevisions.removeByRecipeId(input.recipeId);
    yield* rows.sourceRecipes.removeById(input.recipeId);
  });

export const removeSourceById = (rows: SqlControlPlaneRows, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
}) =>
  Effect.gen(function* () {
    const sourceRecord = yield* rows.sources.getByWorkspaceAndId(input.workspaceId, input.sourceId);
    if (Option.isNone(sourceRecord)) {
      return false;
    }

    yield* rows.sourceAuthSessions.removeByWorkspaceAndSourceId(
      input.workspaceId,
      input.sourceId,
    );
    yield* rows.sourceOauthClients.removeByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    yield* removeAuthArtifactsForSource(rows, input);
    const removed = yield* rows.sources.removeByWorkspaceAndId(input.workspaceId, input.sourceId);
    if (!removed) {
      return false;
    }

    yield* cleanupOrphanedRecipeData(rows, {
      recipeId: sourceRecord.value.recipeId,
      recipeRevisionId: sourceRecord.value.recipeRevisionId,
    });

    return true;
  });

export const persistSource = (
  rows: SqlControlPlaneRows,
  source: Source,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
) =>
  Effect.gen(function* () {
    const existing = yield* rows.sources.getByWorkspaceAndId(source.workspaceId, source.id);
    const existingAuthArtifacts = yield* rows.authArtifacts.listByWorkspaceAndSourceId({
      workspaceId: source.workspaceId,
      sourceId: source.id,
    });
    const existingRuntimeAuthArtifact = selectExactAuthArtifact({
      authArtifacts: existingAuthArtifacts,
      actorAccountId: options.actorAccountId,
      slot: "runtime",
    });
    const existingImportAuthArtifact = selectExactAuthArtifact({
      authArtifacts: existingAuthArtifacts,
      actorAccountId: options.actorAccountId,
      slot: "import",
    });

    const nextRecipeId = stableSourceRecipeId(source);
    const nextRecipeRevisionId = Option.isSome(existing) && existing.value.recipeId === nextRecipeId
      ? existing.value.recipeRevisionId
      : stableSourceRecipeRevisionId(source);
    const existingTargetRevision = yield* rows.sourceRecipeRevisions.getById(nextRecipeRevisionId);
    const nextRevision = createSourceRecipeRevisionRecord({
      source,
      recipeId: nextRecipeId,
      recipeRevisionId: nextRecipeRevisionId,
      revisionNumber: Option.isSome(existingTargetRevision)
        ? existingTargetRevision.value.revisionNumber
        : 1,
      manifestJson: Option.isSome(existingTargetRevision)
        ? existingTargetRevision.value.manifestJson
        : null,
      manifestHash: Option.isSome(existingTargetRevision)
        ? existingTargetRevision.value.manifestHash
        : null,
      materializationHash: Option.isSome(existingTargetRevision)
        ? existingTargetRevision.value.materializationHash
        : null,
    });

    const nextRecipe = createSourceRecipeRecord({
      source,
      recipeId: nextRecipeId,
      latestRevisionId: nextRevision.id,
    });

    const { sourceRecord, runtimeAuthArtifact, importAuthArtifact } = splitSourceForStorage({
      source,
      recipeId: nextRecipe.id,
      recipeRevisionId: nextRevision.id,
      actorAccountId: options.actorAccountId,
      existingRuntimeAuthArtifactId: existingRuntimeAuthArtifact?.id ?? null,
      existingImportAuthArtifactId: existingImportAuthArtifact?.id ?? null,
    });

    if (Option.isNone(existing)) {
      yield* rows.sources.insert(sourceRecord);
    } else {
      const {
        id: _id,
        workspaceId: _workspaceId,
        createdAt: _createdAt,
        ...patch
      } = sourceRecord;
      yield* rows.sources.update(source.workspaceId, source.id, patch);
    }

    yield* rows.sourceRecipes.upsert(nextRecipe);
    yield* rows.sourceRecipeRevisions.upsert(nextRevision);

    if (
      Option.isSome(existing)
      && (
        existing.value.recipeId !== nextRecipeId
        || existing.value.recipeRevisionId !== nextRecipeRevisionId
      )
    ) {
      yield* cleanupOrphanedRecipeData(rows, {
        recipeId: existing.value.recipeId,
        recipeRevisionId: existing.value.recipeRevisionId,
      });
    }

    if (runtimeAuthArtifact === null) {
      if (existingRuntimeAuthArtifact !== null) {
        yield* removeAuthLeaseAndSecrets(rows, {
          authArtifactId: existingRuntimeAuthArtifact.id,
        });
      }
      yield* rows.authArtifacts.removeByWorkspaceSourceAndActor({
        workspaceId: source.workspaceId,
        sourceId: source.id,
        actorAccountId: options.actorAccountId ?? null,
        slot: "runtime",
      });
    } else {
      yield* rows.authArtifacts.upsert(runtimeAuthArtifact);
      if (
        existingRuntimeAuthArtifact !== null
        && existingRuntimeAuthArtifact.id !== runtimeAuthArtifact.id
      ) {
        yield* removeAuthLeaseAndSecrets(rows, {
          authArtifactId: existingRuntimeAuthArtifact.id,
        });
      }
    }

    yield* cleanupAuthArtifactSecretRefs(rows, {
      previous: existingRuntimeAuthArtifact ?? null,
      next: runtimeAuthArtifact,
    });

    if (importAuthArtifact === null) {
      if (existingImportAuthArtifact !== null) {
        yield* removeAuthLeaseAndSecrets(rows, {
          authArtifactId: existingImportAuthArtifact.id,
        });
      }
      yield* rows.authArtifacts.removeByWorkspaceSourceAndActor({
        workspaceId: source.workspaceId,
        sourceId: source.id,
        actorAccountId: options.actorAccountId ?? null,
        slot: "import",
      });
    } else {
      yield* rows.authArtifacts.upsert(importAuthArtifact);
      if (
        existingImportAuthArtifact !== null
        && existingImportAuthArtifact.id !== importAuthArtifact.id
      ) {
        yield* removeAuthLeaseAndSecrets(rows, {
          authArtifactId: existingImportAuthArtifact.id,
        });
      }
    }

    yield* cleanupAuthArtifactSecretRefs(rows, {
      previous: existingImportAuthArtifact ?? null,
      next: importAuthArtifact,
    });

    return source;
  });
