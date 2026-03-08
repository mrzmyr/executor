import type {
  Credential,
  Source,
  WorkspaceId,
} from "#schema";
import { type SqlControlPlaneRows } from "#persistence";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  projectSourceFromStorage,
  projectSourcesFromStorage,
  splitSourceForStorage,
} from "./source-definitions";

export const loadSourcesInWorkspace = (
  rows: SqlControlPlaneRows,
  workspaceId: WorkspaceId,
) =>
  Effect.gen(function* () {
    const sourceRecords = yield* rows.sources.listByWorkspaceId(workspaceId);
    const credentialBindings = yield* rows.sourceCredentialBindings.listByWorkspaceId(workspaceId);
    const credentials = yield* rows.credentials.listByWorkspaceId(workspaceId);

    return yield* projectSourcesFromStorage({
      sourceRecords,
      credentialBindings,
      credentials,
    });
  });

export const loadSourceById = (rows: SqlControlPlaneRows, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
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

    const credentialBinding = yield* rows.sourceCredentialBindings.getByWorkspaceAndSourceId(
      input.workspaceId,
      input.sourceId,
    );
    const credential =
      Option.isSome(credentialBinding)
        ? yield* rows.credentials.getById(credentialBinding.value.credentialId)
        : Option.none<Credential>();

    return yield* projectSourceFromStorage({
      sourceRecord: sourceRecord.value,
      credentialBinding: Option.isSome(credentialBinding) ? credentialBinding.value : null,
      credential: Option.isSome(credential) ? credential.value : null,
    });
  });

export const removeCredentialBindingForSource = (rows: SqlControlPlaneRows, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
}) =>
  Effect.gen(function* () {
    const existingBinding = yield* rows.sourceCredentialBindings.getByWorkspaceAndSourceId(
      input.workspaceId,
      input.sourceId,
    );

    if (Option.isNone(existingBinding)) {
      return false;
    }

    yield* rows.sourceCredentialBindings.removeByWorkspaceAndSourceId(
      input.workspaceId,
      input.sourceId,
    );
    yield* rows.credentials.removeById(existingBinding.value.credentialId);
    return true;
  });

export const persistSource = (rows: SqlControlPlaneRows, source: Source) =>
  Effect.gen(function* () {
    const existing = yield* rows.sources.getByWorkspaceAndId(source.workspaceId, source.id);
    const existingBinding = yield* rows.sourceCredentialBindings.getByWorkspaceAndSourceId(
      source.workspaceId,
      source.id,
    );
    const existingCredentialId = Option.isSome(existingBinding)
      ? existingBinding.value.credentialId
      : null;
    const existingBindingId = Option.isSome(existingBinding)
      ? existingBinding.value.id
      : null;
    const { sourceRecord, credential, credentialBinding } = splitSourceForStorage({
      source,
      existingCredentialId,
      existingBindingId,
    });

    if (Option.isNone(existing)) {
      yield* rows.sources.insert(sourceRecord);
    } else {
      const {
        id: _id,
        workspaceId: _workspaceId,
        createdAt: _createdAt,
        sourceDocumentText: _sourceDocumentText,
        ...patch
      } = sourceRecord;
      yield* rows.sources.update(source.workspaceId, source.id, patch);
    }

    if (credential === null || credentialBinding === null) {
      if (Option.isSome(existingBinding)) {
        yield* rows.sourceCredentialBindings.removeByWorkspaceAndSourceId(
          source.workspaceId,
          source.id,
        );
        yield* rows.credentials.removeById(existingBinding.value.credentialId);
      }
    } else {
      yield* rows.credentials.upsert(credential);
      yield* rows.sourceCredentialBindings.upsert(credentialBinding);
    }

    return source;
  });
