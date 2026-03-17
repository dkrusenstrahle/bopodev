import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Minus, Plus, ScanSearch } from "lucide-react";
import { Tree, TreeNode } from "react-organizational-chart";
import styles from "./org-chart.module.scss";

interface AgentNode {
  id: string;
  name: string;
  avatarSeed?: string | null;
  role: string;
  managerAgentId: string | null;
  status: string;
  providerType: string;
}

interface OrgNode {
  agent: AgentNode;
  reports: OrgNode[];
}

interface OrgForestBuildResult {
  roots: OrgNode[];
  orphanCount: number;
  cycleCount: number;
}
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 1.5;

function byAgentName(a: AgentNode, b: AgentNode) {
  const nameCmp = a.name.localeCompare(b.name);
  if (nameCmp !== 0) {
    return nameCmp;
  }
  return a.id.localeCompare(b.id);
}

function buildOrgForest(agents: AgentNode[]): OrgForestBuildResult {
  if (agents.length === 0) {
    return {
      roots: [],
      orphanCount: 0,
      cycleCount: 0
    };
  }

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenByManager = new Map<string | null, AgentNode[]>();
  let orphanCount = 0;

  for (const agent of agents) {
    if (agent.managerAgentId && !agentsById.has(agent.managerAgentId)) {
      orphanCount += 1;
    }
    const key = agent.managerAgentId;
    const current = childrenByManager.get(key) ?? [];
    current.push(agent);
    childrenByManager.set(key, current);
  }

  for (const values of childrenByManager.values()) {
    values.sort(byAgentName);
  }

  const rootAgents = agents
    .filter((agent) => !agent.managerAgentId || !agentsById.has(agent.managerAgentId))
    .sort(byAgentName);

  const visited = new Set<string>();
  let cycleCount = 0;

  function buildNode(agent: AgentNode, chain: Set<string>): OrgNode {
    if (chain.has(agent.id)) {
      cycleCount += 1;
      return { agent, reports: [] };
    }
    visited.add(agent.id);
    const nextChain = new Set(chain);
    nextChain.add(agent.id);
    const directReports = childrenByManager.get(agent.id) ?? [];
    return {
      agent,
      reports: directReports.flatMap((report) => {
        if (nextChain.has(report.id)) {
          cycleCount += 1;
          return [];
        }
        return [buildNode(report, nextChain)];
      })
    };
  }

  const roots = rootAgents.map((root) => buildNode(root, new Set()));
  const detached: OrgNode[] = [];
  const remainingAgents = [...agents].sort(byAgentName);
  for (const agent of remainingAgents) {
    if (visited.has(agent.id)) {
      continue;
    }
    detached.push(buildNode(agent, new Set()));
  }

  return {
    roots: roots.concat(detached),
    orphanCount,
    cycleCount
  };
}

function formatRole(role: string) {
  return role.replaceAll("_", " ");
}

