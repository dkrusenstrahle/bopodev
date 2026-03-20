import { redirect } from "next/navigation";

export default async function SettingsModelsPage({
  searchParams
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { companyId } = await searchParams;
  redirect(companyId ? `/settings?companyId=${encodeURIComponent(companyId)}` : "/settings");
}
