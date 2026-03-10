import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import {
  sourceRecipeDocumentsTable,
  sourceRecipeOperationsTable,
  sourceRecipeRevisionsTable,
  sourceRecipesTable,
} from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import {
  SourceRecipeIdSchema,
  SourceRecipeRevisionIdSchema,
} from "../ids";

export const SourceRecipeKindSchema = Schema.Literal(
  "http_recipe",
  "graphql_recipe",
  "mcp_recipe",
  "internal_recipe",
);

export const SourceRecipeImporterKindSchema = Schema.Literal(
  "openapi",
  "google_discovery",
  "postman_collection",
  "snippet_bundle",
  "graphql_introspection",
  "mcp_manifest",
  "internal_manifest",
);

export const SourceRecipeVisibilitySchema = Schema.Literal(
  "private",
  "workspace",
  "organization",
  "public",
);

export const SourceRecipeDocumentKindSchema = Schema.Literal(
  "google_discovery",
  "openapi",
  "postman_collection",
  "postman_environment",
  "graphql_introspection",
  "mcp_manifest",
);

export const SourceRecipeTransportKindSchema = Schema.Literal(
  "http",
  "graphql",
  "mcp",
  "internal",
);

export const SourceRecipeOperationKindSchema = Schema.Literal(
  "read",
  "write",
  "delete",
  "unknown",
);

export const SourceRecipeOperationProviderKindSchema = Schema.Literal(
  "mcp",
  "openapi",
  "graphql",
  "internal",
);

export const SourceRecipeOpenApiMethodSchema = Schema.Literal(
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
);

export const SourceRecipeGraphqlOperationTypeSchema = Schema.Literal(
  "query",
  "mutation",
  "subscription",
);

