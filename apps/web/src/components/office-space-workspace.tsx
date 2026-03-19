"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { OfficeOccupant, OfficeRoom } from "bopodev-contracts";
import { AppShell } from "@/components/app-shell";
import { AgentAvatar } from "@/components/agent-avatar";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { subscribeToRealtime } from "@/lib/realtime";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { cn } from "@/lib/utils";
import type { WorkspacePageProps } from "@/components/workspace/workspace-page-props";
import styles from "./office-space-workspace.module.scss";
import { SectionHeading } from "./workspace/shared";

const roomDefinitions: Array<{
  id: OfficeRoom;
  title: string;
}> = [
  {
    id: "waiting_room",
    title: "Lounge"
  },
  {
    id: "security",
    title: "Approvals"
  },
  {
    id: "work_space",
    title: "Workspace"
  }
];

export function OfficeSpaceWorkspace({
  companyId,
  companies
}: Pick<WorkspacePageProps, "companyId" | "companies">) {
  const [occupants, setOccupants] = useState<OfficeOccupant[]>([]);
  const [selectedOccupantId, setSelectedOccupantId] = useState<string | null>(null);
  const [openPopoverOccupantId, setOpenPopoverOccupantId] = useState<string | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);

  useEffect(() => {
    if (!companyId) {
      setOccupants([]);
      setHasSnapshot(false);
      return;
    }

    setOccupants([]);
    setHasSnapshot(false);

    return subscribeToRealtime({
      companyId,
      channels: ["office-space"],
      onMessage: (message) => {
        if (message.kind !== "event" || message.channel !== "office-space") {
          return;
        }

        const officeEvent = message.event;

        switch (officeEvent.type) {
          case "office.snapshot":
            setHasSnapshot(true);
            setOccupants(sortOccupants(officeEvent.occupants));
            return;
          case "office.occupant.updated":
            setOccupants((current) =>
              sortOccupants([officeEvent.occupant, ...current.filter((occupant) => occupant.id !== officeEvent.occupant.id)])
            );
            return;
          case "office.occupant.left":
            setOccupants((current) => current.filter((occupant) => occupant.id !== officeEvent.occupantId));
            return;
        }
      }
    });
  }, [companyId]);

  useEffect(() => {
    if (occupants.length === 0) {
      setSelectedOccupantId(null);
      setOpenPopoverOccupantId(null);
      return;
    }

    if (!selectedOccupantId || !occupants.some((occupant) => occupant.id === selectedOccupantId)) {
      setSelectedOccupantId(occupants[0]?.id ?? null);
    }
  }, [occupants, selectedOccupantId]);

  useEffect(() => {
    if (!openPopoverOccupantId) {
      return;
    }
    if (!occupants.some((occupant) => occupant.id === openPopoverOccupantId)) {
      setOpenPopoverOccupantId(null);
    }
  }, [occupants, openPopoverOccupantId]);

  const leftPane = !companyId ? (
    <EmptyOfficeState />
  ) : (
    <OfficeSpaceCanvas
      occupants={occupants}
      selectedOccupantId={selectedOccupantId}
      openPopoverOccupantId={openPopoverOccupantId}
      hasSnapshot={hasSnapshot}
      onSelectOccupant={setSelectedOccupantId}
      onOpenPopoverChange={setOpenPopoverOccupantId}
    />
  );

  return (
    <AppShell
      leftPane={leftPane}
      rightPane={null}
      activeNav="Office"
      companies={companies}
      activeCompanyId={companyId}
      leftPaneScrollable={false}
    />
  );
}

