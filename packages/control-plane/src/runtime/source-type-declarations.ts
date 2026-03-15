import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { typeSignatureFromSchemaWithOptions } from "@executor/codemode-core";
import type { Source } from "#schema";
import * as Effect from "effect/Effect";

import { projectCatalogForAgentSdk } from "../ir/catalog";
import type { CatalogSnapshotV1 } from "../ir/model";
import type { ResolvedLocalWorkspaceContext } from "./local-config";
import {
  LocalFileSystemError,
  unknownLocalErrorDetails,
} from "./local-errors";
import { shapeToJsonSchema } from "./source-catalog-runtime";

type JsonRecord = Record<string, unknown>;

type SourceDeclarationEntry = {
  source: Source;
  snapshot: CatalogSnapshotV1;
};

type ToolMethodNode = {
  readonly segments: readonly string[];
  readonly inputType: string;
  readonly outputType: string;
  readonly argsOptional: boolean;
};

type ToolTreeNode = {
  method: ToolMethodNode | null;
  children: Map<string, ToolTreeNode>;
};

type SourceDeclarationStub = {
  sourceId: string;
};

const GENERATED_TYPES_DIRECTORY = "types";
const GENERATED_SOURCE_TYPES_DIRECTORY = "sources";
const VALID_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DECLARATION_RENDER_OPTIONS = {
  maxLength: Number.POSITIVE_INFINITY,
  maxDepth: 6,
  maxProperties: 16,
} as const;

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

const declarationDirectory = (context: ResolvedLocalWorkspaceContext): string =>
  join(context.configDirectory, GENERATED_TYPES_DIRECTORY);

const sourceDeclarationDirectory = (context: ResolvedLocalWorkspaceContext): string =>
  join(declarationDirectory(context), GENERATED_SOURCE_TYPES_DIRECTORY);

const sourceDeclarationFileName = (sourceId: string): string => `${sourceId}.d.ts`;

const sourceDeclarationPath = (context: ResolvedLocalWorkspaceContext, sourceId: string): string =>
  join(sourceDeclarationDirectory(context), sourceDeclarationFileName(sourceId));

const aggregateDeclarationPath = (context: ResolvedLocalWorkspaceContext): string =>
  join(declarationDirectory(context), "index.d.ts");

const asRecord = (value: unknown): JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const formatPropertyKey = (value: string): string =>
  VALID_IDENTIFIER_PATTERN.test(value) ? value : JSON.stringify(value);

const sourceTypeInterfaceName = (sourceId: string): string =>
  `SourceTools_${sourceId.replace(/[^A-Za-z0-9_$]+/g, "_")}`;

const methodSignature = (method: ToolMethodNode): string =>
  `(${method.argsOptional ? "args?:" : "args:"} ${method.inputType}) => Promise<${method.outputType}>`;

const createToolTreeNode = (): ToolTreeNode => ({
  method: null,
  children: new Map(),
});

const schemaAllowsOmittedArgs = (schema: unknown): boolean => {
  const root = asRecord(schema);
  if (root.type !== "object" && root.properties === undefined) {
    return false;
  }

  return asStringArray(root.required).length === 0;
};

const objectTypeLiteral = (
  lines: readonly string[],
  indent: string,
): string => {
  if (lines.length === 0) {
    return "{}";
  }

  return [
    "{",
    ...lines.map((line) => `${indent}${line}`),
    `${indent.slice(0, -2)}}`,
  ].join("\n");
};

const renderToolTreeType = (node: ToolTreeNode, indentLevel: number): string => {
  const indent = "  ".repeat(indentLevel + 1);
  const childLines = [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([segment, child]) =>
      `${formatPropertyKey(segment)}: ${renderToolTreeType(child, indentLevel + 1)};`
    );

  const objectType = objectTypeLiteral(childLines, indent);
  if (node.method === null) {
    return objectType;
  }

  const callable = methodSignature(node.method);
  return node.children.size === 0
    ? callable
    : `(${callable}) & ${objectType}`;
};

const buildToolTree = (methods: readonly ToolMethodNode[]): ToolTreeNode => {
  const root = createToolTreeNode();

  for (const method of methods) {
    let current = root;
    for (const segment of method.segments) {
      const existing = current.children.get(segment);
      if (existing) {
        current = existing;
        continue;
      }

      const next = createToolTreeNode();
      current.children.set(segment, next);
      current = next;
    }

    current.method = method;
  }

  return root;
};

