import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

export class UserStoreError extends Schema.TaggedError<UserStoreError>()(
  "UserStoreError",
  {},
  HttpApiSchema.annotations({ status: 500 }),
) {}

export class WorkOSError extends Schema.TaggedError<WorkOSError>()(
  "WorkOSError",
  {},
  HttpApiSchema.annotations({ status: 500 }),
) {}
