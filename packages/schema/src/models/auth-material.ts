import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { AuthConnectionIdSchema, AuthMaterialIdSchema } from "../ids";

export const AuthMaterialSchema = Schema.Struct({
  id: AuthMaterialIdSchema,
  connectionId: AuthConnectionIdSchema,
  ciphertext: Schema.String,
  keyVersion: Schema.String,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type AuthMaterial = typeof AuthMaterialSchema.Type;
