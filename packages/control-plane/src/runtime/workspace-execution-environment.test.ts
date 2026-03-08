import { randomUUID } from "node:crypto";

import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpServer,
} from "@effect/platform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it } from "@effect/vitest";
import {
  AccountIdSchema,
  CredentialIdSchema,
  ExecutionIdSchema,
  SecretMaterialIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { z } from "zod/v4";

import {
  createSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "#persistence";
import type { SourceId, WorkspaceId } from "#schema";

import {
  createRuntimeSourceAuthService,
  type RuntimeSourceAuthService,
} from "./source-auth-service";
import { createLiveExecutionManager } from "./live-execution";
import { createWorkspaceExecutionEnvironmentResolver } from "./workspace-execution-environment";

type CountedMcpServer = {
  endpoint: string;
  counts: {
    listTools: number;
    callTool: number;
  };
  close: () => Promise<void>;
};

type OpenApiSpecServer = {
  baseUrl: string;
  specUrl: string;
  seenAuthHeaders: Array<string | null>;
  close: () => Promise<void>;
};

const closeScope = (scope: Scope.CloseableScope) =>
  Scope.close(scope, Exit.void).pipe(Effect.orDie);

const makePersistence = Effect.acquireRelease(
  createSqlControlPlanePersistence({
    localDataDir: ":memory:",
  }),
  (persistence) =>
    Effect.tryPromise({
      try: () => persistence.close(),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.orDie),
);

const makeCountedMcpServer = Effect.acquireRelease(
  Effect.promise<CountedMcpServer>(
    () =>
      new Promise<CountedMcpServer>((resolve, reject) => {
        const counts = {
          listTools: 0,
          callTool: 0,
        };
        let closed = false;
        const app = createMcpExpressApp({ host: "127.0.0.1" });
        const transports: Record<string, StreamableHTTPServerTransport> = {};
        const servers: Record<string, McpServer> = {};

        const createServer = () => {
          const server = new McpServer(
            {
              name: "workspace-execution-environment-test-server",
              version: "1.0.0",
            },
            {
              capabilities: {
                tools: {},
              },
            },
          );

          server.registerTool(
            "echo",
            {
              description: "Echo the provided string",
              inputSchema: {
                value: z.string(),
              },
            },
            async ({ value }: { value: string }) => ({
              content: [{ type: "text", text: `echo:${value}` }],
            }),
          );

          return server;
        };

        const countMethods = (body: unknown) => {
          const payloads = Array.isArray(body) ? body : [body];
          for (const payload of payloads) {
            if (!payload || typeof payload !== "object") {
              continue;
            }

            const method = "method" in payload ? payload.method : undefined;
            if (method === "tools/list") {
              counts.listTools += 1;
            } else if (method === "tools/call") {
              counts.callTool += 1;
            }
          }
        };

        app.post("/mcp", async (req: any, res: any) => {
          countMethods(req.body);

          const sessionIdHeader = req.headers["mcp-session-id"];
          const sessionId =
            typeof sessionIdHeader === "string"
              ? sessionIdHeader
              : Array.isArray(sessionIdHeader)
                ? sessionIdHeader[0]
                : undefined;

          try {
            let transport: StreamableHTTPServerTransport;

            if (sessionId && transports[sessionId]) {
              transport = transports[sessionId];
            } else {
              transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId) => {
                  transports[newSessionId] = transport;
                },
              });

              transport.onclose = () => {
                const closedSessionId = transport.sessionId;
                if (closedSessionId && transports[closedSessionId]) {
                  delete transports[closedSessionId];
                }
                if (closedSessionId && servers[closedSessionId]) {
                  void servers[closedSessionId].close().catch(() => undefined);
                  delete servers[closedSessionId];
                }
              };

              const server = createServer();
              await server.connect(transport);
              const newSessionId = transport.sessionId;
              if (newSessionId) {
                servers[newSessionId] = server;
              }
            }

            await transport.handleRequest(req, res, req.body);
          } catch (error) {
            if (!res.headersSent) {
              res.status(500).json({
                jsonrpc: "2.0",
                error: {
                  code: -32603,
                  message:
                    error instanceof Error ? error.message : "Internal server error",
                },
                id: null,
              });
            }
          }
        });

        app.get("/mcp", async (req: any, res: any) => {
          const sessionIdHeader = req.headers["mcp-session-id"];
          const sessionId =
            typeof sessionIdHeader === "string"
              ? sessionIdHeader
              : Array.isArray(sessionIdHeader)
                ? sessionIdHeader[0]
                : undefined;

          if (!sessionId || !transports[sessionId]) {
            res.status(400).send("Invalid or missing session ID");
            return;
          }

          await transports[sessionId].handleRequest(req, res);
        });

        app.delete("/mcp", async (req: any, res: any) => {
          const sessionIdHeader = req.headers["mcp-session-id"];
          const sessionId =
            typeof sessionIdHeader === "string"
              ? sessionIdHeader
              : Array.isArray(sessionIdHeader)
                ? sessionIdHeader[0]
                : undefined;

          if (!sessionId || !transports[sessionId]) {
            res.status(400).send("Invalid or missing session ID");
            return;
          }

          const transport = transports[sessionId];
          await transport.handleRequest(req, res, req.body);
          await transport.close();
          delete transports[sessionId];

          if (servers[sessionId]) {
            await servers[sessionId].close().catch(() => undefined);
            delete servers[sessionId];
          }
        });

        const listener = app.listen(0, "127.0.0.1", () => {
          const address = listener.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve MCP test server address"));
            return;
          }

          resolve({
            endpoint: `http://127.0.0.1:${address.port}/mcp`,
            counts,
            close: async () => {
              if (closed) {
                return;
              }
              closed = true;

              for (const transport of Object.values(transports)) {
                await transport.close().catch(() => undefined);
              }

              for (const server of Object.values(servers)) {
                await server.close().catch(() => undefined);
              }

              await new Promise<void>((closeResolve, closeReject) => {
                listener.close((error: Error | undefined) => {
                  if (error) {
                    closeReject(error);
                    return;
                  }
                  closeResolve();
                });
              });
            },
          });
        });

        listener.once("error", reject);
      }),
  ),
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.orDie),
);

