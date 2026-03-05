import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  standardSchemaFromJsonSchema,
  toTool,
  type ToolMap,
  unknownInputSchema,
} from "@executor-v3/codemode-core";

export type McpClientLike = {
  listTools: () => Promise<unknown>;
  callTool: (input: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<unknown>;
};

export type McpConnection = {
  client: McpClientLike;
  close?: () => Promise<void>;
};

export type McpConnector = () => Promise<McpConnection>;

export type McpToolManifestEntry = {
  toolId: string;
  toolName: string;
  description: string | null;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
};

export type McpToolManifest = {
  version: 1;
  tools: readonly McpToolManifestEntry[];
};

type McpDiscoveryStage = "connect" | "list_tools" | "call_tool";

export class McpToolsError extends Data.TaggedError("McpToolsError")<{
  stage: McpDiscoveryStage;
  message: string;
  details: string | null;
}> {}

const toDetails = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const sanitizeToolId = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : "tool";
};

const uniqueToolId = (value: string, byBase: Map<string, number>): string => {
  const base = sanitizeToolId(value);
  const count = (byBase.get(base) ?? 0) + 1;
  byBase.set(base, count);

  return count === 1 ? base : `${base}_${count}`;
};

const stringifyJson = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const inputSchemaFromManifest = (inputSchemaJson: string | undefined) => {
  if (!inputSchemaJson) {
    return unknownInputSchema;
  }

  try {
    return standardSchemaFromJsonSchema(JSON.parse(inputSchemaJson), {
      vendor: "mcp",
      fallback: unknownInputSchema,
    });
  } catch {
    return unknownInputSchema;
  }
};


const readListedTools = (value: unknown): Array<Record<string, unknown>> => {
  const root = toRecord(value);
  const tools = root.tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => toRecord(tool))
    .filter((tool) => Object.keys(tool).length > 0);
};

export const extractMcpToolManifestFromListToolsResult = (
  listToolsResult: unknown,
): McpToolManifest => {
  const byBase = new Map<string, number>();

  const tools = readListedTools(listToolsResult)
    .map((tool): McpToolManifestEntry | null => {
      const toolNameRaw = tool.name;
      const toolName = typeof toolNameRaw === "string" ? toolNameRaw.trim() : "";
      if (toolName.length === 0) {
        return null;
      }

      return {
        toolId: uniqueToolId(toolName, byBase),
        toolName,
        description:
          typeof tool.description === "string" ? tool.description : null,
        inputSchemaJson:
          stringifyJson(tool.inputSchema)
          ?? stringifyJson(tool.parameters),
        outputSchemaJson: stringifyJson(tool.outputSchema),
      };
    })
    .filter((tool): tool is McpToolManifestEntry => tool !== null);

  return {
    version: 1,
    tools,
  };
};

const joinToolPath = (namespace: string | undefined, toolId: string): string => {
  if (!namespace || namespace.trim().length === 0) {
    return toolId;
  }

  return `${namespace}.${toolId}`;
};

const withConnection = async <A>(
  connect: McpConnector,
  run: (connection: McpConnection) => Promise<A>,
): Promise<A> => {
  const connection = await connect();

  try {
    return await run(connection);
  } finally {
    await connection.close?.().catch(() => undefined);
  }
};

export const createMcpConnectorFromClient = (
  client: McpClientLike,
): McpConnector =>
  async () => ({
    client,
    close: async () => undefined,
  });

export const createMcpToolsFromManifest = (input: {
  manifest: McpToolManifest;
  connect: McpConnector;
  namespace?: string;
  sourceKey?: string;
}): ToolMap => {
  const sourceKey = input.sourceKey ?? "mcp.generated";

  return Object.fromEntries(
    input.manifest.tools.map((entry) => {
      const path = joinToolPath(input.namespace, entry.toolId);

      return [
        path,
        toTool({
          tool: {
            description: entry.description ?? `MCP tool: ${entry.toolName}`,
            inputSchema: inputSchemaFromManifest(entry.inputSchemaJson),
            execute: async (args: unknown) =>
              withConnection(input.connect, async (connection) => {
                const payloadArgs = toRecord(args);

                try {
                  return await connection.client.callTool({
                    name: entry.toolName,
                    arguments: payloadArgs,
                  });
                } catch (cause) {
                  throw new McpToolsError({
                    stage: "call_tool",
                    message: `Failed invoking MCP tool: ${entry.toolName}`,
                    details: toDetails(cause),
                  });
                }
              }),
          },
          metadata: {
            sourceKey,
            inputSchemaJson: entry.inputSchemaJson,
            outputSchemaJson: entry.outputSchemaJson,
          },
        }),
      ] as const;
    }),
  );
};

export const discoverMcpToolsFromConnector = (input: {
  connect: McpConnector;
  namespace?: string;
  sourceKey?: string;
}): Effect.Effect<{ manifest: McpToolManifest; tools: ToolMap }, McpToolsError> =>
  Effect.gen(function* () {
    const listed = yield* Effect.tryPromise({
      try: () =>
        withConnection(input.connect, async (connection) => {
          try {
            return await connection.client.listTools();
          } catch (cause) {
            throw new McpToolsError({
              stage: "list_tools",
              message: "Failed listing MCP tools",
              details: toDetails(cause),
            });
          }
        }),
      catch: (cause) =>
        cause instanceof McpToolsError
          ? cause
          : new McpToolsError({
              stage: "connect",
              message: "Failed connecting to MCP server",
              details: toDetails(cause),
            }),
    });

    const manifest = extractMcpToolManifestFromListToolsResult(listed);

    return {
      manifest,
      tools: createMcpToolsFromManifest({
        manifest,
        connect: input.connect,
        namespace: input.namespace,
        sourceKey: input.sourceKey,
      }),
    };
  });

export const discoverMcpToolsFromClient = (input: {
  client: McpClientLike;
  namespace?: string;
  sourceKey?: string;
}): Effect.Effect<{ manifest: McpToolManifest; tools: ToolMap }, McpToolsError> =>
  discoverMcpToolsFromConnector({
    connect: createMcpConnectorFromClient(input.client),
    namespace: input.namespace,
    sourceKey: input.sourceKey,
  });
