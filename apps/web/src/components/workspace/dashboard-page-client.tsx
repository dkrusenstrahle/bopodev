"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceClient } from "@/components/workspace-client";
import type { WorkspacePageProps } from "@/components/workspace/workspace-page-props";
import { subscribeToRealtime } from "@/lib/realtime";

const DASHBOARD_REFRESH_DELAY_MS = 350;

export function DashboardPageClient(props: WorkspacePageProps) {
  const router = useRouter();
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!props.companyId) {
      return;
    }

    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== null) {
        return;
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        router.refresh();
      }, DASHBOARD_REFRESH_DELAY_MS);
    };

    const unsubscribe = subscribeToRealtime({
      companyId: props.companyId,
      channels: ["governance", "office-space", "heartbeat-runs", "attention"],
      onMessage: (message) => {
        if (message.kind !== "event") {
          return;
        }
        if (
          message.channel === "governance" ||
          message.channel === "office-space" ||
          message.channel === "heartbeat-runs" ||
          message.channel === "attention"
        ) {
          scheduleRefresh();
        }
      }
    });

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [props.companyId, router]);

  return <WorkspaceClient activeNav="Dashboard" {...props} />;
}
