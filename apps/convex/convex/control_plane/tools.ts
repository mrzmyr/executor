import { type SourceToolDetail, type SourceToolSummary } from "@executor-v2/management-api";
import {
  SourceSchema,
  type OpenApiHttpMethod,
  type Source,
} from "@executor-v2/schema";
import { v } from "convex/values";
import * as Schema from "effect/Schema";
import { internal } from "../_generated/api";

import { action, internalQuery, query } from "../_generated/server";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);
const runtimeInternal = internal as any;

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

const toSource = (document: Record<string, unknown>): Source =>
  decodeSource(stripConvexSystemFields(document));

const parseJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const parseJsonValue = (value: string | null | undefined): unknown | null => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const normalizeNamespacePart = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : "source";
};

const sourceNamespace = (source: Source): string => {
  const sourceIdSuffix = source.id.slice(-6).toLowerCase();
  return `${normalizeNamespacePart(source.name)}_${sourceIdSuffix}`;
};

const isMethod = (
  value: string | null,
): value is OpenApiHttpMethod | "post" =>
  value === "get" ||
  value === "post" ||
  value === "put" ||
  value === "patch" ||
  value === "delete" ||
  value === "head" ||
  value === "options" ||
  value === "trace";

const methodFromCanonicalPath = (canonicalPath: string | null | undefined): OpenApiHttpMethod | "post" | null => {
  if (!canonicalPath) {
    return null;
  }

  const candidate = canonicalPath.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
  return isMethod(candidate) ? candidate : null;
};

const toMethod = (protocol: string, metadataJson: string | null | undefined): OpenApiHttpMethod | "post" => {
  if (protocol !== "openapi") {
    return "post";
  }

  const metadata = parseJsonObject(metadataJson);
  const method = asNullableString(metadata.method)?.toLowerCase();

  if (
    method === "get" ||
    method === "post" ||
    method === "put" ||
    method === "patch" ||
    method === "delete" ||
    method === "head" ||
    method === "options" ||
    method === "trace"
  ) {
    return method;
  }

  return "get";
};

const collectRefKeys = (value: unknown, refs: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefKeys(item, refs);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const refValue = record.$ref;
  if (typeof refValue === "string" && refValue.startsWith("#/")) {
    refs.add(refValue);
  }

  for (const nestedValue of Object.values(record)) {
    collectRefKeys(nestedValue, refs);
  }
};

const resolveToolRefHintTableJson = async (
  ctx: any,
  artifactId: string,
  inputSchemaJson: string | null | undefined,
  outputSchemaJson: string | null | undefined,
): Promise<string | null> => {
  const initialRefs = new Set<string>();
  collectRefKeys(parseJsonValue(inputSchemaJson), initialRefs);
  collectRefKeys(parseJsonValue(outputSchemaJson), initialRefs);

  if (initialRefs.size === 0) {
    return null;
  }

  const queue = [...initialRefs];
  const seen = new Set<string>();
  const table: Record<string, string> = {};
  const maxRefs = 5_000;

  while (queue.length > 0 && seen.size < maxRefs) {
    const refKey = queue.shift();
    if (!refKey || seen.has(refKey)) {
      continue;
    }

    seen.add(refKey);

    const row = await ctx.db
      .query("artifactSchemaRefs")
      .withIndex("by_artifactId_refKey", (q: any) =>
        q.eq("artifactId", artifactId).eq("refKey", refKey),
      )
      .unique();

    if (!row || typeof row.schemaJson !== "string") {
      continue;
    }

    table[refKey] = row.schemaJson;

    const nestedRefs = new Set<string>();
    collectRefKeys(parseJsonValue(row.schemaJson), nestedRefs);
    for (const nestedRef of nestedRefs) {
      if (!seen.has(nestedRef)) {
        queue.push(nestedRef);
      }
    }
  }

  if (Object.keys(table).length === 0) {
    return null;
  }

  return JSON.stringify(table);
};

const toSummary = (
  source: Source,
  toolRow: Record<string, unknown>,
  metadataJson: string | null | undefined,
): SourceToolSummary => {
  const protocol = asNullableString(toolRow.protocol) ?? "openapi";
  const canonicalPath = asNullableString(toolRow.canonicalPath);
  const method = methodFromCanonicalPath(canonicalPath) ?? toMethod(protocol, metadataJson);
  const toolId = asNullableString(toolRow.toolId) ?? "unknown";
  const path = `${sourceNamespace(source)}.${toolId}`;

  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    toolId,
    name: asNullableString(toolRow.name) ?? "Unnamed Tool",
    description: asNullableString(toolRow.description),
    method,
    path,
    operationPath: canonicalPath,
    operationHash: asNullableString(toolRow.operationHash) ?? "",
  };
};

const summaryFromIndexRow = (row: Record<string, unknown>): SourceToolSummary => {
  const method = asNullableString(row.method)?.toLowerCase() ?? null;
  const sourceKind = asNullableString(row.sourceKind);
  const normalizedSourceKind: Source["kind"] =
    sourceKind === "graphql" || sourceKind === "mcp" || sourceKind === "internal"
      ? sourceKind
      : "openapi";

  return {
    sourceId: (asNullableString(row.sourceId) ?? "") as Source["id"],
    sourceName: asNullableString(row.sourceName) ?? "",
    sourceKind: normalizedSourceKind,
    toolId: asNullableString(row.toolId) ?? "unknown",
    name: asNullableString(row.name) ?? "Unnamed Tool",
    description: asNullableString(row.description),
    method: isMethod(method) ? method : "post",
    path: asNullableString(row.path) ?? "",
    operationPath: asNullableString(row.operationPath ?? null),
    operationHash: asNullableString(row.operationHash) ?? "",
  };
};

