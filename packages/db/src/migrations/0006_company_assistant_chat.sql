CREATE TABLE "company_assistant_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "company_assistant_threads_company_idx" ON "company_assistant_threads" ("company_id");

CREATE TABLE "company_assistant_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL REFERENCES "company_assistant_threads"("id") ON DELETE CASCADE,
	"company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"metadata_json" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "company_assistant_messages_thread_created_idx" ON "company_assistant_messages" ("thread_id","created_at");
