import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { makeToolInvokerFromTools } from "@executor-v3/codemode-core";
import {
  ControlPlaneActorResolver,
  ControlPlaneService,
  makeControlPlaneApiLayer,
  makeSqlControlPlaneRuntime,
  type ResolveExecutionEnvironment,
  type SqlControlPlaneRuntime,
} from "@executor-v3/control-plane";
import { makeInProcessExecutor } from "@executor-v3/runtime-local-inproc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import {
  DEFAULT_LOCAL_DATA_DIR,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from "./config";

export type LocalExecutorServer = {
  readonly runtime: SqlControlPlaneRuntime;
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string;
};

export type StartLocalExecutorServerOptions = {
  readonly port?: number;
  readonly host?: string;
  readonly localDataDir?: string;
  readonly executionResolver?: ResolveExecutionEnvironment;
};

const defaultExecutionResolver: ResolveExecutionEnvironment = () =>
  Effect.succeed({
    executor: makeInProcessExecutor(),
    toolInvoker: makeToolInvokerFromTools({ tools: {} }),
  });

const disposeRuntime = (runtime: SqlControlPlaneRuntime) =>
  Effect.tryPromise({
    try: async () => {
      await runtime.close();
      await runtime.webHandler.dispose();
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.orDie);

const makeControlPlaneServerLayer = (input: {
  runtime: SqlControlPlaneRuntime;
  host: string;
  port: number;
}) => {
  const serviceLayer = Layer.succeed(ControlPlaneService, input.runtime.service);
  const actorResolverLayer = Layer.succeed(
    ControlPlaneActorResolver,
    input.runtime.actorResolver,
  );
  const apiLayer = makeControlPlaneApiLayer(serviceLayer, actorResolverLayer);

  return HttpApiBuilder.serve().pipe(
    Layer.provide(apiLayer),
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        host: input.host,
        port: input.port,
      }),
    ),
  );
};

export const makeLocalExecutorServer = (
  options: StartLocalExecutorServerOptions = {},
): Effect.Effect<LocalExecutorServer, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const host = options.host ?? DEFAULT_SERVER_HOST;
    const port = options.port ?? DEFAULT_SERVER_PORT;
    const localDataDir = options.localDataDir ?? DEFAULT_LOCAL_DATA_DIR;

    if (localDataDir !== ":memory:") {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(localDataDir), { recursive: true }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
    }

    const runtime = yield* Effect.acquireRelease(
      makeSqlControlPlaneRuntime({
        localDataDir,
        executionResolver: options.executionResolver ?? defaultExecutionResolver,
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      ),
      disposeRuntime,
    );

    const serverContext = yield* Layer.build(
      makeControlPlaneServerLayer({
        runtime,
        host,
        port,
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    const server = Context.get(serverContext, HttpServer.HttpServer);
    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.fail(new Error("Local executor server did not bind to a TCP address"));
    }

    return {
      runtime,
      host: server.address.hostname,
      port: server.address.port,
      baseUrl: `http://${server.address.hostname}:${server.address.port}`,
    } satisfies LocalExecutorServer;
  });

export const runLocalExecutorServer = (
  options: StartLocalExecutorServerOptions = {},
): Effect.Effect<void, Error, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* makeLocalExecutorServer(options);
      console.error(`executor server listening on ${server.baseUrl}`);

      yield* Effect.async<void, never>((resume) => {
        const shutdown = () => resume(Effect.void);
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);

        return Effect.sync(() => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
        });
      });
    }),
  );
