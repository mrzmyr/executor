import * as Effect from "effect/Effect";

import {
  RuntimeAdapterError,
  type RuntimeToolCallService,
} from "./runtime-adapters";

export type ToolRegistryCallInput = {
  runId: string;
  callId: string;
  toolPath: string;
  input?: Record<string, unknown>;
};

export type ToolRegistryDiscoverInput = {
  query?: string;
  limit?: number;
  compact?: boolean;
  includeSchemas?: boolean;
};

export type ToolRegistryCatalogNamespacesInput = {
  limit?: number;
};

export type ToolRegistryCatalogToolsInput = {
  namespace?: string;
  query?: string;
  limit?: number;
  compact?: boolean;
  includeSchemas?: boolean;
};

export type ToolRegistryToolSummary = {
  path: string;
  source?: string;
  approval: "auto" | "required";
  description?: string;
};

export type ToolRegistryDiscoverOutput = {
  bestPath: string | null;
  results: Array<ToolRegistryToolSummary>;
  total: number;
};

export type ToolRegistryCatalogNamespacesOutput = {
  namespaces: Array<{
    namespace: string;
    toolCount: number;
    samplePaths: Array<string>;
  }>;
  total: number;
};

export type ToolRegistryCatalogToolsOutput = {
  results: Array<ToolRegistryToolSummary>;
  total: number;
};

export type ToolRegistry = {
  callTool: (input: ToolRegistryCallInput) => Effect.Effect<unknown, RuntimeAdapterError>;
  discover: (
    input: ToolRegistryDiscoverInput,
  ) => Effect.Effect<ToolRegistryDiscoverOutput, RuntimeAdapterError>;
  catalogNamespaces: (
    input: ToolRegistryCatalogNamespacesInput,
  ) => Effect.Effect<ToolRegistryCatalogNamespacesOutput, RuntimeAdapterError>;
  catalogTools: (
    input: ToolRegistryCatalogToolsInput,
  ) => Effect.Effect<ToolRegistryCatalogToolsOutput, RuntimeAdapterError>;
};

export type InMemorySandboxTool = {
  description?: string | null;
  execute?: (...args: Array<any>) => Promise<any> | any;
};

export type InMemorySandboxToolMap = Record<string, InMemorySandboxTool>;

type StaticToolRegistryOptions = {
  tools: InMemorySandboxToolMap;
};

const staticToolRegistryRuntimeKind = "static-tool-registry";

const toRuntimeAdapterError = (
  operation: string,
  message: string,
  details: string | null,
): RuntimeAdapterError =>
  new RuntimeAdapterError({
    runtimeKind: staticToolRegistryRuntimeKind,
    operation,
    message,
    details,
  });

const normalizeObjectInput = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
};

const normalizeDiscoverInput = (input: unknown): ToolRegistryDiscoverInput => {
  const value = normalizeObjectInput(input);
  return {
    query: typeof value.query === "string" ? value.query : undefined,
    limit: typeof value.limit === "number" ? value.limit : undefined,
    compact: typeof value.compact === "boolean" ? value.compact : undefined,
    includeSchemas:
      typeof value.includeSchemas === "boolean" ? value.includeSchemas : undefined,
  };
};

const normalizeCatalogNamespacesInput = (
  input: unknown,
): ToolRegistryCatalogNamespacesInput => {
  const value = normalizeObjectInput(input);
  return {
    limit: typeof value.limit === "number" ? value.limit : undefined,
  };
};

const normalizeCatalogToolsInput = (input: unknown): ToolRegistryCatalogToolsInput => {
  const value = normalizeObjectInput(input);
  return {
    namespace: typeof value.namespace === "string" ? value.namespace : undefined,
    query: typeof value.query === "string" ? value.query : undefined,
    limit: typeof value.limit === "number" ? value.limit : undefined,
    compact: typeof value.compact === "boolean" ? value.compact : undefined,
    includeSchemas:
      typeof value.includeSchemas === "boolean" ? value.includeSchemas : undefined,
  };
};

const asToolSummaries = (
  tools: InMemorySandboxToolMap,
): Array<ToolRegistryToolSummary> =>
  Object.entries(tools)
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([path, tool]) => ({
      path,
      source: "in-memory",
      approval: "auto" as const,
      description: tool.description ?? undefined,
    }));