const ownerParam = HttpApiSchema.param("owner", Schema.String);
const repoParam = HttpApiSchema.param("repo", Schema.String);

class GeneratedReposApi extends HttpApiGroup.make("repos")
  .add(
    HttpApiEndpoint.get("getRepo")`/repos/${ownerParam}/${repoParam}`
      .addSuccess(
        Schema.Struct({
          ok: Schema.Boolean,
          full_name: Schema.String,
        }),
      ),
  ) {}

class GeneratedApi extends HttpApi.make("generated").add(GeneratedReposApi) {}

const makeOpenApiSpecServer = Effect.acquireRelease(
  Effect.gen(function* () {
    const seenAuthHeaders: OpenApiSpecServer["seenAuthHeaders"] = [];
    const handlersLayer = HttpApiBuilder.group(GeneratedApi, "repos", (handlers) =>
      handlers.handle("getRepo", ({ path, request }) =>
        Effect.sync(() => {
          seenAuthHeaders.push(
            typeof request.headers.authorization === "string"
              ? request.headers.authorization
              : null,
          );

          return {
            ok: true,
            full_name: `${path.owner}/${path.repo}`,
          };
        })
      )
    );
    const apiLayer = HttpApiBuilder.api(GeneratedApi).pipe(
      Layer.provide(handlersLayer),
    );
    const serverLayer = HttpApiBuilder.serve().pipe(
      Layer.provide(HttpApiBuilder.middlewareOpenApi()),
      Layer.provide(apiLayer),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(serverLayer, scope).pipe(
      Effect.catchAll((error) =>
        closeScope(scope).pipe(
          Effect.zipRight(Effect.fail(error)),
        )),
    );
    const server = Context.get(context, HttpServer.HttpServer);
    const baseUrl = HttpServer.formatAddress(server.address);

    return {
      baseUrl,
      specUrl: new URL("/openapi.json", baseUrl).toString(),
      seenAuthHeaders,
      close: () => Effect.runPromise(closeScope(scope)),
    } satisfies OpenApiSpecServer;
  }),
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.orDie),
);

