import type {
  CreateSourcePayload,
  UpdateSourcePayload,
} from "../api/sources/api";
import {
  SourceIdSchema,
  type Source,
  type SourceId,
  type WorkspaceId,
} from "#schema";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  createSourceFromPayload,
  projectSourceFromStorage,
  projectSourcesFromStorage,
  splitSourceForStorage,
  updateSourceFromPayload,
} from "./source-definitions";
import {
  mapPersistenceError,
} from "./operations-shared";
import {
  operationErrors,
} from "./operation-errors";
import { createDefaultSecretMaterialResolver } from "./secret-material-providers";
import { ControlPlaneStore, type ControlPlaneStoreShape } from "./store";
import { syncSourceToolArtifacts } from "./tool-artifacts";
import {
  loadSourceById,
  loadSourcesInWorkspace,
  removeCredentialBindingForSource,
} from "./source-store";

const sourceOps = {
  list: operationErrors("sources.list"),
  create: operationErrors("sources.create"),
  get: operationErrors("sources.get"),
  update: operationErrors("sources.update"),
  remove: operationErrors("sources.remove"),
} as const;

const syncArtifactsForSource = (input: {
  store: ControlPlaneStoreShape;
  source: Source;
  operation:
    | typeof sourceOps.create
    | typeof sourceOps.update;
}) =>
  Effect.gen(function* () {
    const resolveSecretMaterial = createDefaultSecretMaterialResolver({
      rows: input.store,
    });

    const synced = yield* Effect.either(
      syncSourceToolArtifacts({
        rows: input.store,
        source: input.source,
        resolveSecretMaterial,
      }),
    );

    return yield* Either.match(synced, {
      onRight: () => Effect.succeed(input.source),
      onLeft: (error) =>
        Effect.gen(function* () {
          if (input.source.enabled && input.source.status === "connected") {
            const erroredSource = yield* updateSourceFromPayload({
              source: input.source,
              payload: {
                status: "error",
                lastError: error.message,
              },
              now: Date.now(),
            }).pipe(
              Effect.mapError((cause) =>
                input.operation.badRequest(
                  "Failed indexing source tools",
                  cause instanceof Error ? cause.message : String(cause),
                ),
              ),
            );

            const { sourceRecord } = splitSourceForStorage({
              source: erroredSource,
            });
            const { sourceDocumentText: _sourceDocumentText, ...sourcePatch } = sourceRecord;
            yield* mapPersistenceError(
              input.operation.child("source_error"),
              input.store.sources.update(input.source.workspaceId, input.source.id, {
                ...sourcePatch,
                updatedAt: erroredSource.updatedAt,
              }),
            );
          }

          return yield* Effect.fail(
            input.operation.unknownStorage(error, "Failed syncing source tools"),
          );
        }),
    });
  });

export const listSources = (workspaceId: WorkspaceId) =>
  Effect.flatMap(ControlPlaneStore, (store) =>
    loadSourcesInWorkspace(store, workspaceId).pipe(
      Effect.mapError((error) =>
        sourceOps.list.unknownStorage(
          error,
          "Failed projecting stored sources",
        ),
      ),
    ));