const collectToolMethods = (snapshot: CatalogSnapshotV1): ToolMethodNode[] => {
  const projected = projectCatalogForAgentSdk({
    catalog: snapshot.catalog,
  });

  return Object.values(projected.toolDescriptors)
    .sort((left, right) => left.toolPath.join(".").localeCompare(right.toolPath.join(".")))
    .map((descriptor) => {
      const inputSchema = shapeToJsonSchema(projected.catalog, descriptor.callShapeId);
      const outputSchema = descriptor.resultShapeId
        ? shapeToJsonSchema(projected.catalog, descriptor.resultShapeId)
        : undefined;

      return {
        segments: descriptor.toolPath,
        inputType: typeSignatureFromSchemaWithOptions(
          inputSchema,
          "unknown",
          DECLARATION_RENDER_OPTIONS,
        ),
        outputType: typeSignatureFromSchemaWithOptions(
          outputSchema,
          "unknown",
          DECLARATION_RENDER_OPTIONS,
        ),
        argsOptional: schemaAllowsOmittedArgs(inputSchema),
      } satisfies ToolMethodNode;
    });
};

const sourceDeclarationText = (entry: SourceDeclarationEntry): string => {
  const interfaceName = sourceTypeInterfaceName(entry.source.id);
  const tree = buildToolTree(collectToolMethods(entry.snapshot));
  const body = renderToolTreeType(tree, 0);

  return [
    "// Generated by executor. Do not edit by hand.",
    `// Source: ${entry.source.name} (${entry.source.id})`,
    "",
    `export interface ${interfaceName} ${body}`,
    "",
    `export declare const tools: ${interfaceName};`,
    `export type ${interfaceName}Tools = ${interfaceName};`,
    "export default tools;",
    "",
  ].join("\n");
};

const aggregateDeclarationText = (entries: readonly SourceDeclarationEntry[]): string => {
  return aggregateDeclarationTextFromSourceIds(
    entries.map((entry) => ({ sourceId: entry.source.id })),
  );
};

const aggregateDeclarationTextFromSourceIds = (entries: readonly SourceDeclarationStub[]): string => {
  const sorted = [...entries].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const imports = sorted.map((entry) =>
    `import type { ${sourceTypeInterfaceName(entry.sourceId)} } from "./sources/${entry.sourceId}";`
  );
  const intersections = sorted.map((entry) => sourceTypeInterfaceName(entry.sourceId));
  const executorToolsType = intersections.length > 0
    ? intersections.join(" & ")
    : "{}";

  return [
    "// Generated by executor. Do not edit by hand.",
    ...imports,
    ...(imports.length > 0 ? [""] : []),
    `export type ExecutorSourceTools = ${executorToolsType};`,
    "",
    "declare global {",
    "  const tools: ExecutorSourceTools;",
    "}",
    "",
    "export declare const tools: ExecutorSourceTools;",
    "export default tools;",
    "",
  ].join("\n");
};

export const syncWorkspaceSourceTypeDeclarations = (input: {
  context: ResolvedLocalWorkspaceContext;
  entries: readonly SourceDeclarationEntry[];
}): Effect.Effect<void, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const declarationsDir = declarationDirectory(input.context);
    const perSourceDir = sourceDeclarationDirectory(input.context);
    const activeEntries = input.entries
      .filter((entry) => entry.source.enabled && entry.source.status === "connected")
      .sort((left, right) => left.source.id.localeCompare(right.source.id));

    yield* fs.makeDirectory(declarationsDir, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(declarationsDir, "create declaration directory")),
    );
    yield* fs.makeDirectory(perSourceDir, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(perSourceDir, "create source declaration directory")),
    );

    const expectedFiles = new Set(
      activeEntries.map((entry) => sourceDeclarationFileName(entry.source.id)),
    );
    const existingFiles = yield* fs.readDirectory(perSourceDir).pipe(
      Effect.mapError(mapFileSystemError(perSourceDir, "read source declaration directory")),
    );

    for (const existingFile of existingFiles) {
      if (expectedFiles.has(existingFile)) {
        continue;
      }

      const stalePath = join(perSourceDir, existingFile);
      yield* fs.remove(stalePath).pipe(
        Effect.mapError(mapFileSystemError(stalePath, "remove stale source declaration")),
      );
    }

    for (const entry of activeEntries) {
      const filePath = sourceDeclarationPath(input.context, entry.source.id);
      yield* fs.writeFileString(filePath, sourceDeclarationText(entry)).pipe(
      Effect.mapError(mapFileSystemError(filePath, "write source declaration")),
      );
    }

    const aggregatePath = aggregateDeclarationPath(input.context);
    yield* fs.writeFileString(
      aggregatePath,
      aggregateDeclarationText(activeEntries),
    ).pipe(
      Effect.mapError(mapFileSystemError(aggregatePath, "write aggregate declaration")),
    );
  });

