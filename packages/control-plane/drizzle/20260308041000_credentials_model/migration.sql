CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"auth_kind" text NOT NULL,
	"auth_header_name" text NOT NULL,
	"auth_prefix" text NOT NULL,
	"token_provider_id" text NOT NULL,
	"token_handle" text NOT NULL,
	"refresh_token_provider_id" text,
	"refresh_token_handle" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "credentials_auth_kind_check" CHECK ("auth_kind" in ('bearer', 'oauth2'))
);
--> statement-breakpoint
CREATE INDEX "credentials_workspace_idx" ON "credentials" ("workspace_id","updated_at","id");
--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT "sources_auth_kind_check";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN "auth_kind";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN "auth_header_name";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN "auth_prefix";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_credential_bindings_workspace_idx";
--> statement-breakpoint
DROP TABLE "source_credential_bindings";
--> statement-breakpoint
CREATE TABLE "source_credential_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "source_credential_bindings_workspace_source_idx" ON "source_credential_bindings" ("workspace_id","source_id");
--> statement-breakpoint
CREATE INDEX "source_credential_bindings_workspace_idx" ON "source_credential_bindings" ("workspace_id","updated_at","source_id");
