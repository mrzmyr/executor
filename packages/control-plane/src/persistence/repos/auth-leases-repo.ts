import {
  AuthLeaseSchema,
  type AuthLease,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption, withoutCreatedAt } from "./shared";

const decodeAuthLease = Schema.decodeUnknownSync(AuthLeaseSchema);

export const createAuthLeasesRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  getByAuthArtifactId: (authArtifactId: AuthLease["authArtifactId"]) =>
    client.use("rows.auth_leases.get_by_auth_artifact_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.authLeasesTable)
        .where(eq(tables.authLeasesTable.authArtifactId, authArtifactId))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeAuthLease(row.value))
        : Option.none<AuthLease>();
    }),

  listByWorkspaceId: (workspaceId: AuthLease["workspaceId"]) =>
    client.use("rows.auth_leases.list_by_workspace", async (db) => {
      const rows = await db
        .select()
        .from(tables.authLeasesTable)
        .where(eq(tables.authLeasesTable.workspaceId, workspaceId))
        .orderBy(
          asc(tables.authLeasesTable.updatedAt),
          asc(tables.authLeasesTable.id),
        );

      return rows.map((row) => decodeAuthLease(row));
    }),

  getByWorkspaceSourceAndActor: (input: {
    workspaceId: AuthLease["workspaceId"];
    sourceId: AuthLease["sourceId"];
    actorAccountId: AuthLease["actorAccountId"];
    slot: AuthLease["slot"];
  }) =>
    client.use("rows.auth_leases.get_by_workspace_source_actor", async (db) => {
      const rows = await db
        .select()
        .from(tables.authLeasesTable)
        .where(
          and(
            eq(tables.authLeasesTable.workspaceId, input.workspaceId),
            eq(tables.authLeasesTable.sourceId, input.sourceId),
            eq(tables.authLeasesTable.slot, input.slot),
            input.actorAccountId === null
              ? isNull(tables.authLeasesTable.actorAccountId)
              : eq(tables.authLeasesTable.actorAccountId, input.actorAccountId),
          ),
        )
        .orderBy(
          asc(tables.authLeasesTable.updatedAt),
          asc(tables.authLeasesTable.id),
        )
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeAuthLease(row.value))
        : Option.none<AuthLease>();
    }),

  upsert: (lease: AuthLease) =>
    client.use("rows.auth_leases.upsert", async (db) => {
      await db
        .insert(tables.authLeasesTable)
        .values(lease)
        .onConflictDoUpdate({
          target: [tables.authLeasesTable.authArtifactId],
          set: {
            ...withoutCreatedAt(lease),
          },
        });
    }),

  removeByAuthArtifactId: (authArtifactId: AuthLease["authArtifactId"]) =>
    client.use("rows.auth_leases.remove_by_auth_artifact_id", async (db) => {
      const deleted = await db
        .delete(tables.authLeasesTable)
        .where(eq(tables.authLeasesTable.authArtifactId, authArtifactId))
        .returning();

      return deleted.length > 0;
    }),

  removeByWorkspaceSourceAndActor: (input: {
    workspaceId: AuthLease["workspaceId"];
    sourceId: AuthLease["sourceId"];
    actorAccountId: AuthLease["actorAccountId"];
    slot?: AuthLease["slot"];
  }) =>
    client.use("rows.auth_leases.remove_by_workspace_source_actor", async (db) => {
      const deleted = await db
        .delete(tables.authLeasesTable)
        .where(
          and(
            eq(tables.authLeasesTable.workspaceId, input.workspaceId),
            eq(tables.authLeasesTable.sourceId, input.sourceId),
            input.slot === undefined
              ? undefined
              : eq(tables.authLeasesTable.slot, input.slot),
            input.actorAccountId === null
              ? isNull(tables.authLeasesTable.actorAccountId)
              : eq(tables.authLeasesTable.actorAccountId, input.actorAccountId),
          ),
        )
        .returning();

      return deleted.length > 0;
    }),

  removeByWorkspaceAndSourceId: (input: {
    workspaceId: AuthLease["workspaceId"];
    sourceId: AuthLease["sourceId"];
  }) =>
    client.use("rows.auth_leases.remove_by_workspace_source", async (db) => {
      const deleted = await db
        .delete(tables.authLeasesTable)
        .where(
          and(
            eq(tables.authLeasesTable.workspaceId, input.workspaceId),
            eq(tables.authLeasesTable.sourceId, input.sourceId),
          ),
        )
        .returning();

      return deleted.length;
    }),
});
