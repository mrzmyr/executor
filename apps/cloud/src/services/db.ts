// ---------------------------------------------------------------------------
// Database service — Hyperdrive on Cloudflare, node-postgres for local dev
// ---------------------------------------------------------------------------

import { Context, Effect, Layer } from "effect";
import * as sharedSchema from "@executor/storage-postgres/schema";
import * as cloudSchema from "./schema";
import type { DrizzleDb } from "@executor/storage-postgres";
import { server } from "../env";

const schema = { ...sharedSchema, ...cloudSchema };

export type { DrizzleDb };

// Migrations are run out-of-band (e.g. via a separate script or CI step),
// not at request time — Cloudflare Workers cannot read the filesystem.

type DbResource = {
  readonly db: DrizzleDb;
  readonly close: () => Promise<void>;
};

const createDbResource = async (): Promise<DbResource> => {
  // Resolve connection string: prefer Hyperdrive binding, fall back to DATABASE_URL env
  let connectionString: string | undefined;
  try {
    const { env } = await import("cloudflare:workers");
    const hyperdrive = (env as any).HYPERDRIVE;
    if (hyperdrive?.connectionString) {
      connectionString = hyperdrive.connectionString;
    }
  } catch {
    // Not running on Cloudflare — fall back to env var
  }
  connectionString ??= server.DATABASE_URL || undefined;

  if (connectionString) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString });
    const db = drizzle(pool, { schema }) as DrizzleDb;
    return {
      db,
      close: () => pool.end(),
    };
  }

  // Local dev fallback: PGlite
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dataDir = server.PGLITE_DATA_DIR;
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema }) as DrizzleDb;
  return {
    db,
    close: async () => {
      const closeClient = client.close;
      if (closeClient) {
        await closeClient.call(client);
      }
    },
  };
};

const closeDbResource = (resource: DbResource) =>
  Effect.promise(() => resource.close()).pipe(
    Effect.orElseSucceed(() => undefined),
  );

export class DbService extends Context.Tag("@executor/cloud/DbService")<
  DbService,
  DrizzleDb
>() {
  static Live = Layer.scoped(
    this,
    Effect.acquireRelease(
      Effect.promise(() => createDbResource()),
      closeDbResource,
    ).pipe(Effect.map((resource) => resource.db)),
  );
}
