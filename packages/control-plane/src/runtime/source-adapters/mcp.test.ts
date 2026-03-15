import { randomUUID } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it } from "@effect/vitest";
import { SourceIdSchema } from "#schema";

import * as Effect from "effect/Effect";
import { z } from "zod/v4";

import { createSourceFromPayload } from "../source-definitions";
import { mcpSourceAdapter } from "./mcp";

type RealMcpServer = {
  endpoint: string;
  close: () => Promise<void>;
};

const makeRealMcpServer = Effect.acquireRelease(
  Effect.promise<RealMcpServer>(
    () =>
      new Promise<RealMcpServer>((resolve, reject) => {
        const createServerForRequest = () => {
          const mcp = new McpServer(
            {
              name: "mcp-adapter-test-server",
              version: "1.0.0",
              title: "Adapter Test Server",
              description: "Server for MCP adapter tests",
              websiteUrl: "https://example.test/mcp",
            },
            {
              capabilities: {
                tools: {
                  listChanged: true,
                },
                logging: {},
              },
            },
          );

          mcp.registerTool(
            "read_file",
            {
              title: "Read File",
              description: "Read a file from memory",
              inputSchema: {
                path: z.string(),
              },
              annotations: {
                title: "Read File (Annotated)",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              _meta: {
                category: "filesystem",
              },
            },
            async ({ path }: { path: string }) => ({
              content: [{
                type: "text",
                text: `read:${path}`,
              }],
            }),
          );

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });

          return {
            mcp,
            transport,
          };
        };

        const app = createMcpExpressApp({ host: "127.0.0.1" });

        const handle = async (req: any, res: any, parsedBody?: unknown) => {
          const { mcp, transport } = createServerForRequest();

          try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res, parsedBody);
          } finally {
            await transport.close().catch(() => undefined);
            await mcp.close().catch(() => undefined);
          }
        };

        app.post("/mcp", async (req: any, res: any) => {
          await handle(req, res, req.body);
        });

        app.get("/mcp", async (req: any, res: any) => {
          await handle(req, res);
        });

        app.delete("/mcp", async (req: any, res: any) => {
          await handle(req, res, req.body);
        });

        const listener = app.listen(0, "127.0.0.1", () => {
          const address = listener.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve MCP adapter test server address"));
            return;
          }

          resolve({
            endpoint: `http://127.0.0.1:${address.port}/mcp`,
            close: async () => {
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
  (server: RealMcpServer) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.orDie),
);

describe("mcp source adapter", () => {
  it.scoped("syncs MCP annotations and introspection metadata into snapshot", () =>
    Effect.gen(function* () {
      const realServer = yield* makeRealMcpServer;
      const source = yield* createSourceFromPayload({
        workspaceId: "ws_test" as any,
        sourceId: SourceIdSchema.make(`src_${randomUUID()}`),
        payload: {
          name: "MCP Demo",
          kind: "mcp",
          endpoint: realServer.endpoint,
          namespace: "mcp.demo",
          binding: {
            transport: "streamable-http",
            queryParams: null,
            headers: null,
          },
          importAuthPolicy: "reuse_runtime",
          importAuth: { kind: "none" },
          auth: { kind: "none" },
          status: "connected",
          enabled: true,
        },
        now: Date.now(),
      });

      const syncResult = yield* mcpSourceAdapter.syncCatalog({
        source,
        resolveSecretMaterial: () =>
          Effect.fail(new Error("unexpected secret lookup")),
        resolveAuthMaterialForSlot: () =>
          Effect.succeed({
            placements: [],
            headers: {},
            queryParams: {},
            cookies: {},
            bodyValues: {},
            expiresAt: null,
            refreshAfter: null,
          }),
      });

      const capability = Object.values(syncResult.snapshot.catalog.capabilities)[0]!;
      const executable = Object.values(syncResult.snapshot.catalog.executables)[0]!;
      const document = Object.values(syncResult.snapshot.catalog.documents)[0]!;
      const rawManifest = document.native?.[0]?.value;

      expect(capability.surface.title).toBe("Read File");
      expect(capability.semantics).toMatchObject({
        effect: "read",
        safe: true,
        idempotent: true,
        destructive: false,
      });
      expect(capability.native).toBeUndefined();
      expect(executable.native).toBeUndefined();

      expect(typeof rawManifest).toBe("string");
      const manifest = JSON.parse(rawManifest as string) as {
        server?: {
          info?: {
            name?: string;
          };
        };
        tools?: Array<Record<string, unknown>>;
        listTools?: {
          rawResult?: {
            tools?: Array<Record<string, unknown>>;
          };
        };
      };

      expect(manifest.server?.info?.name).toBe("mcp-adapter-test-server");
      expect(manifest.tools?.[0]).toMatchObject({
        displayTitle: "Read File",
        annotations: {
          readOnlyHint: true,
        },
      });
      expect(manifest.listTools?.rawResult?.tools?.[0]).toMatchObject({
        title: "Read File",
        _meta: {
          category: "filesystem",
        },
      });
    }),
  );
});
