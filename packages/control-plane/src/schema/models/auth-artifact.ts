import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { authArtifactsTable } from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import {
  AccountIdSchema,
  AuthArtifactIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const SecretRefSchema = Schema.Struct({
  providerId: Schema.String,
  handle: Schema.String,
});

export const AuthArtifactSlotSchema = Schema.Literal("runtime", "import");
export const CredentialSlotSchema = AuthArtifactSlotSchema;

export const AuthArtifactKindSchema = Schema.String;
export const AuthGrantSetSchema = Schema.Array(Schema.String);

export const RequestPlacementPartSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("literal"),
    value: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("secret_ref"),
    ref: SecretRefSchema,
  }),
);

export const RequestPlacementTemplateSchema = Schema.Union(
  Schema.Struct({
    location: Schema.Literal("header"),
    name: Schema.String,
    parts: Schema.Array(RequestPlacementPartSchema),
  }),
  Schema.Struct({
    location: Schema.Literal("query"),
    name: Schema.String,
    parts: Schema.Array(RequestPlacementPartSchema),
  }),
  Schema.Struct({
    location: Schema.Literal("cookie"),
    name: Schema.String,
    parts: Schema.Array(RequestPlacementPartSchema),
  }),
  Schema.Struct({
    location: Schema.Literal("body"),
    path: Schema.String,
    parts: Schema.Array(RequestPlacementPartSchema),
  }),
);

export const RequestPlacementSchema = Schema.Union(
  Schema.Struct({
    location: Schema.Literal("header"),
    name: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    location: Schema.Literal("query"),
    name: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    location: Schema.Literal("cookie"),
    name: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    location: Schema.Literal("body"),
    path: Schema.String,
    value: Schema.String,
  }),
);

export const RequestPlacementTemplatesJsonSchema = Schema.parseJson(
  Schema.Array(RequestPlacementTemplateSchema),
);

export const StaticBearerAuthArtifactKind = "static_bearer" as const;
export const StaticOAuth2AuthArtifactKind = "static_oauth2" as const;
export const StaticPlacementsAuthArtifactKind = "static_placements" as const;
export const RefreshableOAuth2AuthorizedUserAuthArtifactKind =
  "oauth2_authorized_user" as const;

export const OAuth2ClientAuthenticationMethodSchema = Schema.Literal(
  "none",
  "client_secret_post",
);

export const BuiltInAuthArtifactKindSchema = Schema.Literal(
  StaticBearerAuthArtifactKind,
  StaticOAuth2AuthArtifactKind,
  StaticPlacementsAuthArtifactKind,
  RefreshableOAuth2AuthorizedUserAuthArtifactKind,
);

export const StaticBearerAuthArtifactConfigSchema = Schema.Struct({
  headerName: Schema.String,
  prefix: Schema.String,
  token: SecretRefSchema,
});

export const StaticOAuth2AuthArtifactConfigSchema = Schema.Struct({
  headerName: Schema.String,
  prefix: Schema.String,
  accessToken: SecretRefSchema,
  refreshToken: Schema.NullOr(SecretRefSchema),
});

export const StaticPlacementsAuthArtifactConfigSchema = Schema.Struct({
  placements: Schema.Array(RequestPlacementTemplateSchema),
});

export const RefreshableOAuth2AuthorizedUserAuthArtifactConfigSchema = Schema.Struct({
  headerName: Schema.String,
  prefix: Schema.String,
  tokenEndpoint: Schema.String,
  clientId: Schema.String,
  clientAuthentication: OAuth2ClientAuthenticationMethodSchema,
  clientSecret: Schema.NullOr(SecretRefSchema),
  refreshToken: SecretRefSchema,
});

export const StaticBearerAuthArtifactConfigJsonSchema = Schema.parseJson(
  StaticBearerAuthArtifactConfigSchema,
);

export const StaticOAuth2AuthArtifactConfigJsonSchema = Schema.parseJson(
  StaticOAuth2AuthArtifactConfigSchema,
);

export const StaticPlacementsAuthArtifactConfigJsonSchema = Schema.parseJson(
  StaticPlacementsAuthArtifactConfigSchema,
);

export const RefreshableOAuth2AuthorizedUserAuthArtifactConfigJsonSchema = Schema.parseJson(
  RefreshableOAuth2AuthorizedUserAuthArtifactConfigSchema,
);

export const RequestPlacementsJsonSchema = Schema.parseJson(
  Schema.Array(RequestPlacementSchema),
);

export const AuthGrantSetJsonSchema = Schema.parseJson(AuthGrantSetSchema);

const decodeStaticBearerAuthArtifactConfigOption = Schema.decodeUnknownOption(
  StaticBearerAuthArtifactConfigJsonSchema,
);

const decodeStaticOAuth2AuthArtifactConfigOption = Schema.decodeUnknownOption(
  StaticOAuth2AuthArtifactConfigJsonSchema,
);

const decodeStaticPlacementsAuthArtifactConfigOption = Schema.decodeUnknownOption(
  StaticPlacementsAuthArtifactConfigJsonSchema,
);

const decodeRefreshableOAuth2AuthorizedUserAuthArtifactConfigOption = Schema.decodeUnknownOption(
  RefreshableOAuth2AuthorizedUserAuthArtifactConfigJsonSchema,
);

const decodeAuthGrantSetOption = Schema.decodeUnknownOption(AuthGrantSetJsonSchema);

