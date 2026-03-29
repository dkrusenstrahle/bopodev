"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import packageJson from "../../../../package.json";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";
import {
  Activity,
  BarChart3,
  Clock3,
  BriefcaseBusiness,
  Inbox,
  FolderKanban,
  GitBranch,
  LayoutDashboard,
  Map,
  Target,
  Users,
  Settings,
  Puzzle,
  LayoutTemplate,
  Menu,
  MessageCircle,
  Plus,
  Repeat,
  BookOpen
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
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet";
import { CreateCompanyModal } from "@/components/modals/create-company-modal";

const navGroups: Array<{
  label: string;
  items: Array<{
    slug: SectionSlug;
    label: SectionLabel;
    icon: React.ComponentType<{ className?: string }>;
    href?: string;
  }>;
}> = [
  {
    label: "Work",
    items: [
      { slug: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { slug: "projects", label: "Projects", icon: BriefcaseBusiness },
      { slug: "issues", label: "Issues", icon: FolderKanban },
      { slug: "loops", label: "Loops", icon: Repeat },
      { slug: "agents", label: "Agents", icon: Users }
    ]
  },
  {
    label: "Operations",
    items: [
      { slug: "inbox", label: "Inbox", icon: Inbox },
      { slug: "chat", label: "Chat", icon: MessageCircle },
      { slug: "runs", label: "Runs", icon: Clock3 },
      { slug: "trace-logs", label: "Logs", icon: Activity }
    ]
  },
  {
    label: "Company",
    items: [
      { slug: "goals", label: "Goals", icon: Target },
      { slug: "org-chart", label: "Organization", icon: GitBranch },
      { slug: "office-space", label: "Office", icon: Map },
      { slug: "costs", label: "Costs", icon: BarChart3 },
      { slug: "settings", label: "Settings", icon: Settings, href: "/settings" }
    ]
  }
];

const settingsNavItems: Array<{
  href: string;
  label: SectionLabel;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (pathname: string) => boolean;
}> = [
  { href: "/settings/templates", label: "Templates", icon: LayoutTemplate, isActive: (pathname) => pathname.startsWith("/settings/templates") },
  { href: "/settings/plugins", label: "Plugins", icon: Puzzle, isActive: (pathname) => pathname.startsWith("/settings/plugins") },
  { href: "/settings/skills", label: "Skills", icon: BookOpen, isActive: (pathname) => pathname.startsWith("/settings/skills") },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    isActive: (pathname) => pathname === "/settings" || pathname.startsWith("/settings/settings")
  }
];

const appVersion = packageJson.version;

export function AppShell({
  leftPane,
  rightPane,
  secondaryPane,
  activeNav,
  companies,
  activeCompanyId,
  pendingApprovalsCount,
  hideSidebar = false,
  leftPaneScrollable = true,
  singleScroll = false
}: {
  leftPane: ReactNode;
  rightPane?: ReactNode;
  secondaryPane?: ReactNode;
  activeNav: SectionLabel;
  companies: Array<{ id: string; name: string }>;
  activeCompanyId: string | null;
  pendingApprovalsCount?: number;
  hideSidebar?: boolean;
  leftPaneScrollable?: boolean;
  singleScroll?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pendingApprovalsCountFromApi, setPendingApprovalsCountFromApi] = useState<number | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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
    void apiGet<{ actorId: string; items: Array<{ category: string; state: string }> }>("/attention", activeCompanyId)
      .then((result) => {
        if (!cancelled) {
          const count = result.data.items.filter(
            (item) => item.category === "approval_required" && (item.state === "open" || item.state === "acknowledged")
          ).length;
          setPendingApprovalsCountFromApi(Math.max(0, count));
        }
      })
      .catch(() => {
        void apiGet<{ count: number }>("/governance/approvals/pending-count", activeCompanyId)
          .then((fallback) => {
            if (!cancelled) {
              setPendingApprovalsCountFromApi(Math.max(0, Math.floor(Number(fallback.data.count) || 0)));
            }
          })
          .catch(() => {
            if (!cancelled) {
              setPendingApprovalsCountFromApi(null);
            }
          });
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, pendingApprovalsCount]);

  const resolvedPendingApprovalsCount =
    typeof pendingApprovalsCount === "number" ? pendingApprovalsCount : pendingApprovalsCountFromApi;
  const isSettingsRoute = pathname.startsWith("/settings");
  const resolvedSecondaryPane =
    secondaryPane ??
    (isSettingsRoute ? (
      <div className="flex h-full min-h-0 flex-col">
        <ScrollArea className="ui-shell-secondary-scroll min-h-0 flex-1">
          <div className="ui-shell-sidebar-scroll-content">{renderSettingsLinks(false)}</div>
        </ScrollArea>
      </div>
    ) : undefined);

  function updateCompany(companyId: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("companyId", companyId);
    next.delete("issueId");
    const issueDetail = pathname.match(/^\/issues\/[^/]+$/);
    const projectDetail = pathname.match(/^\/projects\/[^/]+$/);
    const loopDetail = pathname.match(/^\/loops\/[^/]+$/);
    const basePath = issueDetail ? "/issues" : projectDetail ? "/projects" : loopDetail ? "/loops" : pathname;
    const href = `${basePath}?${next.toString()}` as Parameters<typeof router.replace>[0];
    router.replace(href);
  }

  function renderNavLinks(closeOnNavigate: boolean) {
    return (
      <div className="ui-shell-nav-groups">
        {navGroups.map((group) => (
          <div key={group.label} className="ui-shell-stack-sm">
            <div className="ui-shell-group-label">{group.label}</div>
            <nav className="ui-shell-nav">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.slug === "settings" && isSettingsRoute ? true : activeNav === item.label;
                const showPendingApprovalsBadge =
                  item.slug === "inbox" &&
                  typeof resolvedPendingApprovalsCount === "number" &&
                  resolvedPendingApprovalsCount > 0;
                const navLink = (
                  <Link
                    key={item.slug}
                    prefetch={false}
                    href={
                      activeCompanyId
                        ? { pathname: (item.href ?? (`/${item.slug}` as Route)), query: { companyId: activeCompanyId } }
                        : ({ pathname: (item.href ?? (`/${item.slug}` as Route)) } as const)
                    }
                    onClick={closeOnNavigate ? () => setMobileNavOpen(false) : undefined}
                    className={cn("ui-shell-nav-link ui-mobile-touch-target", isActive ? "ui-shell-nav-link-active" : "ui-shell-nav-link-inactive")}
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

                if (closeOnNavigate) {
                  return (
                    <SheetClose asChild key={item.slug}>
                      {navLink}
                    </SheetClose>
                  );
                }

                return navLink;
              })}
            </nav>
          </div>
        ))}
      </div>
    );
  }

  function renderSettingsLinks(closeOnNavigate: boolean) {
    if (!isSettingsRoute) {
      return null;
    }

    return (
      <div className="ui-shell-nav-groups">
        <div className="ui-shell-stack-sm">
          <div className="ui-shell-group-label">Settings</div>
          <nav className="ui-shell-nav">
            {settingsNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = item.isActive(pathname);
              const settingsLink = (
                <Link
                  key={item.href}
                  prefetch={false}
                  href={
                    activeCompanyId
                      ? { pathname: item.href as Route, query: { companyId: activeCompanyId } }
                      : ({ pathname: item.href as Route } as const)
                  }
                  onClick={closeOnNavigate ? () => setMobileNavOpen(false) : undefined}
                  className={cn("ui-shell-nav-link ui-mobile-touch-target", isActive ? "ui-shell-nav-link-active" : "ui-shell-nav-link-inactive")}
                >
                  <Icon className="ui-shell-nav-icon" />
                  <span className="ui-shell-nav-label">{item.label}</span>
                </Link>
              );

              if (closeOnNavigate) {
                return (
                  <SheetClose asChild key={item.href}>
                    {settingsLink}
                  </SheetClose>
                );
              }

              return settingsLink;
            })}
          </nav>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        hideSidebar ? "ui-shell-root-no-sidebar" : "ui-shell-root",
        singleScroll ? "ui-shell-root-single-scroll" : null
      )}
    >
      {!hideSidebar ? (
        <aside className="ui-shell-sidebar">
          <div className="ui-shell-sidebar-inner">
            <div className="ui-shell-sidebar-top">
              <div className="ui-shell-stack-sm">
                <div className="ui-shell-company-header">
                  <div className="ui-shell-section-label">Company</div>
                  <CreateCompanyModal
                    companyId={activeCompanyId ?? "bootstrap-company"}
                    onCreated={updateCompany}
                    trigger={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className="ui-shell-company-create-button"
                        aria-label="Create company">
                        <Plus />
                      </Button>
                    }
                  />
                </div>
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
                {renderNavLinks(false)}
              </div>
            </ScrollArea>
            <div className="ui-shell-sidebar-footer">
              <ThemeToggle />
              <div className="ui-shell-version">{`v${appVersion}`}</div>
            </div>
          </div>
        </aside>
      ) : null}
      {resolvedSecondaryPane ? (
        <aside className="ui-shell-secondary-sidebar">
          <div className="ui-shell-secondary-pane">{resolvedSecondaryPane}</div>
        </aside>
      ) : null}
      <main
        className={cn(
          "ui-shell-main",
          resolvedSecondaryPane ? "ui-shell-main-with-secondary" : "",
          singleScroll ? "ui-shell-main-single-scroll" : null
        )}
      >
        <header className="ui-shell-header">
          <div className="ui-shell-header-left">
            {!hideSidebar ? (
              <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="icon-sm" aria-label="Open navigation">
                    <Menu />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="ui-shell-mobile-nav-content">
                  <SheetHeader>
                    <SheetTitle>
                      {companies.find((company) => company.id === activeCompanyId)?.name ?? "BopoDev"}
                    </SheetTitle>
                    <SheetDescription>Navigate the control plane.</SheetDescription>
                  </SheetHeader>
                  <div className="ui-shell-stack-sm mt-4">
                    <div className="ui-shell-company-header">
                      <div className="ui-shell-section-label">Company</div>
                      <CreateCompanyModal
                        companyId={activeCompanyId ?? "bootstrap-company"}
                        onCreated={updateCompany}
                        trigger={
                          <Button
                            variant="outline"
                            size="icon-xs"
                            className="ui-shell-company-create-button"
                            aria-label="Create company">
                            <Plus />
                          </Button>
                        }
                      />
                    </div>
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
                  <ScrollArea className="ui-shell-mobile-nav-scroll">
                    <div className="ui-shell-nav-groups">
                      {renderNavLinks(true)}
                      {renderSettingsLinks(true)}
                    </div>
                  </ScrollArea>
                  <div className="ui-shell-mobile-nav-footer ui-mobile-safe-bottom">
                    <ThemeToggle />
                  </div>
                </SheetContent>
              </Sheet>
            ) : null}
            <div className="ui-shell-row">
              <div>
                <div className="ui-shell-header-kicker">Control Plane</div>
                <div className="ui-shell-header-title">{activeNav}</div>
              </div>
            </div>
          </div>
          <div className="ui-shell-header-actions">
          </div>
        </header>
        <section
          className={cn(
            rightPane ? "ui-shell-content-with-pane" : "ui-shell-content",
            singleScroll ? "ui-shell-content-single-scroll" : null
          )}
        >
          <div
            className={cn(
              leftPaneScrollable ? "ui-shell-left-pane" : "ui-shell-left-pane-static",
              singleScroll ? "ui-shell-left-pane-single-scroll" : null
            )}
          >
            {leftPane}
          </div>
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
