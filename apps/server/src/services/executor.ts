import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as SqlClient from "@effect/sql/SqlClient";
import { NodeFileSystem } from "@effect/platform-node";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createExecutor, scopeKv } from "@executor/sdk";
import {
  makeSqliteKv,
  makeKvConfig,
  makeScopedKv,
  migrate,
} from "@executor/storage-file";
import { withConfigFile } from "@executor/config";
import {
  openApiPlugin,
  makeKvOperationStore,
} from "@executor/plugin-openapi";
import {
  mcpPlugin,
  makeKvBindingStore,
} from "@executor/plugin-mcp";
import {
  googleDiscoveryPlugin,
  makeKvBindingStore as makeKvGoogleDiscoveryBindingStore,
} from "@executor/plugin-google-discovery";
import {
  graphqlPlugin,
  makeKvOperationStore as makeKvGraphqlOperationStore,
} from "@executor/plugin-graphql";
import { keychainPlugin } from "@executor/plugin-keychain";
import { fileSecretsPlugin } from "@executor/plugin-file-secrets";
import { onepasswordPlugin } from "@executor/plugin-onepassword";

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

const resolveDbPath = (): string => {
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");
  fs.mkdirSync(dataDir, { recursive: true });
  return `${dataDir}/data.db`;
};

// ---------------------------------------------------------------------------
// Create a local executor — returns the full typed executor
// ---------------------------------------------------------------------------

export const createLocalExecutor = async () => {
  const dbPath = resolveDbPath();

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* migrate.pipe(Effect.catchAll((e) => Effect.die(e)));

    const cwd = process.env.EXECUTOR_SCOPE_DIR || process.cwd();
    const kv = makeSqliteKv(sql);
    const config = makeKvConfig(kv, { cwd });
    const scopedKv = makeScopedKv(kv, cwd);

    const configPath = join(cwd, "executor.jsonc");
    const fsLayer = NodeFileSystem.layer;

    return yield* createExecutor({
      ...config,
      plugins: [
        openApiPlugin({
          operationStore: withConfigFile.openapi(
            makeKvOperationStore(scopedKv, "openapi"),
            configPath,
            fsLayer,
          ),
        }),
        mcpPlugin({
          bindingStore: withConfigFile.mcp(
            makeKvBindingStore(scopedKv, "mcp"),
            configPath,
            fsLayer,
          ),
        }),
        googleDiscoveryPlugin({
          bindingStore: makeKvGoogleDiscoveryBindingStore(
            scopedKv,
            "google-discovery",
          ),
        }),
        graphqlPlugin({
          operationStore: withConfigFile.graphql(
            makeKvGraphqlOperationStore(scopedKv, "graphql"),
            configPath,
            fsLayer,
          ),
        }),
        keychainPlugin(),
        fileSecretsPlugin(),
        onepasswordPlugin({
          kv: scopeKv(scopedKv, "onepassword"),
        }),
      ] as const,
    });
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: dbPath })),
  );

  return Effect.runPromise(program);
};

// ---------------------------------------------------------------------------
// Shared singleton for production, scoped handles for dev HMR
// ---------------------------------------------------------------------------

export type LocalExecutor = Awaited<ReturnType<typeof createLocalExecutor>>;

export const createExecutorHandle = async () => {
  const executor = await createLocalExecutor();
  return {
    executor,
    dispose: async () => {
      await Effect.runPromise(executor.close()).catch(() => undefined);
    },
  };
};

export type ExecutorHandle = Awaited<ReturnType<typeof createExecutorHandle>>;

let sharedHandlePromise: ReturnType<typeof createExecutorHandle> | null = null;

const loadSharedHandle = () => {
  if (!sharedHandlePromise) {
    sharedHandlePromise = createExecutorHandle();
  }
  return sharedHandlePromise;
};

export const getExecutor = () =>
  loadSharedHandle().then((handle) => handle.executor);

export const disposeExecutor = async (): Promise<void> => {
  const currentHandlePromise = sharedHandlePromise;
  sharedHandlePromise = null;

  const handle = await currentHandlePromise?.catch(() => null);
  await handle?.dispose().catch(() => undefined);
};

export const reloadExecutor = () => {
  disposeExecutor();
  return getExecutor();
};
