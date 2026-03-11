import {
  AuthArtifactSchema,
  type AuthArtifact,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodeAuthArtifact = Schema.decodeUnknownSync(AuthArtifactSchema);

const authArtifactUpdateSet = (artifact: AuthArtifact) => {
  const {
    id: _id,
    workspaceId: _workspaceId,
    sourceId: _sourceId,
    actorAccountId: _actorAccountId,
    createdAt: _createdAt,
    ...patch
  } = artifact;
  return patch;
};

export const createAuthArtifactsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listByWorkspaceId: (workspaceId: AuthArtifact["workspaceId"]) =>
    client.use("rows.auth_artifacts.list_by_workspace", async (db) => {
      const rows = await db
        .select()
        .from(tables.authArtifactsTable)
        .where(eq(tables.authArtifactsTable.workspaceId, workspaceId))
        .orderBy(
          asc(tables.authArtifactsTable.updatedAt),
          asc(tables.authArtifactsTable.id),
        );

      return rows.map((row) => decodeAuthArtifact(row));
    }),

  listByWorkspaceAndSourceId: (input: {
    workspaceId: AuthArtifact["workspaceId"];
    sourceId: AuthArtifact["sourceId"];
  }) =>
    client.use("rows.auth_artifacts.list_by_workspace_source", async (db) => {
      const rows = await db
        .select()
        .from(tables.authArtifactsTable)
        .where(
          and(
            eq(tables.authArtifactsTable.workspaceId, input.workspaceId),
            eq(tables.authArtifactsTable.sourceId, input.sourceId),
          ),
        )
        .orderBy(
          asc(tables.authArtifactsTable.updatedAt),
          asc(tables.authArtifactsTable.id),
        );

      return rows.map((row) => decodeAuthArtifact(row));
    }),

  listByWorkspaceSourceAndActor: (input: {
    workspaceId: AuthArtifact["workspaceId"];
    sourceId: AuthArtifact["sourceId"];
    actorAccountId: AuthArtifact["actorAccountId"];
  }) =>
    client.use("rows.auth_artifacts.list_by_workspace_source_actor", async (db) => {
      const rows = await db
        .select()
        .from(tables.authArtifactsTable)
        .where(
          and(
            eq(tables.authArtifactsTable.workspaceId, input.workspaceId),
            eq(tables.authArtifactsTable.sourceId, input.sourceId),
            or(
              input.actorAccountId === null
                ? isNull(tables.authArtifactsTable.actorAccountId)
                : eq(tables.authArtifactsTable.actorAccountId, input.actorAccountId),
              input.actorAccountId === null
                ? undefined
                : isNull(tables.authArtifactsTable.actorAccountId),
            ),
          ),
        )
        .orderBy(
          asc(tables.authArtifactsTable.slot),
          asc(tables.authArtifactsTable.actorAccountId),
          asc(tables.authArtifactsTable.updatedAt),
          asc(tables.authArtifactsTable.id),
        );

      return rows.map((row) => decodeAuthArtifact(row));
    }),

  getByWorkspaceSourceAndActor: (input: {
    workspaceId: AuthArtifact["workspaceId"];
    sourceId: AuthArtifact["sourceId"];
    actorAccountId: AuthArtifact["actorAccountId"];
    slot: AuthArtifact["slot"];
  }) =>
    client.use("rows.auth_artifacts.get_by_workspace_source_actor", async (db) => {
      const rows = await db
        .select()
        .from(tables.authArtifactsTable)
        .where(
          and(
            eq(tables.authArtifactsTable.workspaceId, input.workspaceId),
            eq(tables.authArtifactsTable.sourceId, input.sourceId),
            eq(tables.authArtifactsTable.slot, input.slot),
            input.actorAccountId === null
              ? isNull(tables.authArtifactsTable.actorAccountId)
              : eq(tables.authArtifactsTable.actorAccountId, input.actorAccountId),
          ),
        )
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeAuthArtifact(row.value))
        : Option.none<AuthArtifact>();
    }),

  upsert: (artifact: AuthArtifact) =>
    client.use("rows.auth_artifacts.upsert", async (db) => {
      if (artifact.actorAccountId === null) {
        const existingRows = await db
          .select({
            id: tables.authArtifactsTable.id,
          })
          .from(tables.authArtifactsTable)
          .where(
            and(
              eq(tables.authArtifactsTable.workspaceId, artifact.workspaceId),
              eq(tables.authArtifactsTable.sourceId, artifact.sourceId),
              eq(tables.authArtifactsTable.slot, artifact.slot),
              isNull(tables.authArtifactsTable.actorAccountId),
            ),
          )
          .orderBy(
            asc(tables.authArtifactsTable.updatedAt),
            asc(tables.authArtifactsTable.id),
          );

        const existing = firstOption(existingRows);
        if (Option.isSome(existing)) {
          await db
            .update(tables.authArtifactsTable)
            .set(authArtifactUpdateSet(artifact))
            .where(eq(tables.authArtifactsTable.id, existing.value.id));

          const duplicateIds = existingRows.slice(1).map((row) => row.id);
          if (duplicateIds.length > 0) {
            await db
              .delete(tables.authArtifactsTable)
              .where(inArray(tables.authArtifactsTable.id, duplicateIds));
          }

          return;
        }
      }

      await db
        .insert(tables.authArtifactsTable)
        .values(artifact)
        .onConflictDoUpdate({
          target: [
            tables.authArtifactsTable.workspaceId,
            tables.authArtifactsTable.sourceId,
            tables.authArtifactsTable.actorAccountId,
            tables.authArtifactsTable.slot,
          ],
          set: {
            ...authArtifactUpdateSet(artifact),
          },
        });
    }),

  removeByWorkspaceSourceAndActor: (input: {
    workspaceId: AuthArtifact["workspaceId"];
    sourceId: AuthArtifact["sourceId"];
    actorAccountId: AuthArtifact["actorAccountId"];
    slot?: AuthArtifact["slot"];
  }) =>
    client.use("rows.auth_artifacts.remove_by_workspace_source_actor", async (db) => {
      const deleted = await db
        .delete(tables.authArtifactsTable)
        .where(
          and(
            eq(tables.authArtifactsTable.workspaceId, input.workspaceId),
            eq(tables.authArtifactsTable.sourceId, input.sourceId),
            input.slot === undefined
              ? undefined
              : eq(tables.authArtifactsTable.slot, input.slot),
            input.actorAccountId === null
              ? isNull(tables.authArtifactsTable.actorAccountId)
              : eq(tables.authArtifactsTable.actorAccountId, input.actorAccountId),
          ),
        )
        .returning();

      return deleted.length > 0;
    }),

  removeByWorkspaceAndSourceId: (input: {
    workspaceId: AuthArtifact["workspaceId"];
    sourceId: AuthArtifact["sourceId"];
  }) =>
    client.use("rows.auth_artifacts.remove_by_workspace_source", async (db) => {
      const deleted = await db
        .delete(tables.authArtifactsTable)
        .where(
          and(
            eq(tables.authArtifactsTable.workspaceId, input.workspaceId),
            eq(tables.authArtifactsTable.sourceId, input.sourceId),
          ),
        )
        .returning();

      return deleted.length;
    }),
});
