import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  SourceIdSchema,
  WorkspaceIdSchema,
  WorkspaceSourceOauthClientIdSchema,
} from "../ids";

export const WorkspaceSourceOauthClientRedirectModeSchema = Schema.Literal(
  "app_callback",
  "loopback",
);

export const WorkspaceSourceOauthClientMetadataSchema = Schema.Struct({
  redirectMode: Schema.optional(WorkspaceSourceOauthClientRedirectModeSchema),
});

export const WorkspaceSourceOauthClientMetadataJsonSchema = Schema.parseJson(
  WorkspaceSourceOauthClientMetadataSchema,
);

export const SourceOauthClientInputSchema = Schema.Struct({
  clientId: Schema.Trim.pipe(Schema.nonEmptyString()),
  clientSecret: Schema.optional(
    Schema.NullOr(Schema.Trim.pipe(Schema.nonEmptyString())),
  ),
  redirectMode: Schema.optional(WorkspaceSourceOauthClientRedirectModeSchema),
});

export const WorkspaceSourceOauthClientSchema = Schema.Struct({
  id: WorkspaceSourceOauthClientIdSchema,
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  providerKey: Schema.String,
  clientId: Schema.String,
  clientSecretProviderId: Schema.NullOr(Schema.String),
  clientSecretHandle: Schema.NullOr(Schema.String),
  clientMetadataJson: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type WorkspaceSourceOauthClient = typeof WorkspaceSourceOauthClientSchema.Type;
export type WorkspaceSourceOauthClientRedirectMode =
  typeof WorkspaceSourceOauthClientRedirectModeSchema.Type;
export type WorkspaceSourceOauthClientMetadata =
  typeof WorkspaceSourceOauthClientMetadataSchema.Type;
export type SourceOauthClientInput = typeof SourceOauthClientInputSchema.Type;