const scorePath = (entry: ToolRegistryToolSummary, query: string): number => {
  if (query.length === 0) {
    return 1;
  }

  const lowerPath = entry.path.toLowerCase();
  const lowerDescription = (entry.description ?? "").toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerPath === lowerQuery) {
    return 100;
  }

  if (lowerPath.startsWith(lowerQuery)) {
    return 80;
  }

  if (lowerPath.includes(lowerQuery)) {
    return 60;
  }

  if (lowerDescription.includes(lowerQuery)) {
    return 40;
  }

  return 0;
};

const inMemoryDiscover = (
  tools: InMemorySandboxToolMap,
  input: ToolRegistryDiscoverInput,
): ToolRegistryDiscoverOutput => {
  const limit = Math.max(1, Math.min(50, input.limit ?? 8));
  const query = (input.query ?? "").trim().toLowerCase();

  const ranked = asToolSummaries(tools)
    .map((entry) => ({
      entry,
      score: scorePath(entry, query),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.entry);

  return {
    bestPath: ranked[0]?.path ?? null,
    results: ranked,
    total: ranked.length,
  };
};

const inMemoryCatalogNamespaces = (
  tools: InMemorySandboxToolMap,
  input: ToolRegistryCatalogNamespacesInput,
): ToolRegistryCatalogNamespacesOutput => {
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const grouped = new Map<string, Array<string>>();

  for (const path of Object.keys(tools)) {
    const namespace = path.split(".")[0] ?? "default";
    const list = grouped.get(namespace) ?? [];
    list.push(path);
    grouped.set(namespace, list);
  }

  const namespaces = [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([namespace, paths]) => ({
      namespace,
      toolCount: paths.length,
      samplePaths: [...paths].sort((left, right) => left.localeCompare(right)).slice(0, 3),
    }));

  return {
    namespaces: namespaces.slice(0, limit),
    total: namespaces.length,
  };
};

const inMemoryCatalogTools = (
  tools: InMemorySandboxToolMap,
  input: ToolRegistryCatalogToolsInput,
): ToolRegistryCatalogToolsOutput => {
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const query = (input.query ?? "").trim().toLowerCase();
  const namespace = (input.namespace ?? "").trim().toLowerCase();

  const filtered = asToolSummaries(tools)
    .filter((entry) => {
      if (namespace.length > 0) {
        const entryNamespace = entry.path.split(".")[0]?.toLowerCase() ?? "";
        if (entryNamespace !== namespace) {
          return false;
        }
      }

      return scorePath(entry, query) > 0;
    })
    .slice(0, limit);

  return {
    results: filtered,
    total: filtered.length,
  };
};

export const createStaticToolRegistry = (
  options: StaticToolRegistryOptions,
): ToolRegistry => ({
  callTool: (input) => {
    const implementation = options.tools[input.toolPath];
    if (!implementation) {
      return new RuntimeAdapterError({
        operation: "call_tool",
        runtimeKind: staticToolRegistryRuntimeKind,
        message: `Unknown in-memory tool: ${input.toolPath}`,
        details: null,
      });
    }

    if (!implementation.execute) {
      return new RuntimeAdapterError({
        operation: "call_tool",
        runtimeKind: staticToolRegistryRuntimeKind,
        message: `In-memory tool '${input.toolPath}' has no execute function`,
        details: null,
      });
    }

    return Effect.tryPromise({
      try: () => Promise.resolve(implementation.execute!(input.input ?? {}, undefined)),
      catch: (cause) =>
        toRuntimeAdapterError(
          "call_tool",
          `In-memory tool invocation failed: ${input.toolPath}`,
          String(cause),
        ),
    });
  },
  discover: (input) => Effect.succeed(inMemoryDiscover(options.tools, input)),
  catalogNamespaces: (input) =>
    Effect.succeed(inMemoryCatalogNamespaces(options.tools, input)),
  catalogTools: (input) => Effect.succeed(inMemoryCatalogTools(options.tools, input)),
});

export const createRuntimeToolCallService = (
  toolRegistry: ToolRegistry,
): RuntimeToolCallService => ({
  callTool: (input) => {
    if (input.toolPath === "discover") {
      return toolRegistry.discover(normalizeDiscoverInput(input.input));
    }

    if (input.toolPath === "catalog.namespaces") {
      return toolRegistry.catalogNamespaces(
        normalizeCatalogNamespacesInput(input.input),
      );
    }

    if (input.toolPath === "catalog.tools") {
      return toolRegistry.catalogTools(normalizeCatalogToolsInput(input.input));
    }

    return toolRegistry.callTool(input);
  },
});