const authArtifactSchemaOverrides = {
  id: AuthArtifactIdSchema,
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  actorAccountId: Schema.NullOr(AccountIdSchema),
  slot: AuthArtifactSlotSchema,
  artifactKind: AuthArtifactKindSchema,
  configJson: Schema.String,
  grantSetJson: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const AuthArtifactSchema = createSelectSchema(
  authArtifactsTable,
  authArtifactSchemaOverrides,
);

export type SecretRef = typeof SecretRefSchema.Type;
export type AuthArtifactSlot = typeof AuthArtifactSlotSchema.Type;
export type CredentialSlot = typeof CredentialSlotSchema.Type;
export type AuthArtifactKind = typeof AuthArtifactKindSchema.Type;
export type AuthGrantSet = typeof AuthGrantSetSchema.Type;
export type RequestPlacementPart = typeof RequestPlacementPartSchema.Type;
export type RequestPlacementTemplate = typeof RequestPlacementTemplateSchema.Type;
export type RequestPlacement = typeof RequestPlacementSchema.Type;
export type OAuth2ClientAuthenticationMethod =
  typeof OAuth2ClientAuthenticationMethodSchema.Type;
export type BuiltInAuthArtifactKind = typeof BuiltInAuthArtifactKindSchema.Type;
export type StaticBearerAuthArtifactConfig = typeof StaticBearerAuthArtifactConfigSchema.Type;
export type StaticOAuth2AuthArtifactConfig = typeof StaticOAuth2AuthArtifactConfigSchema.Type;
export type StaticPlacementsAuthArtifactConfig = typeof StaticPlacementsAuthArtifactConfigSchema.Type;
export type RefreshableOAuth2AuthorizedUserAuthArtifactConfig =
  typeof RefreshableOAuth2AuthorizedUserAuthArtifactConfigSchema.Type;
export type AuthArtifact = typeof AuthArtifactSchema.Type;

export type DecodedBuiltInAuthArtifactConfig =
  | {
      artifactKind: typeof StaticBearerAuthArtifactKind;
      config: StaticBearerAuthArtifactConfig;
    }
  | {
      artifactKind: typeof StaticOAuth2AuthArtifactKind;
      config: StaticOAuth2AuthArtifactConfig;
    }
  | {
      artifactKind: typeof StaticPlacementsAuthArtifactKind;
      config: StaticPlacementsAuthArtifactConfig;
    }
  | {
      artifactKind: typeof RefreshableOAuth2AuthorizedUserAuthArtifactKind;
      config: RefreshableOAuth2AuthorizedUserAuthArtifactConfig;
    };

export const decodeBuiltInAuthArtifactConfig = (
  artifact: Pick<AuthArtifact, "artifactKind" | "configJson">,
): DecodedBuiltInAuthArtifactConfig | null => {
  switch (artifact.artifactKind) {
    case StaticBearerAuthArtifactKind: {
      const decoded = decodeStaticBearerAuthArtifactConfigOption(artifact.configJson);
      return decoded._tag === "Some"
        ? {
            artifactKind: StaticBearerAuthArtifactKind,
            config: decoded.value,
          }
        : null;
    }
    case StaticOAuth2AuthArtifactKind: {
      const decoded = decodeStaticOAuth2AuthArtifactConfigOption(artifact.configJson);
      return decoded._tag === "Some"
        ? {
            artifactKind: StaticOAuth2AuthArtifactKind,
            config: decoded.value,
          }
        : null;
    }
    case StaticPlacementsAuthArtifactKind: {
      const decoded = decodeStaticPlacementsAuthArtifactConfigOption(artifact.configJson);
      return decoded._tag === "Some"
        ? {
            artifactKind: StaticPlacementsAuthArtifactKind,
            config: decoded.value,
          }
        : null;
    }
    case RefreshableOAuth2AuthorizedUserAuthArtifactKind: {
      const decoded = decodeRefreshableOAuth2AuthorizedUserAuthArtifactConfigOption(
        artifact.configJson,
      );
      return decoded._tag === "Some"
        ? {
            artifactKind: RefreshableOAuth2AuthorizedUserAuthArtifactKind,
            config: decoded.value,
          }
        : null;
    }
    default:
      return null;
  }
};

export const decodeAuthGrantSet = (grantSetJson: string | null): AuthGrantSet | null => {
  if (grantSetJson === null) {
    return null;
  }

  const decoded = decodeAuthGrantSetOption(grantSetJson);
  return decoded._tag === "Some" ? decoded.value : null;
};

export const authArtifactSecretRefs = (
  artifact: Pick<AuthArtifact, "artifactKind" | "configJson">,
): ReadonlyArray<SecretRef> => {
  const decoded = decodeBuiltInAuthArtifactConfig(artifact);
  if (decoded === null) {
    return [];
  }

  switch (decoded.artifactKind) {
    case StaticBearerAuthArtifactKind:
      return [decoded.config.token];
    case StaticOAuth2AuthArtifactKind:
      return [
        decoded.config.accessToken,
        ...(decoded.config.refreshToken === null ? [] : [decoded.config.refreshToken]),
      ];
    case StaticPlacementsAuthArtifactKind:
      return decoded.config.placements.flatMap((placement) =>
        placement.parts.flatMap((part) => part.kind === "secret_ref" ? [part.ref] : []),
      );
    case RefreshableOAuth2AuthorizedUserAuthArtifactKind:
      return [
        ...(decoded.config.clientSecret === null ? [] : [decoded.config.clientSecret]),
        decoded.config.refreshToken,
      ];
  }
};
