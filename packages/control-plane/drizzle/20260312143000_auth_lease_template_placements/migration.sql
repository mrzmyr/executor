ALTER TABLE "workspace_source_auth_leases"
ADD COLUMN "placements_template_json" text;--> statement-breakpoint

UPDATE "workspace_source_auth_leases"
SET "placements_template_json" = COALESCE(
  (
    SELECT jsonb_agg(
      CASE
        WHEN placement ->> 'location' = 'body' THEN jsonb_build_object(
          'location', 'body',
          'path', placement ->> 'path',
          'parts', jsonb_build_array(
            jsonb_build_object(
              'kind', 'literal',
              'value', COALESCE(placement ->> 'value', '')
            )
          )
        )
        ELSE jsonb_build_object(
          'location', placement ->> 'location',
          'name', placement ->> 'name',
          'parts', jsonb_build_array(
            jsonb_build_object(
              'kind', 'literal',
              'value', COALESCE(placement ->> 'value', '')
            )
          )
        )
      END
    )::text
    FROM jsonb_array_elements(COALESCE("placements_json"::jsonb, '[]'::jsonb)) AS placement
  ),
  '[]'
);--> statement-breakpoint

ALTER TABLE "workspace_source_auth_leases"
ALTER COLUMN "placements_template_json" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "workspace_source_auth_leases"
DROP COLUMN "placements_json";--> statement-breakpoint
