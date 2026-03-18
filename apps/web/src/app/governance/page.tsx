import { redirect } from "next/navigation";

export default async function GovernancePage({
  searchParams
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { companyId } = await searchParams;
  const query = new URLSearchParams();
  query.set("preset", "board-decisions");
  if (companyId) {
    query.set("companyId", companyId);
  }
  redirect(`/inbox?${query.toString()}`);
}
