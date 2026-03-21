import { sql } from "drizzle-orm";
import type { BopoDb } from "./client";

/** Cheap connection liveness check (no table scan). Kept as SQL because Drizzle has no relational API for a table-free SELECT. */
export async function pingDatabase(db: BopoDb): Promise<void> {
  await db.execute(sql`SELECT 1`);
}
