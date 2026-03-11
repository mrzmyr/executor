import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { authLeasesTable } from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import {
  AccountIdSchema,
  AuthArtifactIdSchema,
  AuthLeaseIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "../ids";

import {
  AuthArtifactSlotSchema,
  RequestPlacementTemplatesJsonSchema,
  type RequestPlacementTemplate,
} from "./auth-artifact";

const authLeaseSchemaOverrides = {
  id: AuthLeaseIdSchema,
  authArtifactId: AuthArtifactIdSchema,
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  actorAccountId: Schema.NullOr(AccountIdSchema),
  slot: AuthArtifactSlotSchema,
  placementsTemplateJson: Schema.String,
  expiresAt: Schema.NullOr(TimestampMsSchema),
  refreshAfter: Schema.NullOr(TimestampMsSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const AuthLeaseSchema = createSelectSchema(
  authLeasesTable,
  authLeaseSchemaOverrides,
);

export type AuthLease = typeof AuthLeaseSchema.Type;

const decodeLeasePlacementTemplatesOption = Schema.decodeUnknownOption(
  RequestPlacementTemplatesJsonSchema,
);

export const decodeAuthLeasePlacementTemplates = (
  lease: Pick<AuthLease, "placementsTemplateJson">,
): ReadonlyArray<RequestPlacementTemplate> | null => {
  const decoded = decodeLeasePlacementTemplatesOption(lease.placementsTemplateJson);
  return decoded._tag === "Some" ? decoded.value : null;
};

export const authLeaseSecretRefs = (
  lease: Pick<AuthLease, "placementsTemplateJson">,
) =>
  (decodeAuthLeasePlacementTemplates(lease) ?? []).flatMap((placement) =>
    placement.parts.flatMap((part) => (part.kind === "secret_ref" ? [part.ref] : [])),
  );