function OfficeSpaceCanvas({
  occupants,
  selectedOccupantId,
  openPopoverOccupantId,
  hasSnapshot,
  onSelectOccupant,
  onOpenPopoverChange
}: {
  occupants: OfficeOccupant[];
  selectedOccupantId: string | null;
  openPopoverOccupantId: string | null;
  hasSnapshot: boolean;
  onSelectOccupant: (occupantId: string) => void;
  onOpenPopoverChange: (occupantId: string | null) => void;
}) {
  const occupantsByRoom = useMemo(
    () =>
      new Map(
        roomDefinitions.map((room) => [
          room.id,
          occupants.filter((occupant) => occupant.room === room.id)
        ])
      ),
    [occupants]
  );

  return (
    <div className={styles.sceneShell}>
      <div className={styles.sceneHeader}>
        <SectionHeading
              title="Office"
              description="Real-time view of the company's office space."
            />
      </div>

      <div className="md:hidden space-y-4">
        <Accordion type="multiple" className="rounded-lg border bg-card px-3">
          {roomDefinitions.map((room) => {
            const roomOccupants = occupantsByRoom.get(room.id) ?? [];
            return (
              <AccordionItem key={`mobile-${room.id}`} value={room.id}>
                <AccordionTrigger>
                  <span className="flex w-full items-center justify-between gap-3 pr-2">
                    <span>{room.title}</span>
                    <Badge variant="outline">{roomOccupants.length}</Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  {roomOccupants.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No agents currently in this room.</p>
                  ) : (
                    <div className="space-y-2">
                      {roomOccupants.map((occupant) => (
                        <Popover
                          key={occupant.id}
                          open={openPopoverOccupantId === occupant.id}
                          onOpenChange={(open) => {
                            onOpenPopoverChange(open ? occupant.id : null);
                            if (open) {
                              onSelectOccupant(occupant.id);
                            }
                          }}
                        >
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              className="w-full justify-start gap-3 h-auto py-2"
                              onClick={() => onSelectOccupant(occupant.id)}
                            >
                              <AgentAvatar
                                seed={agentAvatarSeed(occupant.id, occupant.displayName, occupant.avatarSeed)}
                                name={occupant.displayName}
                                className={styles.avatarBadge}
                                size={64}
                              />
                              <span className="min-w-0 flex-1 text-left">
                                <span className="block truncate">{occupant.displayName}</span>
                                <span className="block text-base text-muted-foreground">
                                  {occupant.status === "working" ? occupant.taskLabel : occupant.status}
                                </span>
                              </span>
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className={styles.occupantPopover}>
                            <OfficeOccupantPopoverBody occupant={occupant} />
                          </PopoverContent>
                        </Popover>
                      ))}
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </div>

      <div className={cn(styles.sceneSurface, "hidden md:block")}>
        <div className={styles.sceneGrid}>
          {roomDefinitions.map((room) => {
            const roomOccupants = occupantsByRoom.get(room.id) ?? [];
            return (
              <Card
                key={room.id}
                className={cn(
                  styles[`roomArea${toPascalCase(room.id)}`]
                )}>
                  <CardHeader>
                    <CardTitle>{room.title}</CardTitle>
                    <CardDescription>
                      {room.id === "work_space"
                        ? `There are ${roomOccupants.length} agents working`
                        : room.id === "security"
                          ? `There are ${roomOccupants.length} agents waiting for approvals`
                          : `There are ${roomOccupants.length} agents waiting for work`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className={styles.roomFloor}>
                      {roomOccupants.map((occupant, index) => (
                        <Popover
                          key={occupant.id}
                          open={openPopoverOccupantId === occupant.id}
                          onOpenChange={(open) => {
                            onOpenPopoverChange(open ? occupant.id : null);
                            if (open) {
                              onSelectOccupant(occupant.id);
                            }
                          }}
                        >
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              style={getRoomOccupantStyle(room.id, index, roomOccupants.length)}
                              className={cn(
                                styles.occupantToken,
                                styles[`occupantToken${toPascalCase(occupant.status)}`],
                                selectedOccupantId === occupant.id ? styles.occupantTokenSelected : null
                              )}
                              onClick={() => onSelectOccupant(occupant.id)}
                            >
                              <AgentAvatar
                                seed={agentAvatarSeed(occupant.id, occupant.displayName, occupant.avatarSeed)}
                                name={occupant.displayName}
                                className={styles.avatarBadge}
                                size={96}
                              />
                              <span className={styles.occupantName}>{occupant.displayName}</span>
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className={styles.occupantPopover}>
                            <OfficeOccupantPopoverBody occupant={occupant} />
                          </PopoverContent>
                        </Popover>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
          })}

          {!hasSnapshot ? (
            <div className={styles.loadingOverlay}>
              <Card className={styles.loadingCard}>
                <CardHeader>
                  <CardTitle>Connecting office feed</CardTitle>
                  <CardDescription>Waiting for the office-space snapshot from the realtime channel.</CardDescription>
                </CardHeader>
              </Card>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EmptyOfficeState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Select a company first</CardTitle>
        <CardDescription>The office view needs an active company before it can subscribe to realtime presence updates.</CardDescription>
      </CardHeader>
    </Card>
  );
}

function OfficeOccupantPopoverBody({ occupant }: { occupant: OfficeOccupant }) {
  return (
    <div className={styles.occupantPopoverBody}>
      <div className={styles.occupantPopoverSection}>
        <div className={styles.occupantPopoverSectionLabel}>Current work</div>
        <p className={styles.occupantPopoverSectionText}>{occupant.taskLabel}</p>
      </div>
    </div>
  );
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.metricChip}>
      <span className={styles.metricChipLabel}>{label}</span>
      <span className={styles.metricChipValue}>{value}</span>
    </div>
  );
}

function sortOccupants(occupants: OfficeOccupant[]) {
  const roomOrder: Record<OfficeRoom, number> = {
    waiting_room: 0,
    work_space: 1,
    security: 2
  };

  return [...occupants].sort((a, b) => {
    const roomComparison = roomOrder[a.room] - roomOrder[b.room];
    if (roomComparison !== 0) {
      return roomComparison;
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

function toPascalCase(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function getRoomOccupantStyle(roomId: OfficeRoom, index: number, total: number): CSSProperties {
  if (total <= 0) {
    return {};
  }

  // Slightly denser packing in workspace because the room is wider.
  const roomDensity = roomId === "work_space" ? 1.1 : 0.9;
  const maxRingRadius = 40 * roomDensity;
  const radialStep = maxRingRadius / Math.max(Math.sqrt(total), 1);
  const angle = index * 2.399963229728653; // golden angle in radians
  const radius = Math.sqrt(index + 0.5) * radialStep;

  const leftPercent = clamp(50 + Math.cos(angle) * radius, 12, 88);
  const topPercent = clamp(50 + Math.sin(angle) * radius * 0.86, 24, 80);

  // Scale down tokens as rooms get more crowded so all agents stay inside.
  const scale = clamp(1.08 - total * 0.032, 0.58, 1);

  return {
    left: `${leftPercent}%`,
    top: `${topPercent}%`,
    transform: `translate(-50%, -50%) scale(${scale})`
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

