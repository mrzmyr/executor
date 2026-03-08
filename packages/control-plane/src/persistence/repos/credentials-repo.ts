import {
  CredentialSchema,
  type Credential,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { asc, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption, withoutCreatedAt } from "./shared";

const decodeCredential = Schema.decodeUnknownSync(CredentialSchema);

export const createCredentialsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listByWorkspaceId: (workspaceId: Credential["workspaceId"]) =>
    client.use("rows.credentials.list_by_workspace", async (db) => {
      const rows = await db
        .select()
        .from(tables.credentialsTable)
        .where(eq(tables.credentialsTable.workspaceId, workspaceId))
        .orderBy(
          asc(tables.credentialsTable.updatedAt),
          asc(tables.credentialsTable.id),
        );

      return rows.map((row) => decodeCredential(row));
    }),

  getById: (id: Credential["id"]) =>
    client.use("rows.credentials.get_by_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.credentialsTable)
        .where(eq(tables.credentialsTable.id, id))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeCredential(row.value))
        : Option.none<Credential>();
    }),

  upsert: (credential: Credential) =>
    client.use("rows.credentials.upsert", async (db) => {
      await db
        .insert(tables.credentialsTable)
        .values(credential)
        .onConflictDoUpdate({
          target: [tables.credentialsTable.id],
          set: {
            ...withoutCreatedAt(credential),
          },
        });
    }),

  removeById: (id: Credential["id"]) =>
    client.use("rows.credentials.remove", async (db) => {
      const deleted = await db
        .delete(tables.credentialsTable)
        .where(eq(tables.credentialsTable.id, id))
        .returning();

      return deleted.length > 0;
    }),
});
