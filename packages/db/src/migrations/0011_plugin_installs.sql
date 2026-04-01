CREATE TABLE "plugin_installs" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "plugin_id" text NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
  "plugin_version" text NOT NULL,
  "source_type" text DEFAULT 'registry' NOT NULL,
  "source_ref" text,
  "integrity" text,
  "build_hash" text,
  "artifact_path" text,
  "manifest_json" text DEFAULT '{}' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_plugin_installs_company_plugin_created"
  ON "plugin_installs" ("company_id", "plugin_id", "created_at");
