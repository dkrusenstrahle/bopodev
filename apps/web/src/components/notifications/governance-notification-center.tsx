"use client";

import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ApprovalRequest, BoardAttentionItem } from "bopodev-contracts";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "@/lib/api";
import { getGovernanceToastContent } from "@/lib/governance-notifications";
import { subscribeToRealtime } from "@/lib/realtime";

const ROUTER_REFRESH_DELAY_MS = 250;
const TEST_NOTIFICATION_EVENT = "bopodev:test-governance-notification";

type GovernanceNotificationTestDetail = {
  approval: ApprovalRequest;
};

export function GovernanceNotificationCenter({ companyId }: { companyId: string | null }) {
  const router = useRouter();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [attentionItems, setAttentionItems] = useState<BoardAttentionItem[]>([]);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<Set<string>>(new Set());
  const dismissedApprovalIdsRef = useRef<Set<string>>(new Set());
  const seenApprovalIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const renderedToastIdsRef = useRef(new Set<string>());

  useEffect(() => {
    dismissedApprovalIdsRef.current = dismissedApprovalIds;
  }, [dismissedApprovalIds]);

  useEffect(() => {
    if (!companyId) {
      setDismissedApprovalIds(new Set());
      seenApprovalIdsRef.current.clear();
      return;
    }

    let cancelled = false;
    void apiGet<{
      items: Array<{
        approval: { id: string; status: string };
        dismissedAt: string | null;
        seenAt: string | null;
      }>;
    }>("/governance/inbox", companyId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        const nextDismissed = new Set<string>();
        const nextSeen = new Set<string>();
        for (const item of response.data.items) {
          if (item.approval.status === "pending" && item.dismissedAt) {
            nextDismissed.add(item.approval.id);
          }
          if (item.seenAt) {
            nextSeen.add(item.approval.id);
          }
        }
        setDismissedApprovalIds(nextDismissed);
        seenApprovalIdsRef.current = nextSeen;
      })
      .catch(() => {
        if (!cancelled) {
          setDismissedApprovalIds(new Set());
          seenApprovalIdsRef.current.clear();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (!companyId) {
      setAttentionItems([]);
      return;
    }
    let cancelled = false;
    void apiGet<{ actorId: string; items: BoardAttentionItem[] }>("/attention", companyId)
      .then((response) => {
        if (!cancelled) {
          setAttentionItems(response.data.items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAttentionItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (!companyId) {
      setApprovals([]);
      return;
    }

    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== null) {
        return;
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        router.refresh();
      }, ROUTER_REFRESH_DELAY_MS);
    };

    const applyVisibleApprovals = (nextApprovals: ApprovalRequest[]) =>
      sortApprovals(
        nextApprovals.filter(
          (approval) => approval.status === "pending" && !dismissedApprovalIdsRef.current.has(approval.id)
        )
      );

    const unsubscribe = subscribeToRealtime({
      companyId,
      channels: ["governance", "attention"],
      onMessage: (message) => {
        if (message.kind !== "event") {
          return;
        }
        if (message.channel === "governance") {
          const governanceEvent = message.event;
          switch (governanceEvent.type) {
            case "approvals.snapshot":
              setApprovals(applyVisibleApprovals(governanceEvent.approvals));
              return;
            case "approval.created":
              setApprovals((current) =>
                applyVisibleApprovals([governanceEvent.approval, ...current.filter((approval) => approval.id !== governanceEvent.approval.id)])
              );
              scheduleRefresh();
              return;
            case "approval.resolved":
              setApprovals((current) => current.filter((approval) => approval.id !== governanceEvent.approval.id));
              scheduleRefresh();
              return;
          }
        }
        if (message.channel === "attention") {
          const event = message.event;
          if (event.type === "attention.snapshot") {
            setAttentionItems(event.items);
            scheduleRefresh();
            return;
          }
          if (event.type === "attention.updated") {
            setAttentionItems((current) => [event.item, ...current.filter((item) => item.key !== event.item.key)]);
            scheduleRefresh();
            return;
          }
          if (event.type === "attention.resolved") {
            setAttentionItems((current) => current.map((item) => (item.key === event.key ? { ...item, state: "resolved" } : item)));
            scheduleRefresh();
          }
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
  }, [companyId, router]);

  useEffect(() => {
    if (!companyId) {
      return;
    }

    const handleTestNotification = (event: Event) => {
      const customEvent = event as CustomEvent<GovernanceNotificationTestDetail>;
      if (!customEvent.detail?.approval || customEvent.detail.approval.companyId !== companyId) {
        return;
      }
      setApprovals((current) =>
        sortApprovals(
          [customEvent.detail.approval, ...current.filter((approval) => approval.id !== customEvent.detail.approval.id)].filter(
            (approval) => !dismissedApprovalIdsRef.current.has(approval.id)
          )
        )
      );
    };

    window.addEventListener(TEST_NOTIFICATION_EVENT, handleTestNotification);
    return () => {
      window.removeEventListener(TEST_NOTIFICATION_EVENT, handleTestNotification);
    };
  }, [companyId]);

  useEffect(() => {
    if (!companyId) {
      dismissAllRenderedToasts(renderedToastIdsRef.current);
      return;
    }

    const nextToastIds = new Set<string>();

    for (const approval of approvals) {
      const toastId = getToastId(companyId, approval.id);
      nextToastIds.add(toastId);
      renderedToastIdsRef.current.add(toastId);
      if (!seenApprovalIdsRef.current.has(approval.id)) {
        seenApprovalIdsRef.current.add(approval.id);
        void apiPost(`/governance/inbox/${approval.id}/seen`, companyId, {});
      }

      const content = getGovernanceToastContent(approval, companyId);
      toast.custom(
        () => (
          <div className="pointer-events-auto w-88 rounded-md border bg-background p-4 text-foreground">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <div className="text-sm font-semibold leading-5">{content.title}</div>
                <div className="text-sm leading-5 text-muted-foreground">{content.message}</div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Dismiss notification"
                className="shrink-0"
                onClick={() => handleDismiss(companyId, approval, setApprovals, setDismissedApprovalIds)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="mt-3">
              <Button asChild variant="outline" size="sm">
                <Link href={content.href}>{content.linkLabel}</Link>
              </Button>
            </div>
          </div>
        ),
        {
          id: toastId,
          duration: Infinity
        }
      );
    }

    for (const toastId of renderedToastIdsRef.current) {
      if (!nextToastIds.has(toastId)) {
        toast.dismiss(toastId);
        renderedToastIdsRef.current.delete(toastId);
      }
    }
  }, [approvals, companyId]);

  useEffect(() => {
    if (!companyId) {
      return;
    }
    const openItems = attentionItems.filter(
      (item) =>
        item.category !== "approval_required" &&
        (item.state === "open" || item.state === "acknowledged") &&
        item.severity !== "info"
    );
    for (const item of openItems) {
      const toastId = `attention:${companyId}:${item.key}`;
      toast.custom(
        () => (
          <div className="pointer-events-auto w-88 rounded-md border bg-background p-4 text-foreground">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <div className="text-sm font-semibold leading-5">{item.title}</div>
                <div className="text-sm leading-5 text-muted-foreground">{item.contextSummary}</div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Dismiss notification"
                className="shrink-0"
                onClick={() => {
                  toast.dismiss(toastId);
                  void apiPost(`/attention/${encodeURIComponent(item.key)}/dismiss`, companyId, {});
                }}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={`${item.actionHref}?companyId=${encodeURIComponent(companyId)}`}>{item.actionLabel}</a>
              </Button>
              {!item.seenAt ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void apiPost(`/attention/${encodeURIComponent(item.key)}/seen`, companyId, {});
                  }}
                >
                  Mark seen
                </Button>
              ) : null}
            </div>
          </div>
        ),
        {
          id: toastId,
          duration: Infinity
        }
      );
    }
  }, [attentionItems, companyId]);

  useEffect(() => {
    return () => {
      dismissAllRenderedToasts(renderedToastIdsRef.current);
    };
  }, []);

  return null;
}

function handleDismiss(
  companyId: string,
  approval: ApprovalRequest,
  setApprovals: Dispatch<SetStateAction<ApprovalRequest[]>>,
  setDismissedApprovalIds: Dispatch<SetStateAction<Set<string>>>
) {
  toast.dismiss(getToastId(companyId, approval.id));
  setDismissedApprovalIds((current) => {
    const next = new Set(current);
    next.add(approval.id);
    return next;
  });
  void apiPost(`/governance/inbox/${approval.id}/dismiss`, companyId, {});
  setApprovals((current) => current.filter((item) => item.id !== approval.id));
}

function sortApprovals(approvals: ApprovalRequest[]) {
  return [...approvals].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function getToastId(companyId: string, approvalId: string) {
  return `governance:${companyId}:${approvalId}`;
}

function dismissAllRenderedToasts(toastIds: Set<string>) {
  for (const toastId of toastIds) {
    toast.dismiss(toastId);
  }
  toastIds.clear();
}
