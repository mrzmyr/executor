import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import {
  credentialsTable,
  sourceCredentialBindingsTable,
} from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import {
  CredentialIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const CredentialAuthKindSchema = Schema.Literal("bearer", "oauth2");

const credentialSchemaOverrides = {
  id: CredentialIdSchema,
  workspaceId: WorkspaceIdSchema,
  authKind: CredentialAuthKindSchema,
  authHeaderName: Schema.String,
  authPrefix: Schema.String,
  tokenProviderId: Schema.String,
  tokenHandle: Schema.String,
  refreshTokenProviderId: Schema.NullOr(Schema.String),
  refreshTokenHandle: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

const sourceCredentialBindingSchemaOverrides = {
  id: Schema.String,
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  credentialId: CredentialIdSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const CredentialSchema = createSelectSchema(
  credentialsTable,
  credentialSchemaOverrides,
);

export const SourceCredentialBindingSchema = createSelectSchema(
  sourceCredentialBindingsTable,
  sourceCredentialBindingSchemaOverrides,
);

export type CredentialAuthKind = typeof CredentialAuthKindSchema.Type;
export type Credential = typeof CredentialSchema.Type;
export type SourceCredentialBinding = typeof SourceCredentialBindingSchema.Type;
