"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";
import {
  Activity,
  BarChart3,
  Building2,
  Clock3,
  BriefcaseBusiness,
  Inbox,
  FolderKanban,
  GitBranch,
  LayoutDashboard,
  Map,
  ShieldCheck,
  Target,
  Users,
  Settings,
  Puzzle,
  LayoutTemplate
} from "lucide-react";
import type { SectionLabel, SectionSlug } from "@/lib/sections";
import {
  GovernanceNotificationCenter
} from "@/components/notifications/governance-notification-center";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

const navGroups: Array<{
  label: string;
  items: Array<{ slug: SectionSlug; label: SectionLabel; icon: React.ComponentType<{ className?: string }> }>;
}> = [
  {
    label: "Work",
    items: [
      { slug: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { slug: "projects", label: "Projects", icon: BriefcaseBusiness },
      { slug: "issues", label: "Issues", icon: FolderKanban },
      { slug: "goals", label: "Goals", icon: Target },
      { slug: "agents", label: "Agents", icon: Users }
    ]
  },
  {
    label: "Operations",
    items: [
      { slug: "inbox", label: "Inbox", icon: Inbox },
      { slug: "governance", label: "Approvals", icon: ShieldCheck },
      { slug: "runs", label: "Runs", icon: Clock3 },
      { slug: "trace-logs", label: "Logs", icon: Activity }
    ]
  },
  {
    label: "Company",
    items: [
      { slug: "org-chart", label: "Organization", icon: GitBranch },
      { slug: "office-space", label: "Office", icon: Map },
      { slug: "costs", label: "Costs", icon: BarChart3 },
    ]
  },
  {
    label: "Settings",
    items: [
      { slug: "models", label: "Models", icon: BarChart3 },
      { slug: "templates", label: "Templates", icon: LayoutTemplate },
      { slug: "plugins", label: "Plugins", icon: Puzzle },
      { slug: "settings", label: "Settings", icon: Settings }
    ]
  }
];

export function AppShell({
  leftPane,
  rightPane,
  secondaryPane,
  activeNav,
  companies,
  activeCompanyId,
  pendingApprovalsCount,
  hideSidebar = false
}: {
  leftPane: ReactNode;
  rightPane?: ReactNode;
  secondaryPane?: ReactNode;
  activeNav: SectionLabel;
  companies: Array<{ id: string; name: string }>;
  activeCompanyId: string | null;
  pendingApprovalsCount?: number;
  hideSidebar?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pendingApprovalsCountFromApi, setPendingApprovalsCountFromApi] = useState<number | null>(null);

  useEffect(() => {
    if (typeof pendingApprovalsCount === "number") {
      setPendingApprovalsCountFromApi(null);
      return;
    }
    if (!activeCompanyId) {
      setPendingApprovalsCountFromApi(null);
      return;
    }
    let cancelled = false;
    void apiGet<{ count: number }>("/governance/approvals/pending-count", activeCompanyId)
      .then((result) => {
        if (!cancelled) {
          setPendingApprovalsCountFromApi(Math.max(0, Math.floor(Number(result.data.count) || 0)));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPendingApprovalsCountFromApi(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, pendingApprovalsCount]);

  const resolvedPendingApprovalsCount =
    typeof pendingApprovalsCount === "number" ? pendingApprovalsCount : pendingApprovalsCountFromApi;

  function updateCompany(companyId: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("companyId", companyId);
    next.delete("issueId");
    const issueDetail = pathname.match(/^\/issues\/[^/]+$/);
    const projectDetail = pathname.match(/^\/projects\/[^/]+$/);
    const basePath = issueDetail ? "/issues" : projectDetail ? "/projects" : pathname;
    const href = `${basePath}?${next.toString()}` as Parameters<typeof router.replace>[0];
    router.replace(href);
  }

  const settingsHref = activeCompanyId
    ? ({ pathname: "/settings" as Route, query: { companyId: activeCompanyId } } as const)
    : ({ pathname: "/settings" as Route } as const);

  return (
    <div className={hideSidebar ? "ui-shell-root-no-sidebar" : "ui-shell-root"}>
      {!hideSidebar ? (
        <aside className="ui-shell-sidebar">
          <div className="ui-shell-sidebar-inner">
            <div className="ui-shell-sidebar-top">
              <div className="ui-shell-brand-stack">
                <div className="ui-shell-row">
                  <div className="ui-shell-brand-icon-wrap">
                    <Building2 className="ui-shell-building-icon" />
                  </div>
                  <div className="ui-shell-brand-copy">
                    <div className="ui-shell-brand-title">
                      {companies.find((company) => company.id === activeCompanyId)?.name ?? "BopoDev"}
                    </div>
                    <p className="ui-shell-brand-subtitle">AI operating workspace</p>
                  </div>
                </div>
              </div>
              <div className="ui-shell-stack-sm">
                <div className="ui-shell-section-label">Company</div>
                {companies.length > 0 ? (
                  <Select value={activeCompanyId ?? undefined} onValueChange={updateCompany}>
                    <SelectTrigger className="ui-shell-company-trigger">
                      <SelectValue placeholder="Select a company" />
                    </SelectTrigger>
                    <SelectContent>
                      {companies.map((company) => (
                        <SelectItem key={company.id} value={company.id}>
                          {company.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="ui-shell-company-empty">
                    Create your first company to unlock the control plane.
                  </div>
                )}
              </div>
            </div>
            <Separator className="ui-shell-separator" />
            <ScrollArea className="ui-shell-sidebar-scroll mt-8">
              <div className="ui-shell-sidebar-scroll-content">
              <div className="ui-shell-nav-groups">
                {navGroups.map((group) => (
                  <div key={group.label} className="ui-shell-stack-sm">
                    <div className="ui-shell-group-label">
                      {group.label}
                    </div>
                    <nav className="ui-shell-nav">
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        const isActive = activeNav === item.label;
                        const showPendingApprovalsBadge =
                          item.slug === "governance" &&
                          typeof resolvedPendingApprovalsCount === "number" &&
                          resolvedPendingApprovalsCount > 0;
                        return (
                          <Link
                            key={item.slug}
                            // These pages are highly stateful (runs/logs/issue activity), so avoid
                            // stale prefetched payloads when users navigate right after mutations.
                            prefetch={false}
                            href={
                              activeCompanyId
                                ? { pathname: `/${item.slug}` as Route, query: { companyId: activeCompanyId } }
                                : ({ pathname: `/${item.slug}` as Route } as const)
                            }
                            className={cn("ui-shell-nav-link", isActive ? "ui-shell-nav-link-active" : "ui-shell-nav-link-inactive")}
                          >
                            <Icon className="ui-shell-nav-icon" />
                            <span className="ui-shell-nav-label">{item.label}</span>
                            {showPendingApprovalsBadge ? (
                              <span className="ui-shell-nav-count-badge" aria-label={`${resolvedPendingApprovalsCount} pending approvals`}>
                                {resolvedPendingApprovalsCount > 99 ? "99+" : resolvedPendingApprovalsCount}
                              </span>
                            ) : null}
                          </Link>
                        );
                      })}
                    </nav>
                  </div>
                ))}
              </div>
              </div>
            </ScrollArea>
            <ThemeToggle />
          </div>
        </aside>
      ) : null}
      {secondaryPane ? (
        <aside className="ui-shell-secondary-sidebar">
          <div className="ui-shell-secondary-pane">{secondaryPane}</div>
        </aside>
      ) : null}
      <main className={cn("ui-shell-main", secondaryPane ? "ui-shell-main-with-secondary" : "")}>
        <header className="ui-shell-header">
          <div className="ui-shell-row">
            <div>
              <div className="ui-shell-header-kicker">Control Plane</div>
              <div className="ui-shell-header-title">{activeNav}</div>
            </div>
          </div>
          <div className="ui-shell-header-actions">
            
          </div>
        </header>
        <section className={rightPane ? "ui-shell-content-with-pane" : "ui-shell-content"}>
          <div className="ui-shell-left-pane">{leftPane}</div>
          {rightPane ? (
            <ScrollArea className="ui-shell-right-scroll">
              <div className="ui-shell-right-pane">{rightPane}</div>
            </ScrollArea>
          ) : null}
        </section>
      </main>
      <GovernanceNotificationCenter companyId={activeCompanyId} />
    </div>
  );
}