export function OrgChart({
  agents,
  onAgentSelect
}: {
  agents: AgentNode[];
  onAgentSelect?: (agentId: string) => void;
}) {
  const { roots, orphanCount, cycleCount } = useMemo(() => buildOrgForest(agents), [agents]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const lineColor = "var(--border)";
  const panStartRef = useRef({
    x: 0,
    y: 0,
    panX: 0,
    panY: 0
  });

  function renderAgentCard(agent: AgentNode): ReactNode {
    const clickable = typeof onAgentSelect === "function";
    const cardContent = (
      <div className={styles.orgCard}>
        <div className={styles.orgCardHeader}>
          <AgentAvatar
            seed={agentAvatarSeed(agent.id, agent.name, agent.avatarSeed)}
            name={agent.name}
            className={styles.orgCardAvatar}
            size={96}
          />
          <div className={styles.orgCardText}>
            <div className={styles.orgCardName}>{agent.name}</div>
            <div className={styles.orgCardMeta}>{formatRole(agent.role)}</div>
          </div>
        </div>
      </div>
    );
    if (!clickable) {
      return cardContent;
    }
    return (
      <button
        type="button"
        className={styles.orgCardButton}
        onClick={() => onAgentSelect(agent.id)}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={`Open ${agent.name}`}
      >
        {cardContent}
      </button>
    );
  }

  function renderBranch(node: OrgNode): ReactNode {
    return (
      <TreeNode key={node.agent.id} label={renderAgentCard(node.agent)}>
        {node.reports.map((report) => renderBranch(report))}
      </TreeNode>
    );
  }

  function renderMobileBranch(node: OrgNode): ReactNode {
    return (
      <AccordionItem key={node.agent.id} value={node.agent.id}>
        <div className={styles.mobileAgentHeader}>
          <AccordionTrigger className={styles.mobileAccordionTrigger}>
            <span className="flex items-center gap-2 min-w-0">
              <AgentAvatar
                seed={agentAvatarSeed(node.agent.id, node.agent.name, node.agent.avatarSeed)}
                name={node.agent.name}
                className="size-6 rounded-full"
                size={24}
              />
              <span className="truncate text-left">{node.agent.name}</span>
            </span>
          </AccordionTrigger>
          {onAgentSelect ? (
            <Button type="button" size="sm" variant="ghost" className={styles.mobileOpenButton} onClick={() => onAgentSelect(node.agent.id)}>
              Open
            </Button>
          ) : null}
        </div>
        <AccordionContent>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{formatRole(node.agent.role)}</Badge>
              <Badge variant="outline">{node.agent.providerType}</Badge>
              <Badge variant="outline">{node.agent.status}</Badge>
            </div>
            {node.reports.length > 0 ? (
              <Accordion type="multiple" className="pl-2 border-l">
                {node.reports.map((report) => renderMobileBranch(report))}
              </Accordion>
            ) : (
              <p className="text-xs text-muted-foreground">No direct reports.</p>
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    );
  }

  function zoomBy(factor: number) {
    setZoom((current) => Math.min(Math.max(current * factor, MIN_ZOOM), MAX_ZOOM));
  }

  const startPan = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    setIsPanning(true);
    panStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y
    };
    event.preventDefault();
  }, [pan.x, pan.y]);

  const continuePan = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isPanning) {
        return;
      }
      const deltaX = event.clientX - panStartRef.current.x;
      const deltaY = event.clientY - panStartRef.current.y;
      setPan({
        x: panStartRef.current.panX + deltaX,
        y: panStartRef.current.panY + deltaY
      });
      event.preventDefault();
    },
    [isPanning]
  );

  const stopPan = useCallback(() => {
    setIsPanning(false);
  }, []);

  return (
    <>
      {roots.length === 0 ? (
        <div className={styles.emptyState}>No agents yet. Create a CEO or lead role first.</div>
      ) : (
        <>
          <div className="md:hidden space-y-3">
            {(orphanCount > 0 || cycleCount > 0) && (
              <div className={styles.warningBanner} role="status" aria-live="polite">
                {orphanCount > 0 ? `${orphanCount} orphaned reporting link${orphanCount > 1 ? "s" : ""} shown as root.` : null}
                {orphanCount > 0 && cycleCount > 0 ? " " : null}
                {cycleCount > 0 ? `${cycleCount} cyclical relationship${cycleCount > 1 ? "s" : ""} ignored.` : null}
              </div>
            )}
            <Accordion type="multiple" className="rounded-lg border px-3">
              {roots.map((root) => renderMobileBranch(root))}
            </Accordion>
          </div>
          <div className="hidden md:block">
            <div className={styles.viewport}>
              {(orphanCount > 0 || cycleCount > 0) && (
                <div className={styles.warningBanner} role="status" aria-live="polite">
                  {orphanCount > 0 ? `${orphanCount} orphaned reporting link${orphanCount > 1 ? "s" : ""} shown as root.` : null}
                  {orphanCount > 0 && cycleCount > 0 ? " " : null}
                  {cycleCount > 0 ? `${cycleCount} cyclical relationship${cycleCount > 1 ? "s" : ""} ignored.` : null}
                </div>
              )}
              <div className={styles.controls}>
                <Button type="button" variant="outline" size="icon-sm" className={styles.controlButton} onClick={() => zoomBy(1.1)} aria-label="Zoom in">
                  <Plus />
                </Button>
                <Button type="button" variant="outline" size="icon-sm" className={styles.controlButton} onClick={() => zoomBy(0.9)} aria-label="Zoom out">
                  <Minus />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={styles.controlButtonFit}
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  <ScanSearch />
                  Reset
                </Button>
              </div>
              <div
                className={styles.treeScroller}
                data-panning={isPanning ? "true" : "false"}
                onMouseDown={startPan}
                onMouseMove={continuePan}
                onMouseUp={stopPan}
                onMouseLeave={stopPan}
              >
                <div className={styles.chartLayer} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
                  <div className={styles.forest}>
                    {roots.map((root) => (
                      <div key={root.agent.id} className={styles.treeContainer}>
                        <Tree
                          lineHeight="30px"
                          lineWidth="1px"
                          lineColor={lineColor}
                          lineBorderRadius="8px"
                          nodePadding="14px"
                          label={renderAgentCard(root.agent)}
                        >
                          {root.reports.map((report) => renderBranch(report))}
                        </Tree>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
