import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type {
  Source,
  StoredSourceCatalogRevisionRecord,
  StoredSourceRecord,
} from "#schema";

import {
  createCatalogSnapshotV1,
  createEmptyCatalogV1,
  projectCatalogForAgentSdk,
} from "../ir/catalog";
import {
  CapabilityIdSchema,
  DocumentIdSchema,
  ExecutableIdSchema,
  ResponseSetIdSchema,
  ScopeIdSchema,
  ShapeSymbolIdSchema,
} from "../ir/ids";
import type { CatalogV1, ProvenanceRef } from "../ir/model";
import {
  expandCatalogToolByPath,
  expandCatalogTools,
  type LoadedSourceCatalog,
} from "./source-catalog-runtime";

const put = <K extends string, V>(record: Record<K, V>, key: K, value: V) => {
  record[key] = value;
};

const docId = DocumentIdSchema.make("doc_graphql");
const baseProvenance = (pointer: string): ProvenanceRef[] => [{
  relation: "declared",
  documentId: docId,
  pointer,
}];

const createGraphqlCatalog = (): CatalogV1 => {
  const catalog = createEmptyCatalogV1();
  const scopeId = ScopeIdSchema.make("scope_graphql");
  const stringShapeId = ShapeSymbolIdSchema.make("shape_string");
  const teamFilterShapeId = ShapeSymbolIdSchema.make("shape_team_filter");
  const callShapeId = ShapeSymbolIdSchema.make("shape_team_query_args");
  const resultShapeId = ShapeSymbolIdSchema.make("shape_team_connection");
  const executableId = ExecutableIdSchema.make("exec_graphql_teams");
  const capabilityId = CapabilityIdSchema.make("cap_graphql_teams");
  const responseSetId = ResponseSetIdSchema.make("response_set_graphql_teams");

  put(catalog.documents as Record<typeof docId, CatalogV1["documents"][typeof docId]>, docId, {
    id: docId,
    kind: "graphql-schema",
    title: "Linear GraphQL",
    fetchedAt: "2026-03-14T00:00:00.000Z",
    rawRef: "memory://linear/graphql",
  });

  put(catalog.scopes as Record<typeof scopeId, CatalogV1["scopes"][typeof scopeId]>, scopeId, {
    id: scopeId,
    kind: "service",
    name: "Linear",
    namespace: "linear",
    synthetic: false,
    provenance: baseProvenance("#"),
  });

  put(catalog.symbols as Record<typeof stringShapeId, CatalogV1["symbols"][typeof stringShapeId]>, stringShapeId, {
    id: stringShapeId,
    kind: "shape",
    title: "String",
    node: {
      type: "scalar",
      scalar: "string",
    },
    synthetic: false,
    provenance: baseProvenance("#/scalar/String"),
  });

  put(catalog.symbols as Record<typeof teamFilterShapeId, CatalogV1["symbols"][typeof teamFilterShapeId]>, teamFilterShapeId, {
    id: teamFilterShapeId,
    kind: "shape",
    title: "TeamFilter",
    node: {
      type: "object",
      fields: {
        name: {
          shapeId: stringShapeId,
          docs: {
            description: "Filter teams by name.",
          },
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/input/TeamFilter"),
  });

  put(catalog.symbols as Record<typeof callShapeId, CatalogV1["symbols"][typeof callShapeId]>, callShapeId, {
    id: callShapeId,
    kind: "shape",
    title: "TeamsArgs",
    node: {
      type: "object",
      fields: {
        filter: {
          shapeId: teamFilterShapeId,
          docs: {
            description: "Filter returned teams.",
          },
        },
        after: {
          shapeId: stringShapeId,
          docs: {
            description: "A cursor to be used with first for forward pagination",
          },
        },
        before: {
          shapeId: stringShapeId,
          docs: {
            description: "A cursor to be used with last for backward pagination.",
          },
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/query/teams/args"),
  });

  put(catalog.symbols as Record<typeof resultShapeId, CatalogV1["symbols"][typeof resultShapeId]>, resultShapeId, {
    id: resultShapeId,
    kind: "shape",
    title: "TeamConnection",
    node: {
      type: "object",
      fields: {
        nodes: {
          shapeId: teamFilterShapeId,
        },
      },
      additionalProperties: false,
    },
    synthetic: false,
    provenance: baseProvenance("#/query/teams/result"),
  });

  put(catalog.responseSets as Record<typeof responseSetId, CatalogV1["responseSets"][typeof responseSetId]>, responseSetId, {
    id: responseSetId,
    variants: [],
    synthetic: false,
    provenance: baseProvenance("#/responses"),
  });

  put(catalog.capabilities as Record<typeof capabilityId, CatalogV1["capabilities"][typeof capabilityId]>, capabilityId, {
    id: capabilityId,
    serviceScopeId: scopeId,
    surface: {
      toolPath: ["linear", "teams"],
      title: "Teams",
      summary: "List teams",
    },
    semantics: {
      effect: "read",
      safe: true,
      idempotent: true,
      destructive: false,
    },
    auth: { kind: "none" },
    interaction: {
      approval: { mayRequire: false },
      elicitation: { mayRequest: false },
      resume: { supported: false },
    },
    executableIds: [executableId],
    preferredExecutableId: executableId,
    synthetic: false,
    provenance: baseProvenance("#/query/teams"),
  });

  put(catalog.executables as Record<typeof executableId, CatalogV1["executables"][typeof executableId]>, executableId, {
    id: executableId,
    protocol: "graphql",
    capabilityId,
    scopeId,
    operationType: "query",
    rootField: "teams",
    argumentShapeId: callShapeId,
    resultShapeId,
    selectionMode: "caller",
    responseSetId,
    synthetic: false,
    provenance: baseProvenance("#/query/teams"),
  });

  return catalog;
};

const createLoadedCatalog = (): LoadedSourceCatalog => {
  const catalog = createGraphqlCatalog();
  const snapshot = createCatalogSnapshotV1({
    import: {
      sourceKind: "graphql-schema",
      adapterKey: "graphql",
      importerVersion: "test",
      importedAt: "2026-03-14T00:00:00.000Z",
      sourceConfigHash: "hash_test",
    },
    catalog,
  });

  const source = {
    id: "src_linear",
    workspaceId: "ws_linear",
    name: "Linear",
    kind: "graphql-schema",
    endpoint: "https://api.linear.app/graphql",
    status: "connected",
    enabled: true,
    namespace: "linear",
    bindingVersion: 1,
    binding: {},
    importAuthPolicy: "reuse_runtime",
    importAuth: { kind: "none" },
    auth: { kind: "none" },
    sourceHash: "hash_test",
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  } satisfies Source;

  const sourceRecord = {
    id: source.id,
    workspaceId: source.workspaceId,
    catalogId: "catalog_linear",
    catalogRevisionId: "catalog_revision_linear",
    name: source.name,
    kind: source.kind,
    endpoint: source.endpoint,
    status: source.status,
    enabled: source.enabled,
    namespace: source.namespace,
    importAuthPolicy: source.importAuthPolicy,
    bindingConfigJson: "{}",
    sourceHash: source.sourceHash,
    lastError: source.lastError,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  } satisfies StoredSourceRecord;

  const revision = {
    id: "catalog_revision_linear",
    catalogId: "catalog_linear",
    revisionNumber: 1,
    sourceConfigJson: "{}",
    importMetadataJson: "{}",
    importMetadataHash: "hash_import",
    snapshotHash: "hash_snapshot",
    createdAt: 0,
    updatedAt: 0,
  } satisfies StoredSourceCatalogRevisionRecord;

  return {
    source,
    sourceRecord,
    revision,
    snapshot,
    catalog,
    projected: projectCatalogForAgentSdk({
      catalog,
    }),
    importMetadata: snapshot.import,
  };
};

describe("source-catalog-runtime", () => {
  it.effect("projects friendly schemas for discover and inspection consumers", () =>
    Effect.gen(function* () {
      const [tool] = yield* expandCatalogTools({
        catalogs: [createLoadedCatalog()],
        includeSchemas: true,
      });

      expect(tool).toBeDefined();
      expect(tool?.descriptor.inputSchema).toMatchObject({
        type: "object",
        properties: {
          filter: {
            title: "TeamFilter",
          },
          after: {
            type: "string",
          },
          before: {
            type: "string",
          },
        },
      });

      const serializedInput = JSON.stringify(tool?.descriptor.inputSchema);
      expect(serializedInput).not.toContain("\"$ref\":\"#/$defs/shape_");
      expect(serializedInput).not.toContain("\"shape_");
    }));

  it.effect("projects a single tool by path without expanding the whole catalog", () =>
    Effect.gen(function* () {
      const tool = yield* expandCatalogToolByPath({
        catalogs: [createLoadedCatalog()],
        path: "linear.teams",
        includeSchemas: true,
      });

      expect(tool).not.toBeNull();
      expect(tool?.path).toBe("linear.teams");
      expect(tool?.descriptor.inputSchema).toMatchObject({
        type: "object",
        properties: {
          filter: {
            title: "TeamFilter",
          },
        },
      });
    }));
});