export const syncSourceTypeDeclaration = (input: {
  context: ResolvedLocalWorkspaceContext;
  source: Source;
  snapshot: CatalogSnapshotV1 | null;
}): Effect.Effect<void, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const declarationsDir = declarationDirectory(input.context);
    const perSourceDir = sourceDeclarationDirectory(input.context);

    yield* fs.makeDirectory(declarationsDir, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(declarationsDir, "create declaration directory")),
    );
    yield* fs.makeDirectory(perSourceDir, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(perSourceDir, "create source declaration directory")),
    );

    const filePath = sourceDeclarationPath(input.context, input.source.id);
    const shouldWrite = input.source.enabled
      && input.source.status === "connected"
      && input.snapshot !== null;

    if (shouldWrite) {
      const snapshot = input.snapshot;
      if (snapshot === null) {
        return;
      }
      yield* fs.writeFileString(
        filePath,
        sourceDeclarationText({
          source: input.source,
          snapshot,
        }),
      ).pipe(
        Effect.mapError(mapFileSystemError(filePath, "write source declaration")),
      );
    } else {
      const exists = yield* fs.exists(filePath).pipe(
        Effect.mapError(mapFileSystemError(filePath, "check source declaration path")),
      );
      if (exists) {
        yield* fs.remove(filePath).pipe(
          Effect.mapError(mapFileSystemError(filePath, "remove source declaration")),
        );
      }
    }

    const sourceIds = (yield* fs.readDirectory(perSourceDir).pipe(
      Effect.mapError(mapFileSystemError(perSourceDir, "read source declaration directory")),
    ))
      .filter((fileName) => fileName.endsWith(".d.ts"))
      .map((fileName) => ({ sourceId: fileName.slice(0, -".d.ts".length) }));

    const aggregatePath = aggregateDeclarationPath(input.context);
    yield* fs.writeFileString(
      aggregatePath,
      aggregateDeclarationTextFromSourceIds(sourceIds),
    ).pipe(
      Effect.mapError(mapFileSystemError(aggregatePath, "write aggregate declaration")),
    );
  });

export const syncWorkspaceSourceTypeDeclarationsNode = (input: {
  context: ResolvedLocalWorkspaceContext;
  entries: readonly SourceDeclarationEntry[];
}): Effect.Effect<void, LocalFileSystemError, never> =>
  syncWorkspaceSourceTypeDeclarations(input).pipe(Effect.provide(NodeFileSystem.layer));

export const syncSourceTypeDeclarationNode = (input: {
  context: ResolvedLocalWorkspaceContext;
  source: Source;
  snapshot: CatalogSnapshotV1 | null;
}): Effect.Effect<void, LocalFileSystemError, never> =>
  syncSourceTypeDeclaration(input).pipe(Effect.provide(NodeFileSystem.layer));

const logBackgroundDeclarationError = (label: string, cause: unknown): void => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.warn(`[source-types] ${label} failed: ${message}`);
};

export const refreshWorkspaceSourceTypeDeclarationsInBackground = (input: {
  context: ResolvedLocalWorkspaceContext;
  entries: readonly SourceDeclarationEntry[];
}): void => {
  setTimeout(() => {
    Effect.runFork(
      syncWorkspaceSourceTypeDeclarationsNode(input).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            logBackgroundDeclarationError("workspace declaration refresh", cause);
          })
        ),
      ),
    );
  }, 0);
};

export const refreshSourceTypeDeclarationInBackground = (input: {
  context: ResolvedLocalWorkspaceContext;
  source: Source;
  snapshot: CatalogSnapshotV1 | null;
}): void => {
  setTimeout(() => {
    Effect.runFork(
      syncSourceTypeDeclarationNode(input).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            logBackgroundDeclarationError(`source ${input.source.id} declaration refresh`, cause);
          })
        ),
      ),
    );
  }, 0);
};
