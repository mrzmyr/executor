import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as Effect from "effect/Effect";

import type {
  ExecutableTool,
  ToolDefinition,
  ToolDescriptor,
  ToolInput,
  ToolInvoker,
  ToolMap,
  ToolMetadata,
  ToolPath,
} from "./types";

type ResolvedTool = {
  path: ToolPath;
  tool: ExecutableTool;
  metadata?: ToolMetadata;
};

const asToolPath = (value: string): ToolPath => value as ToolPath;

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const getSchemaValidator = (schema: unknown):
  | ((value: unknown, options?: StandardSchemaV1.Options) =>
    | StandardSchemaV1.Result<unknown>
    | Promise<StandardSchemaV1.Result<unknown>>)
  | null => {
  if (!schema || (typeof schema !== "object" && typeof schema !== "function")) {
    return null;
  }

  const standard = (schema as { "~standard"?: unknown })["~standard"];
  if (!standard || typeof standard !== "object") {
    return null;
  }

  const validate = (standard as { validate?: unknown }).validate;
  return typeof validate === "function"
    ? (validate as (
      value: unknown,
      options?: StandardSchemaV1.Options,
    ) =>
      | StandardSchemaV1.Result<unknown>
      | Promise<StandardSchemaV1.Result<unknown>>)
    : null;
};

const formatIssuePath = (
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined,
): string => {
  if (!path || path.length === 0) {
    return "$";
  }

  return path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
};

const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");

const parseInput = (input: {
  schema: unknown;
  value: unknown;
  path: string;
}): Effect.Effect<unknown, Error> => {
  const validate = getSchemaValidator(input.schema);
  if (!validate) {
    return Effect.fail(
      new Error(`Tool ${input.path} has no Standard Schema validator on inputSchema`),
    );
  }

  return Effect.tryPromise({
    try: () => Promise.resolve(validate(input.value)),
    catch: toError,
  }).pipe(
    Effect.flatMap((result) => {
      if ("issues" in result && result.issues) {
        return Effect.fail(
          new Error(
            `Input validation failed for ${input.path}: ${formatIssues(result.issues)}`,
          ),
        );
      }
      return Effect.succeed(result.value);
    }),
  );
};


export function wrapTool(input: {
  tool: ExecutableTool;
  metadata?: ToolMetadata;
}): ToolDefinition {
  return {
    tool: input.tool,
    metadata: input.metadata,
  };
}

export const toTool = wrapTool;
export const toExecutorTool = wrapTool;

const isToolDefinition = (value: ToolInput): value is ToolDefinition =>
  typeof value === "object" && value !== null && "tool" in value;

const stringifySchema = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const inferHintFromSchemaJson = (
  schemaJson: string | undefined,
  fallback: string,
): string => {
  if (!schemaJson) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(schemaJson) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (title.length > 0) {
      return title;
    }

    if (parsed.type === "object") {
      const properties =
        parsed.properties
          && typeof parsed.properties === "object"
          && !Array.isArray(parsed.properties)
          ? Object.keys(parsed.properties as Record<string, unknown>)
          : [];
      if (properties.length > 0) {
        const shown = properties.slice(0, 3).join(", ");
        return properties.length <= 3
          ? `object { ${shown} }`
          : `object { ${shown}, ... }`;
      }
      return "object";
    }

    if (parsed.type === "array") {
      return "array";
    }

    if (typeof parsed.type === "string") {
      return parsed.type;
    }
  } catch {
    // Ignore malformed schema and fall back.
  }

  return fallback;
};

export function createToolsFromRecord(input: {
  tools: Record<string, ExecutableTool>;
  sourceKey?: string;
}): ToolMap {
  const { tools, sourceKey = "in_memory.tools" } = input;

  return Object.fromEntries(
    Object.entries(tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, tool]) => [
        path,
        wrapTool({
          tool,
          metadata: { sourceKey },
        }),
      ]),
  ) as ToolMap;
}

const resolveToolsFromMap = (input: {
  tools: ToolMap;
  sourceKey?: string;
}): ResolvedTool[] => {
  const defaultSourceKey = input.sourceKey ?? "in_memory.tools";

  return Object.entries(input.tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => {
      const entry = isToolDefinition(value) ? value : { tool: value };
      const metadata = entry.metadata
        ? {
            sourceKey: defaultSourceKey,
            ...entry.metadata,
          }
        : { sourceKey: defaultSourceKey };

      return {
        path: asToolPath(path),
        tool: entry.tool,
        metadata,
      } satisfies ResolvedTool;
    });
};

export function toolDescriptorsFromTools(input: {
  tools: ToolMap;
  sourceKey?: string;
}): ToolDescriptor[] {
  const resolvedTools = resolveToolsFromMap({
    tools: input.tools,
    sourceKey: input.sourceKey,
  });

  return resolvedTools.map((entry) => {
    const metadata = entry.metadata;
    const definition = entry.tool;
    const inputSchemaJson =
      metadata?.inputSchemaJson
      ?? stringifySchema(definition.inputSchema)
      ?? stringifySchema(definition.parameters);
    const outputSchemaJson =
      metadata?.outputSchemaJson
      ?? stringifySchema(definition.outputSchema);

    return {
      path: entry.path,
      sourceKey: metadata?.sourceKey ?? "in_memory.tools",
      description: definition.description,
      interaction: metadata?.interaction,
      inputHint:
        metadata?.inputHint ?? inferHintFromSchemaJson(inputSchemaJson, "input"),
      outputHint:
        metadata?.outputHint ?? inferHintFromSchemaJson(outputSchemaJson, "output"),
      inputSchemaJson,
      outputSchemaJson,
      refHintKeys: metadata?.refHintKeys,
    } satisfies ToolDescriptor;
  });
}

export const makeToolInvokerFromTools = (input: {
  tools: ToolMap;
  sourceKey?: string;
}): ToolInvoker => {
  const resolvedTools = resolveToolsFromMap({
    tools: input.tools,
    sourceKey: input.sourceKey,
  });
  const byPath = new Map(resolvedTools.map((entry) => [entry.path as string, entry]));

  return {
    invoke: ({ path, args }) =>
      Effect.gen(function* () {
        const entry = byPath.get(path);
        if (!entry) {
          return yield* Effect.fail(new Error(`Unknown tool path: ${path}`));
        }

        const parsedInput = yield* parseInput({
          schema: entry.tool.inputSchema,
          value: args,
          path,
        });

        return yield* Effect.tryPromise({
          try: () => Promise.resolve(entry.tool.execute(parsedInput)),
          catch: toError,
        });
      }),
  };
};