export const createSource = (input: {
  workspaceId: WorkspaceId;
  payload: CreateSourcePayload;
}) =>
  Effect.flatMap(ControlPlaneStore, (store) =>
    Effect.gen(function* () {
      const now = Date.now();

      const source = yield* createSourceFromPayload({
        workspaceId: input.workspaceId,
        sourceId: SourceIdSchema.make(`src_${crypto.randomUUID()}`),
        payload: input.payload,
        now,
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.create.badRequest(
            "Invalid source definition",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      );

      const { sourceRecord, credential, credentialBinding } = splitSourceForStorage({
        source,
      });

      yield* mapPersistenceError(
        sourceOps.create.child("source"),
        store.sources.insert(sourceRecord),
      );
      if (credential !== null && credentialBinding !== null) {
        yield* mapPersistenceError(
          sourceOps.create.child("credential"),
          store.credentials.upsert(credential),
        );
        yield* mapPersistenceError(
          sourceOps.create.child("binding"),
          store.sourceCredentialBindings.upsert(credentialBinding),
        );
      }

      return yield* syncArtifactsForSource({
        store,
        source,
        operation: sourceOps.create,
      });
    }));

export const getSource = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}) =>
  Effect.flatMap(ControlPlaneStore, (store) =>
    loadSourceById(store, {
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error && cause.message.startsWith("Source not found:")
          ? sourceOps.get.notFound(
              "Source not found",
              `workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
            )
          : sourceOps.get.unknownStorage(
              cause,
              "Failed projecting stored source",
            ),
      ),
    ));

export const updateSource = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  payload: UpdateSourcePayload;
}) =>
  Effect.flatMap(ControlPlaneStore, (store) =>
    Effect.gen(function* () {
      const existing = yield* sourceOps.update.child("existing").mapStorage(
        store.sources.getByWorkspaceAndId(input.workspaceId, input.sourceId),
      );

      if (Option.isNone(existing)) {
        return yield* Effect.fail(
          sourceOps.update.notFound(
            "Source not found",
            `workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
          ),
        );
      }

      const existingBinding = yield* sourceOps.update.child("binding").mapStorage(
        store.sourceCredentialBindings.getByWorkspaceAndSourceId(
          input.workspaceId,
          input.sourceId,
        ),
      );

      const existingSource = yield* loadSourceById(store, {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error && cause.message.startsWith("Source not found:")
            ? sourceOps.update.notFound(
                "Source not found",
                `workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
              )
            : sourceOps.update.unknownStorage(
                cause,
                "Failed projecting stored source",
              ),
        ),
      );

      const updatedSource = yield* updateSourceFromPayload({
        source: existingSource,
        payload: input.payload,
        now: Date.now(),
      }).pipe(
        Effect.mapError((cause) =>
          sourceOps.update.badRequest(
            "Invalid source definition",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      );

      const { sourceRecord, credential, credentialBinding } = splitSourceForStorage({
        source: updatedSource,
        existingCredentialId: Option.isSome(existingBinding)
          ? existingBinding.value.credentialId
          : null,
        existingBindingId: Option.isSome(existingBinding)
          ? existingBinding.value.id
          : null,
      });
      const { sourceDocumentText: _sourceDocumentText, ...sourcePatch } = sourceRecord;

      const stored = yield* mapPersistenceError(
        sourceOps.update.child("source"),
        store.sources.update(input.workspaceId, input.sourceId, {
          ...sourcePatch,
          updatedAt: updatedSource.updatedAt,
        }),
      );

      if (Option.isNone(stored)) {
        return yield* Effect.fail(
          sourceOps.update.notFound(
            "Source not found",
            `workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
          ),
        );
      }

      if (credential === null || credentialBinding === null) {
        if (Option.isSome(existingBinding)) {
          yield* sourceOps.update.child("binding.remove").mapStorage(
            store.sourceCredentialBindings.removeByWorkspaceAndSourceId(
              input.workspaceId,
              input.sourceId,
            ),
          );
          yield* sourceOps.update.child("credential.remove").mapStorage(
            store.credentials.removeById(existingBinding.value.credentialId),
          );
        }
      } else {
        yield* mapPersistenceError(
          sourceOps.update.child("credential"),
          store.credentials.upsert(credential),
        );
        yield* mapPersistenceError(
          sourceOps.update.child("binding"),
          store.sourceCredentialBindings.upsert(credentialBinding),
        );
      }

      return yield* syncArtifactsForSource({
        store,
        source: updatedSource,
        operation: sourceOps.update,
      });
    }));

export const removeSource = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}) =>
  Effect.flatMap(ControlPlaneStore, (store) =>
    Effect.gen(function* () {
      yield* sourceOps.remove.child("credential.remove").mapStorage(
        removeCredentialBindingForSource(store, {
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
        }),
      );

      yield* sourceOps.remove.child("artifacts").mapStorage(
        store.toolArtifacts.removeByWorkspaceAndSourceId(input.workspaceId, input.sourceId),
      );

      yield* sourceOps.remove.child("artifacts").mapStorage(
        store.toolArtifacts.removeByWorkspaceAndSourceId(input.workspaceId, input.sourceId),
      );

      const removed = yield* sourceOps.remove.mapStorage(
        store.sources.removeByWorkspaceAndId(input.workspaceId, input.sourceId),
      );

      return { removed };
    })
  );
