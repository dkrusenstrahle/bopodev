ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "knowledge_paths_json" text NOT NULL DEFAULT '[]';
