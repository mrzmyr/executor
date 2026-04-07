// ---------------------------------------------------------------------------
// Cloud API — core handlers from @executor/api + cloud-specific plugins
// ---------------------------------------------------------------------------

import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { Effect, Layer } from "effect";

import { addGroup, CoreHandlers, ExecutorService, ExecutionEngineService } from "@executor/api";
import { createExecutionEngine } from "@executor/execution";
import { makeUserStore } from "@executor/storage-postgres";
import { OpenApiGroup, OpenApiExtensionService, OpenApiHandlers } from "@executor/plugin-openapi/api";
import { McpGroup, McpExtensionService, McpHandlers } from "@executor/plugin-mcp/api";
import { GoogleDiscoveryGroup, GoogleDiscoveryExtensionService, GoogleDiscoveryHandlers } from "@executor/plugin-google-discovery/api";
import { GraphqlGroup, GraphqlExtensionService, GraphqlHandlers } from "@executor/plugin-graphql/api";

import { createTeamExecutor } from "./services/executor";
import { parseSessionId, validateSession } from "./auth/session";
import type { DrizzleDb } from "./services/db";

// ---------------------------------------------------------------------------
// Cloud API — core + cloud plugins (no onepassword)
// ---------------------------------------------------------------------------

const CloudApi = addGroup(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(GraphqlGroup);

const CloudApiBase = HttpApiBuilder.api(CloudApi).pipe(
  Layer.provide(CoreHandlers),
  Layer.provide(Layer.mergeAll(
    OpenApiHandlers,
    McpHandlers,
    GoogleDiscoveryHandlers,
    GraphqlHandlers,
  )),
);

// ---------------------------------------------------------------------------
// Create API handler with auth-based executor resolution
// ---------------------------------------------------------------------------

export const createCloudApiHandler = (db: DrizzleDb, encryptionKey: string) => {
  const userStore = makeUserStore(db);

  return async (request: Request): Promise<Response> => {
    const sessionId = parseSessionId(request.headers.get("cookie"));
    if (!sessionId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const session = await validateSession(userStore, sessionId);
    if (!session) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }

    const user = await userStore.getUser(session.userId);
    if (!user) {
      return Response.json({ error: "User not found" }, { status: 401 });
    }

    const team = await userStore.getTeam(session.teamId);
    const teamName = team?.name ?? "Unknown Team";

    const executor = await Effect.runPromise(
      createTeamExecutor(db, session.teamId, teamName, encryptionKey),
    );

    const pluginExtensions = Layer.mergeAll(
      Layer.succeed(OpenApiExtensionService, executor.openapi),
      Layer.succeed(McpExtensionService, executor.mcp),
      Layer.succeed(GoogleDiscoveryExtensionService, executor.googleDiscovery),
      Layer.succeed(GraphqlExtensionService, executor.graphql),
    );

    const engine = createExecutionEngine({ executor });

    const handler = HttpApiBuilder.toWebHandler(
      HttpApiSwagger.layer().pipe(
        Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
        Layer.provideMerge(CloudApiBase),
        Layer.provideMerge(pluginExtensions),
        Layer.provideMerge(Layer.succeed(ExecutorService, executor)),
        Layer.provideMerge(Layer.succeed(ExecutionEngineService, engine)),
        Layer.provideMerge(HttpServer.layerContext),
      ),
      { middleware: HttpMiddleware.logger },
    );

    try {
      return await handler.handler(request);
    } finally {
      await Effect.runPromise(executor.close()).catch(() => undefined);
      handler.dispose();
    }
  };
};
