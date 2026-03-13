"use client";

import { WorkspaceClient } from "@/components/workspace-client";
import type { WorkspacePageProps } from "@/components/workspace/workspace-page-props";

export function TemplatesPageClient(props: WorkspacePageProps) {
  return <WorkspaceClient activeNav="Templates" {...props} />;
}