const sortTools = (tools: ReadonlyArray<SourceToolSummary>): Array<SourceToolSummary> =>
  [...tools].sort((left, right) => {
    const leftSource = left.sourceName.toLowerCase();
    const rightSource = right.sourceName.toLowerCase();

    if (leftSource !== rightSource) {
      return leftSource.localeCompare(rightSource);
    }

    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName !== rightName) {
      return leftName.localeCompare(rightName);
    }

    return left.toolId.localeCompare(right.toolId);
  });

const workspaceToolsPageSize = 250;

export const listWorkspaceToolSummaryPage = internalQuery({
  args: {
    workspaceId: v.string(),
    sourceId: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pageSize = Math.max(1, Math.min(500, Math.floor(args.pageSize ?? workspaceToolsPageSize)));
    const paginationOptions = {
      cursor: args.cursor ?? null,
      numItems: pageSize,
    };

    const page = args.sourceId
      ? await ctx.db
        .query("workspaceToolIndex")
        .withIndex("by_workspaceId_sourceId", (q: any) =>
          q.eq("workspaceId", args.workspaceId).eq("sourceId", args.sourceId),
        )
        .paginate(paginationOptions)
      : await ctx.db
        .query("workspaceToolIndex")
        .withIndex("by_workspaceId", (q: any) => q.eq("workspaceId", args.workspaceId))
        .paginate(paginationOptions);

    const summaries = page.page
      .filter((row) => row.status === "active")
      .map((row) => summaryFromIndexRow(stripConvexSystemFields(row as unknown as Record<string, unknown>)));

    return {
      summaries,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const listWorkspaceTools = action({
  args: {
    workspaceId: v.string(),
  },
  handler: async (ctx, args): Promise<Array<SourceToolSummary>> => {
    await ctx.runAction(runtimeInternal.control_plane.tool_registry.ensureWorkspaceToolIndexCoverage, {
      workspaceId: args.workspaceId,
    });

    const summaries: Array<SourceToolSummary> = [];
    let cursor: string | null = null;

    do {
      const page: {
        summaries: Array<SourceToolSummary>;
        continueCursor: string | null;
        isDone: boolean;
      } = await ctx.runQuery(runtimeInternal.control_plane.tools.listWorkspaceToolSummaryPage, {
        workspaceId: args.workspaceId,
        cursor,
        pageSize: workspaceToolsPageSize,
      });

      summaries.push(...page.summaries);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor);

    return sortTools(summaries);
  },
});

export const listSourceTools = action({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
  },
  handler: async (ctx, args): Promise<Array<SourceToolSummary>> => {
    await ctx.runAction(runtimeInternal.control_plane.tool_registry.ensureWorkspaceToolIndexCoverage, {
      workspaceId: args.workspaceId,
      sourceId: args.sourceId,
    });

    const summaries: Array<SourceToolSummary> = [];
    let cursor: string | null = null;

    do {
      const page: {
        summaries: Array<SourceToolSummary>;
        continueCursor: string | null;
        isDone: boolean;
      } = await ctx.runQuery(runtimeInternal.control_plane.tools.listWorkspaceToolSummaryPage, {
        workspaceId: args.workspaceId,
        sourceId: args.sourceId,
        cursor,
        pageSize: workspaceToolsPageSize,
      });

      summaries.push(...page.summaries);
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor);

    return sortTools(summaries);
  },
});

export const getToolDetail = query({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    operationHash: v.string(),
  },
  handler: async (ctx, args): Promise<SourceToolDetail | null> => {
    const sourceRow = await ctx.db
      .query("sources")
      .withIndex("by_domainId", (q) => q.eq("id", args.sourceId))
      .unique();

    if (!sourceRow || sourceRow.workspaceId !== args.workspaceId) {
      return null;
    }

    const source = toSource(sourceRow as unknown as Record<string, unknown>);
    const indexedRows = await ctx.db
      .query("workspaceToolIndex")
      .withIndex("by_workspaceId_operationHash", (q: any) =>
        q.eq("workspaceId", args.workspaceId).eq("operationHash", args.operationHash),
      )
      .collect();
    const indexedRow = indexedRows.find((row) => row.sourceId === args.sourceId) ?? null;
    if (!indexedRow) {
      return null;
    }

    const artifactTool = await ctx.db
      .query("artifactTools")
      .withIndex("by_artifactId_toolId", (q: any) =>
        q.eq("artifactId", indexedRow.artifactId).eq("toolId", indexedRow.toolId),
      )
      .unique();
    if (!artifactTool) {
      return null;
    }

    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_domainId", (q) => q.eq("id", indexedRow.artifactId))
      .unique();

    const resolvedRefHintTableJson = source.kind === "openapi"
      ? await resolveToolRefHintTableJson(
        ctx,
        indexedRow.artifactId,
        artifactTool.inputSchemaJson ?? null,
        artifactTool.outputSchemaJson ?? null,
      )
      : null;

    const summary = summaryFromIndexRow(
      stripConvexSystemFields(indexedRow as unknown as Record<string, unknown>),
    );

    return {
      ...summary,
      inputSchemaJson: artifactTool.inputSchemaJson ?? null,
      outputSchemaJson: artifactTool.outputSchemaJson ?? null,
      refHintTableJson: resolvedRefHintTableJson
        ?? artifact?.refHintTableJson
        ?? null,
    };
  },
});
