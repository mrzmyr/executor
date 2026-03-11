ALTER TABLE "workspace_source_credentials"
RENAME TO "workspace_source_auth_artifacts";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
ADD COLUMN "artifact_kind" text;--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
ADD COLUMN "config_json" text;--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
ADD COLUMN "grant_set_json" text;--> statement-breakpoint

UPDATE "workspace_source_auth_artifacts"
SET
  "artifact_kind" = CASE
    WHEN "auth_kind" = 'bearer' THEN 'static_bearer'
    WHEN "auth_kind" = 'oauth2' THEN 'static_oauth2'
    ELSE 'static_placements'
  END,
  "config_json" = CASE
    WHEN "auth_kind" = 'bearer' THEN jsonb_build_object(
      'headerName', "auth_header_name",
      'prefix', "auth_prefix",
      'token', jsonb_build_object(
        'providerId', "token_provider_id",
        'handle', "token_handle"
      )
    )::text
    WHEN "auth_kind" = 'oauth2' THEN jsonb_build_object(
      'headerName', "auth_header_name",
      'prefix', "auth_prefix",
      'accessToken', jsonb_build_object(
        'providerId', "token_provider_id",
        'handle', "token_handle"
      ),
      'refreshToken',
        CASE
          WHEN "refresh_token_provider_id" IS NOT NULL AND "refresh_token_handle" IS NOT NULL
            THEN jsonb_build_object(
              'providerId', "refresh_token_provider_id",
              'handle', "refresh_token_handle"
            )
          ELSE 'null'::jsonb
        END
    )::text
    ELSE jsonb_build_object('placements', '[]'::jsonb)::text
  END
WHERE "artifact_kind" IS NULL OR "config_json" IS NULL;--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
ALTER COLUMN "artifact_kind" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
ALTER COLUMN "config_json" SET NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "credentials_workspace_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "credentials_workspace_source_actor_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "credentials_workspace_source_idx";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP CONSTRAINT IF EXISTS "credentials_auth_kind_check";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP CONSTRAINT IF EXISTS "credentials_slot_check";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP COLUMN "auth_kind";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP COLUMN "auth_header_name";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP COLUMN "auth_prefix";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP COLUMN "token_provider_id";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP COLUMN "token_handle";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP COLUMN "refresh_token_provider_id";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
DROP COLUMN "refresh_token_handle";--> statement-breakpoint

ALTER TABLE "workspace_source_auth_artifacts"
ADD CONSTRAINT "auth_artifacts_slot_check"
CHECK ("slot" in ('runtime', 'import'));--> statement-breakpoint

CREATE INDEX "auth_artifacts_workspace_idx"
ON "workspace_source_auth_artifacts" ("workspace_id","updated_at","id");--> statement-breakpoint

CREATE UNIQUE INDEX "auth_artifacts_workspace_source_actor_idx"
ON "workspace_source_auth_artifacts" ("workspace_id","source_id","actor_account_id","slot");--> statement-breakpoint

CREATE INDEX "auth_artifacts_workspace_source_idx"
ON "workspace_source_auth_artifacts" ("workspace_id","source_id","updated_at","id");--> statement-breakpoint

CREATE TABLE "workspace_source_auth_leases" (
  "id" text PRIMARY KEY NOT NULL,
  "auth_artifact_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "source_id" text NOT NULL,
  "actor_account_id" text,
  "slot" text NOT NULL,
  "placements_json" text NOT NULL,
  "expires_at" bigint,
  "refresh_after" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);--> statement-breakpoint

ALTER TABLE "workspace_source_auth_leases"
ADD CONSTRAINT "auth_leases_slot_check"
CHECK ("slot" in ('runtime', 'import'));--> statement-breakpoint

CREATE UNIQUE INDEX "auth_leases_auth_artifact_idx"
ON "workspace_source_auth_leases" ("auth_artifact_id");--> statement-breakpoint

CREATE INDEX "auth_leases_workspace_source_idx"
ON "workspace_source_auth_leases" (
  "workspace_id",
  "source_id",
  "actor_account_id",
  "slot",
  "updated_at",
  "id"
);--> statement-breakpoint

ALTER TABLE "source_auth_sessions"
DROP CONSTRAINT IF EXISTS "source_auth_sessions_provider_kind_check";--> statement-breakpoint