const persistConnectedEchoTool = (input: {
  persistence: SqlControlPlanePersistence;
  endpoint: string;
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}) =>
  Effect.gen(function* () {
    const now = Date.now();

    yield* input.persistence.rows.sources.insert({
      id: input.sourceId,
      workspaceId: input.workspaceId,
      name: "Counted MCP",
      kind: "mcp",
      endpoint: input.endpoint,
      status: "connected",
      enabled: true,
      namespace: "counted",
      transport: "auto",
      queryParamsJson: null,
      headersJson: null,
      specUrl: null,
      defaultHeadersJson: null,
      sourceHash: null,
      sourceDocumentText: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    yield* input.persistence.rows.toolArtifacts.replaceForSource({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      artifacts: [{
        artifact: {
          workspaceId: input.workspaceId,
          path: "counted.echo",
          toolId: "echo",
          sourceId: input.sourceId,
          title: "echo",
          description: "Echo the provided string",
          searchNamespace: "counted.echo",
          searchText: "counted.echo echo provided string",
          inputSchemaJson: JSON.stringify({
            type: "object",
            properties: {
              value: {
                type: "string",
              },
            },
            required: ["value"],
            additionalProperties: false,
          }),
          outputSchemaJson: null,
          providerKind: "mcp",
          mcpToolName: "echo",
          openApiMethod: null,
          openApiPathTemplate: null,
          openApiOperationHash: null,
          openApiRawToolId: null,
          openApiOperationId: null,
          openApiTagsJson: null,
          openApiRequestBodyRequired: null,
          createdAt: now,
          updatedAt: now,
        },
      }],
    });
  });

const persistConnectedGithubOpenApiSource = (input: {
  persistence: SqlControlPlanePersistence;
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  endpoint?: string;
  auth?: {
    providerId: string;
    handle: string;
  } | null;
}) =>
  Effect.gen(function* () {
    const now = Date.now();
    const openApiDocumentText = JSON.stringify({
      openapi: "3.0.3",
      info: {
        title: "GitHub",
        version: "1.0.0",
      },
      paths: {
        "/repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}": {
          get: {
            operationId: "actions/get-environment-secret",
            tags: ["actions"],
            summary: "Get an environment secret",
            description:
              "Gets a single environment secret without revealing its encrypted value. Authenticated users must have collaborator access to a repository to create, update, or read secrets.",
            parameters: [
              { name: "owner", in: "path", required: true, schema: { type: "string" } },
              { name: "repo", in: "path", required: true, schema: { type: "string" } },
              { name: "environment_name", in: "path", required: true, schema: { type: "string" } },
              { name: "secret_name", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
        "/orgs/{org}/actions/runners/{runner_id}": {
          get: {
            operationId: "actions/get-self-hosted-runner-for-org",
            tags: ["actions"],
            summary: "Get a self-hosted runner for an organization",
            description:
              "Gets a specific self-hosted runner configured in an organization. Authenticated users must have admin access to the organization to use this endpoint.",
            parameters: [
              { name: "org", in: "path", required: true, schema: { type: "string" } },
              { name: "runner_id", in: "path", required: true, schema: { type: "integer" } },
            ],
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
        "/repos/{owner}/{repo}": {
          get: {
            operationId: "repos/get-repo",
            tags: ["repos"],
            summary: "Get a repository",
            description: "Gets a repository by owner and name.",
            parameters: [
              { name: "owner", in: "path", required: true, schema: { type: "string" } },
              { name: "repo", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
        "/user": {
          get: {
            operationId: "users/get-authenticated",
            tags: ["users"],
            summary: "Get the authenticated user",
            description:
              "Gets the authenticated user. OAuth app tokens and personal access tokens need the user scope to include private profile information.",
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    });

    yield* input.persistence.rows.sources.insert({
      id: input.sourceId,
      workspaceId: input.workspaceId,
      name: "GitHub",
      kind: "openapi",
      endpoint: input.endpoint ?? "https://api.github.com",
      status: "connected",
      enabled: true,
      namespace: "github",
      transport: null,
      queryParamsJson: null,
      headersJson: null,
      specUrl: "https://example.com/github-openapi.json",
      defaultHeadersJson: null,
      sourceHash: null,
      sourceDocumentText: openApiDocumentText,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    if (input.auth) {
      const credentialId = CredentialIdSchema.make(`cred_${randomUUID()}`);
      yield* input.persistence.rows.credentials.upsert({
        id: credentialId,
        workspaceId: input.workspaceId,
        authKind: "bearer",
        authHeaderName: "Authorization",
        authPrefix: "Bearer ",
        tokenProviderId: input.auth.providerId,
        tokenHandle: input.auth.handle,
        refreshTokenProviderId: null,
        refreshTokenHandle: null,
        createdAt: now,
        updatedAt: now,
      });
      yield* input.persistence.rows.sourceCredentialBindings.upsert({
        id: `src_cred_bind_${randomUUID()}`,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        credentialId,
        createdAt: now,
        updatedAt: now,
      });
    };

  });

const makeResolver = (persistence: SqlControlPlanePersistence) =>
  createWorkspaceExecutionEnvironmentResolver({
    rows: persistence.rows,
    sourceAuthService: {
      getLocalServerBaseUrl: () => null,
      storeSecretMaterial: () => Effect.fail(new Error("not implemented in test")),
      getSourceById: () => Effect.fail(new Error("not implemented in test")),
      addExecutorSource: () => Effect.fail(new Error("not implemented in test")),
      completeSourceCredentialSetup: () => Effect.fail(new Error("not implemented in test")),
    } as RuntimeSourceAuthService,
  });

const makeResolverWithLiveSourceAuth = (persistence: SqlControlPlanePersistence) =>
  createWorkspaceExecutionEnvironmentResolver({
    rows: persistence.rows,
    sourceAuthService: createRuntimeSourceAuthService({
      rows: persistence.rows,
      liveExecutionManager: createLiveExecutionManager(),
      getLocalServerBaseUrl: () => "http://127.0.0.1:8788",
    }),
  });

describe("workspace-execution-environment", () => {
  it.scoped("discovers persisted tools without live MCP listing", () =>
    Effect.gen(function* () {
      const server = yield* makeCountedMcpServer;
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_catalog");
      const sourceId = SourceIdSchema.make("src_catalog");
      yield* persistConnectedEchoTool({
        persistence,
        endpoint: server.endpoint,
        workspaceId,
        sourceId,
      });

      yield* Effect.tryPromise({
        try: () => server.close(),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(Effect.orDie);

      const resolveEnvironment = makeResolver(persistence);
      const environment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_catalog"),
        executionId: ExecutionIdSchema.make("exec_catalog"),
      });

      const discovered = (yield* environment.toolInvoker.invoke({
        path: "discover",
        args: {
          query: "echo string",
          limit: 5,
        },
      })) as {
        bestPath: string | null;
        total: number;
        results: Array<{ path: string }>;
      };

      expect(discovered.bestPath).toBe("counted.echo");
      expect(discovered.total).toBeGreaterThan(0);
      expect(server.counts.listTools).toBe(0);
      expect(server.counts.callTool).toBe(0);
    }),
  );

  it.scoped("prefers namespace and path matches over noisy GitHub boilerplate", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_github_discovery");
      const sourceId = SourceIdSchema.make("src_github_discovery");
      yield* persistConnectedGithubOpenApiSource({
        persistence,
        workspaceId,
        sourceId,
      });

      const resolveEnvironment = makeResolver(persistence);
      const environment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_github_discovery"),
        executionId: ExecutionIdSchema.make("exec_github_discovery"),
      });

      const firstQuery = (yield* environment.toolInvoker.invoke({
        path: "discover",
        args: {
          query: "current authenticated user profile",
          limit: 5,
        },
      })) as {
        bestPath: string | null;
        results: Array<{ path: string }>;
      };

      expect(firstQuery.bestPath).toBe("github.users.getAuthenticated");
      expect(firstQuery.results[0]?.path).toBe("github.users.getAuthenticated");

      const secondQuery = (yield* environment.toolInvoker.invoke({
        path: "discover",
        args: {
          query: "users get myself current user profile",
          limit: 5,
        },
      })) as {
        bestPath: string | null;
        results: Array<{ path: string }>;
      };

      expect(secondQuery.bestPath).toBe("github.users.getAuthenticated");
      expect(secondQuery.results[0]?.path).toBe("github.users.getAuthenticated");
    }),
  );

  it.scoped("invokes persisted MCP tools on demand without re-listing", () =>
    Effect.gen(function* () {
      const server = yield* makeCountedMcpServer;
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_invoke");
      const sourceId = SourceIdSchema.make("src_invoke");
      yield* persistConnectedEchoTool({
        persistence,
        endpoint: server.endpoint,
        workspaceId,
        sourceId,
      });

      const resolveEnvironment = makeResolver(persistence);
      const environment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_invoke"),
        executionId: ExecutionIdSchema.make("exec_invoke"),
      });

      const result = (yield* environment.toolInvoker.invoke({
        path: "counted.echo",
        args: {
          value: "hello",
        },
      })) as {
        content?: Array<{ text?: string }>;
      };

      expect(server.counts.listTools).toBe(0);
      expect(server.counts.callTool).toBe(1);
      expect(result.content?.[0]?.text).toBe("echo:hello");
    }),
  );

  it.scoped("adds an OpenAPI source through executor.sources.add with elicited credentials", () =>
    Effect.gen(function* () {
      const specServer = yield* makeOpenApiSpecServer;
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_add_openapi");
      const resolveEnvironment = makeResolverWithLiveSourceAuth(persistence);
      const now = Date.now();
      const tokenSecretMaterialId = SecretMaterialIdSchema.make(
        "sec_test_openapi_bearer",
      );
      yield* persistence.rows.secretMaterials.upsert({
        id: tokenSecretMaterialId,
        purpose: "auth_material",
        value: "ghp_test_token",
        createdAt: now,
        updatedAt: now,
      });
      let capturedElicitation:
        | {
            mode?: string;
            url?: string;
            elicitationId?: string;
          }
        | null = null;

      const environment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_add_openapi"),
        executionId: ExecutionIdSchema.make("exec_add_openapi"),
        onElicitation: (request) =>
          Effect.sync(() => {
            capturedElicitation = request.elicitation as {
              mode?: string;
              url?: string;
              elicitationId?: string;
            };

            return {
              action: "accept" as const,
              content: {
                authKind: "bearer",
                tokenRef: {
                  providerId: "postgres",
                  handle: tokenSecretMaterialId,
                },
              },
            };
          }),
      });

      const added = (yield* environment.toolInvoker.invoke({
        path: "executor.sources.add",
        args: {
          kind: "openapi",
          endpoint: specServer.baseUrl,
          specUrl: specServer.specUrl,
          name: "GitHub",
          namespace: "github",
        },
        context: {
          runId: "exec_add_openapi",
        },
      })) as {
        id: SourceId;
        kind: string;
        status: string;
        auth: {
          kind: string;
          token?: {
            providerId: string;
          };
        };
      };

      expect(added.kind).toBe("openapi");
      expect(added.status).toBe("connected");
      expect(added.auth.kind).toBe("bearer");
      expect(added.auth.token?.providerId).toBe("postgres");
      expect(capturedElicitation).toMatchObject({
        mode: "url",
        url: expect.stringContaining("/v1/workspaces/"),
        elicitationId: expect.stringContaining("executor.sources.add:"),
      });
      expect((capturedElicitation as { url?: string } | null)?.url).toContain(
        encodeURIComponent("exec_add_openapi:executor.sources.add:"),
      );

      const storedSource = yield* persistence.rows.sources.getByWorkspaceAndId(
        workspaceId,
        added.id,
      );
      expect(Option.isSome(storedSource)).toBe(true);
      if (Option.isSome(storedSource)) {
        expect(storedSource.value.sourceDocumentText).toContain('"operationId":"repos.getRepo"');
      }

      const freshEnvironment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_add_openapi_fresh"),
        executionId: ExecutionIdSchema.make("exec_add_openapi_fresh"),
      });

      const discovered = (yield* freshEnvironment.toolInvoker.invoke({
        path: "discover",
        args: {
          query: "github repo",
          limit: 5,
        },
      })) as {
        bestPath: string | null;
      };

      expect(discovered.bestPath).toBe("github.repos.getRepo");

      const invoked = (yield* freshEnvironment.toolInvoker.invoke({
        path: "github.repos.getRepo",
        args: {
          owner: "vercel",
          repo: "ai",
        },
      })) as {
        status: number;
        body: {
          ok: boolean;
          full_name: string;
        };
      };

      expect(invoked.status).toBe(200);
      expect(invoked.body).toEqual({
        ok: true,
        full_name: "vercel/ai",
      });
      expect(specServer.seenAuthHeaders).toEqual(["Bearer ghp_test_token"]);
    }),
  );

  it.scoped("resolves params-backed source auth from invocation context", () =>
    Effect.gen(function* () {
      const specServer = yield* makeOpenApiSpecServer;
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_params_auth");
      const sourceId = SourceIdSchema.make("src_params_auth");

      yield* persistConnectedGithubOpenApiSource({
        persistence,
        workspaceId,
        sourceId,
        endpoint: specServer.baseUrl,
        auth: {
          providerId: "params",
          handle: "githubToken",
        },
      });

      const resolveEnvironment = makeResolver(persistence);
      const environment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_params_auth"),
        executionId: ExecutionIdSchema.make("exec_params_auth"),
      });

      const invoked = (yield* environment.toolInvoker.invoke({
        path: "github.repos.getRepo",
        args: {
          owner: "vercel",
          repo: "ai",
        },
        context: {
          params: {
            githubToken: "ghp_from_params",
          },
        },
      })) as {
        status: number;
        body: {
          ok: boolean;
          full_name: string;
        };
      };

      expect(invoked.status).toBe(200);
      expect(invoked.body).toEqual({
        ok: true,
        full_name: "vercel/ai",
      });
      expect(specServer.seenAuthHeaders).toEqual(["Bearer ghp_from_params"]);
    }),
  );

  it.scoped("describes executor.sources.add with derived type info and schemas", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const resolveEnvironment = makeResolverWithLiveSourceAuth(persistence);

      const environment = yield* resolveEnvironment({
        workspaceId: WorkspaceIdSchema.make("ws_describe_add_source"),
        accountId: AccountIdSchema.make("acc_describe_add_source"),
        executionId: ExecutionIdSchema.make("exec_describe_add_source"),
      });

      const described = (yield* environment.toolInvoker.invoke({
        path: "describe.tool",
        args: {
          path: "executor.sources.add",
          includeSchemas: true,
        },
      })) as {
        path: string;
        description?: string;
        inputType?: string;
        inputSchemaJson?: string;
      } | null;

      expect(described?.path).toBe("executor.sources.add");
      expect(described?.description).toContain("Source add input shapes:");
      expect(described?.description).toContain("specUrl");
      expect(described?.description).toContain("credential setup");
      expect(described?.inputType).toContain("endpoint");
      expect(described?.inputType).not.toContain("auth");

      const inputSchema = described?.inputSchemaJson
        ? JSON.parse(described.inputSchemaJson) as Record<string, unknown>
        : null;
      expect(inputSchema).not.toBeNull();
      expect(JSON.stringify(inputSchema)).toContain("specUrl");
      expect(JSON.stringify(inputSchema)).toContain("endpoint");
      expect(JSON.stringify(inputSchema)).not.toContain("\"auth\"");
    }),
  );
});
