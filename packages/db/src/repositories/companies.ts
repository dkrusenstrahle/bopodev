import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { BopoDb } from "../client";
import { companies } from "../schema";
import { compactUpdate } from "./helpers";

export async function createCompany(db: BopoDb, input: { name: string; mission?: string | null }) {
  const id = nanoid(12);
  await db.insert(companies).values({
    id,
    name: input.name,
    mission: input.mission ?? null
  });
  return { id, ...input };
}

export async function listCompanies(db: BopoDb) {
  return db.select().from(companies).orderBy(desc(companies.createdAt));
}

export async function updateCompany(
  db: BopoDb,
  input: { id: string; name?: string; mission?: string | null }
) {
  const [company] = await db
    .update(companies)
    .set(compactUpdate({ name: input.name, mission: input.mission }))
    .where(eq(companies.id, input.id))
    .returning();
  return company ?? null;
}

export async function deleteCompany(db: BopoDb, id: string) {
  const [deletedCompany] = await db.delete(companies).where(eq(companies.id, id)).returning({ id: companies.id });
  return Boolean(deletedCompany);
}
