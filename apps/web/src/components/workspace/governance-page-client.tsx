"use client";

import { WorkspaceClient } from "@/components/workspace-client";
import type { WorkspacePageProps } from "@/components/workspace/workspace-page-props";

export function GovernancePageClient(props: WorkspacePageProps) {
  return <WorkspaceClient activeNav="Inbox" {...props} />;
}
