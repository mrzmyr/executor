import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  SourceRecipeIdSchema,
  SourceRecipeRevisionIdSchema,
  SourceRecipeSchemaBundleIdSchema,
} from "../ids";

export const SourceRecipeKindSchema = Schema.Literal(
  "http_api",
  "mcp",
  "internal",
);

export const SourceRecipeAdapterKeySchema = Schema.String;

export const SourceRecipeVisibilitySchema = Schema.Literal(
  "private",
  "workspace",
  "organization",
  "public",
);

export const SourceRecipeDocumentKindSchema = Schema.String;

export const SourceRecipeSchemaBundleKindSchema = Schema.String;

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

export const SourceRecipeOperationProviderKindSchema = Schema.String;

export const StoredSourceRecipeRecordSchema = Schema.Struct({
  id: SourceRecipeIdSchema,
  kind: SourceRecipeKindSchema,
  adapterKey: SourceRecipeAdapterKeySchema,
  providerKey: Schema.String,
  name: Schema.String,
  summary: Schema.NullOr(Schema.String),
  visibility: SourceRecipeVisibilitySchema,
  latestRevisionId: SourceRecipeRevisionIdSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const StoredSourceRecipeRevisionRecordSchema = Schema.Struct({
  id: SourceRecipeRevisionIdSchema,
  recipeId: SourceRecipeIdSchema,
  revisionNumber: Schema.Number,
  sourceConfigJson: Schema.String,
  manifestJson: Schema.NullOr(Schema.String),
  manifestHash: Schema.NullOr(Schema.String),
  materializationHash: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const StoredSourceRecipeDocumentRecordSchema = Schema.Struct({
  id: Schema.String,
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  documentKind: SourceRecipeDocumentKindSchema,
  documentKey: Schema.String,
  contentText: Schema.String,
  contentHash: Schema.String,
  fetchedAt: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const StoredSourceRecipeSchemaBundleRecordSchema = Schema.Struct({
  id: SourceRecipeSchemaBundleIdSchema,
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  bundleKind: SourceRecipeSchemaBundleKindSchema,
  refsJson: Schema.String,
  contentHash: Schema.String,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const StoredSourceRecipeOperationRowSchema = Schema.Struct({
  id: Schema.String,
  recipeRevisionId: SourceRecipeRevisionIdSchema,
  operationKey: Schema.String,
  transportKind: SourceRecipeTransportKindSchema,
  toolId: Schema.String,
  title: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  operationKind: SourceRecipeOperationKindSchema,
  searchText: Schema.String,
  inputSchemaJson: Schema.NullOr(Schema.String),
  outputSchemaJson: Schema.NullOr(Schema.String),
  providerKind: SourceRecipeOperationProviderKindSchema,
  providerDataJson: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});
export const StoredSourceRecipeOperationRecordSchema =
  StoredSourceRecipeOperationRowSchema.annotations({
    identifier: "StoredSourceRecipeOperationRecord",
  });

export type SourceRecipeKind = typeof SourceRecipeKindSchema.Type;
export type SourceRecipeAdapterKey = typeof SourceRecipeAdapterKeySchema.Type;
export type SourceRecipeVisibility = typeof SourceRecipeVisibilitySchema.Type;
export type SourceRecipeDocumentKind = typeof SourceRecipeDocumentKindSchema.Type;
export type SourceRecipeSchemaBundleKind =
  typeof SourceRecipeSchemaBundleKindSchema.Type;
export type SourceRecipeTransportKind = typeof SourceRecipeTransportKindSchema.Type;
export type SourceRecipeOperationKind = typeof SourceRecipeOperationKindSchema.Type;
export type SourceRecipeOperationProviderKind =
  typeof SourceRecipeOperationProviderKindSchema.Type;
export type StoredSourceRecipeRecord = typeof StoredSourceRecipeRecordSchema.Type;
export type StoredSourceRecipeRevisionRecord = typeof StoredSourceRecipeRevisionRecordSchema.Type;
export type StoredSourceRecipeDocumentRecord = typeof StoredSourceRecipeDocumentRecordSchema.Type;
export type StoredSourceRecipeSchemaBundleRecord =
  typeof StoredSourceRecipeSchemaBundleRecordSchema.Type;
export type StoredSourceRecipeOperationRow = typeof StoredSourceRecipeOperationRowSchema.Type;
export type StoredSourceRecipeOperationRecord =
  typeof StoredSourceRecipeOperationRecordSchema.Type;