const recipeRowSchemaOverrides = {
  id: SourceRecipeIdSchema,
  kind: SourceRecipeKindSchema,
  importerKind: SourceRecipeImporterKindSchema,
  visibility: SourceRecipeVisibilitySchema,
  latestRevisionId: SourceRecipeRevisionIdSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const recipeRevisionRowSchemaOverrides = {
  id: SourceRecipeRevisionIdSchema,
  recipeId: SourceRecipeIdSchema,
  revisionNumber: Schema.Number,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const recipeDocumentRowSchemaOverrides = {
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  documentKind: SourceRecipeDocumentKindSchema,
  fetchedAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const sourceRecipeOperationRowSchemaOverrides = {
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  transportKind: SourceRecipeTransportKindSchema,
  operationKind: SourceRecipeOperationKindSchema,
  providerKind: SourceRecipeOperationProviderKindSchema,
  openApiMethod: Schema.NullOr(SourceRecipeOpenApiMethodSchema),
  graphqlOperationType: Schema.NullOr(SourceRecipeGraphqlOperationTypeSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const StoredSourceRecipeRecordSchema = createSelectSchema(
  sourceRecipesTable,
  recipeRowSchemaOverrides,
);

export const StoredSourceRecipeRevisionRecordSchema = createSelectSchema(
  sourceRecipeRevisionsTable,
  recipeRevisionRowSchemaOverrides,
);

export const StoredSourceRecipeDocumentRecordSchema = createSelectSchema(
  sourceRecipeDocumentsTable,
  recipeDocumentRowSchemaOverrides,
);

export const StoredSourceRecipeOperationRowSchema = createSelectSchema(
  sourceRecipeOperationsTable,
  sourceRecipeOperationRowSchemaOverrides,
);

const sourceRecipeOperationCommonFields = {
  id: Schema.String,
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  operationKey: Schema.String,
  toolId: Schema.String,
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  operationKind: SourceRecipeOperationKindSchema,
  searchText: Schema.String,
  inputSchemaJson: Schema.NullOr(Schema.String),
  outputSchemaJson: Schema.NullOr(Schema.String),
  providerDataJson: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const StoredOpenApiSourceRecipeOperationRecordSchema = Schema.Struct({
  ...sourceRecipeOperationCommonFields,
  transportKind: Schema.Literal("http"),
  providerKind: Schema.Literal("openapi"),
  mcpToolName: Schema.Null,
  openApiMethod: SourceRecipeOpenApiMethodSchema,
  openApiPathTemplate: Schema.String,
  openApiOperationHash: Schema.String,
  openApiRawToolId: Schema.String,
  openApiOperationId: Schema.NullOr(Schema.String),
  openApiTagsJson: Schema.String,
  openApiRequestBodyRequired: Schema.NullOr(Schema.Boolean),
  graphqlOperationType: Schema.Null,
  graphqlOperationName: Schema.Null,
});

export const StoredGraphqlSourceRecipeOperationRecordSchema = Schema.Struct({
  ...sourceRecipeOperationCommonFields,
  transportKind: Schema.Literal("graphql"),
  providerKind: Schema.Literal("graphql"),
  mcpToolName: Schema.Null,
  openApiMethod: Schema.Null,
  openApiPathTemplate: Schema.Null,
  openApiOperationHash: Schema.Null,
  openApiRawToolId: Schema.Null,
  openApiOperationId: Schema.Null,
  openApiTagsJson: Schema.Null,
  openApiRequestBodyRequired: Schema.Null,
  graphqlOperationType: Schema.NullOr(SourceRecipeGraphqlOperationTypeSchema),
  graphqlOperationName: Schema.NullOr(Schema.String),
});

export const StoredMcpSourceRecipeOperationRecordSchema = Schema.Struct({
  ...sourceRecipeOperationCommonFields,
  transportKind: Schema.Literal("mcp"),
  providerKind: Schema.Literal("mcp"),
  mcpToolName: Schema.String,
  openApiMethod: Schema.Null,
  openApiPathTemplate: Schema.Null,
  openApiOperationHash: Schema.Null,
  openApiRawToolId: Schema.Null,
  openApiOperationId: Schema.Null,
  openApiTagsJson: Schema.Null,
  openApiRequestBodyRequired: Schema.Null,
  graphqlOperationType: Schema.Null,
  graphqlOperationName: Schema.Null,
});

export const StoredInternalSourceRecipeOperationRecordSchema = Schema.Struct({
  ...sourceRecipeOperationCommonFields,
  transportKind: Schema.Literal("internal"),
  providerKind: Schema.Literal("internal"),
  mcpToolName: Schema.Null,
  openApiMethod: Schema.Null,
  openApiPathTemplate: Schema.Null,
  openApiOperationHash: Schema.Null,
  openApiRawToolId: Schema.Null,
  openApiOperationId: Schema.Null,
  openApiTagsJson: Schema.Null,
  openApiRequestBodyRequired: Schema.Null,
  graphqlOperationType: Schema.Null,
  graphqlOperationName: Schema.Null,
});

export const StoredSourceRecipeOperationRecordSchema = Schema.Union(
  StoredOpenApiSourceRecipeOperationRecordSchema,
  StoredGraphqlSourceRecipeOperationRecordSchema,
  StoredMcpSourceRecipeOperationRecordSchema,
  StoredInternalSourceRecipeOperationRecordSchema,
).annotations({
  identifier: "StoredSourceRecipeOperationRecord",
});

export type SourceRecipeKind = typeof SourceRecipeKindSchema.Type;
export type SourceRecipeImporterKind = typeof SourceRecipeImporterKindSchema.Type;
export type SourceRecipeVisibility = typeof SourceRecipeVisibilitySchema.Type;
export type SourceRecipeDocumentKind = typeof SourceRecipeDocumentKindSchema.Type;
export type SourceRecipeTransportKind = typeof SourceRecipeTransportKindSchema.Type;
export type SourceRecipeOperationKind = typeof SourceRecipeOperationKindSchema.Type;
export type SourceRecipeOperationProviderKind =
  typeof SourceRecipeOperationProviderKindSchema.Type;
export type SourceRecipeOpenApiMethod = typeof SourceRecipeOpenApiMethodSchema.Type;
export type SourceRecipeGraphqlOperationType =
  typeof SourceRecipeGraphqlOperationTypeSchema.Type;
export type StoredSourceRecipeRecord = typeof StoredSourceRecipeRecordSchema.Type;
export type StoredSourceRecipeRevisionRecord = typeof StoredSourceRecipeRevisionRecordSchema.Type;
export type StoredSourceRecipeDocumentRecord = typeof StoredSourceRecipeDocumentRecordSchema.Type;
export type StoredSourceRecipeOperationRow = typeof StoredSourceRecipeOperationRowSchema.Type;
export type StoredOpenApiSourceRecipeOperationRecord =
  typeof StoredOpenApiSourceRecipeOperationRecordSchema.Type;
export type StoredGraphqlSourceRecipeOperationRecord =
  typeof StoredGraphqlSourceRecipeOperationRecordSchema.Type;
export type StoredMcpSourceRecipeOperationRecord =
  typeof StoredMcpSourceRecipeOperationRecordSchema.Type;
export type StoredInternalSourceRecipeOperationRecord =
  typeof StoredInternalSourceRecipeOperationRecordSchema.Type;
export type StoredSourceRecipeOperationRecord =
  typeof StoredSourceRecipeOperationRecordSchema.Type;
