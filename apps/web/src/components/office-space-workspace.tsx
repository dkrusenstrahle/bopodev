"use client";

import { useEffect, useMemo, useState } from "react";
import type { OfficeOccupant, OfficeRoom } from "bopodev-contracts";
import { AppShell } from "@/components/app-shell";
import { AgentAvatar } from "@/components/agent-avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { subscribeToRealtime } from "@/lib/realtime";
import { agentAvatarSeed } from "@/lib/agent-avatar";
import { cn } from "@/lib/utils";
import type { WorkspacePageProps } from "@/components/workspace/workspace-page-props";
import styles from "./office-space-workspace.module.scss";
import { SectionHeading } from "./workspace/shared";

const roomDefinitions: Array<{
  id: OfficeRoom;
  title: string;
  columns: number;
}> = [
  {
    id: "waiting_room",
    title: "Waiting Room",
    columns: 2
  },
  {
    id: "security",
    title: "Security",
    columns: 2
  },
  {
    id: "work_space",
    title: "Work Space",
    columns: 5
  }
];

export function OfficeSpaceWorkspace({
  companyId,
  companies
}: Pick<WorkspacePageProps, "companyId" | "companies">) {
  const [occupants, setOccupants] = useState<OfficeOccupant[]>([]);
  const [selectedOccupantId, setSelectedOccupantId] = useState<string | null>(null);
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
      return;
    }

    if (!selectedOccupantId || !occupants.some((occupant) => occupant.id === selectedOccupantId)) {
      setSelectedOccupantId(occupants[0]?.id ?? null);
    }
  }, [occupants, selectedOccupantId]);

  const leftPane = !companyId ? (
    <EmptyOfficeState />
  ) : (
    <OfficeSpaceCanvas
      occupants={occupants}
      selectedOccupantId={selectedOccupantId}
      hasSnapshot={hasSnapshot}
      onSelectOccupant={setSelectedOccupantId}
    />
  );

  return (
    <AppShell
      leftPane={leftPane}
      rightPane={null}
      activeNav="Office"
      companies={companies}
      activeCompanyId={companyId}
    />
  );
}

function OfficeSpaceCanvas({
  occupants,
  selectedOccupantId,
  hasSnapshot,
  onSelectOccupant
}: {
  occupants: OfficeOccupant[];
  selectedOccupantId: string | null;
  hasSnapshot: boolean;
  onSelectOccupant: (occupantId: string) => void;
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

      <div className={styles.sceneSurface}>
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
                    <CardDescription>{roomOccupants.length} occupants</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div
                      className={cn(
                        styles.roomFloor,
                        room.columns === 2 ? styles.roomFloorCompact : styles.roomFloorWide
                      )}
                    >
                      {roomOccupants.map((occupant) => (
                        <button
                          key={occupant.id}
                          type="button"
                          className={cn(
                            styles.occupantToken,
                            styles[`occupantToken${toPascalCase(occupant.status)}`],
                            selectedOccupantId === occupant.id ? styles.occupantTokenSelected : null
                          )}
                          onClick={() => onSelectOccupant(occupant.id)}
                        >
                          {occupant.status === "working" && occupant.taskLabel ? (
                            <span className={styles.taskLabel}>{occupant.taskLabel}</span>
                          ) : null}
                          <AgentAvatar
                            seed={agentAvatarSeed(occupant.id, occupant.displayName, occupant.avatarSeed)}
                            name={occupant.displayName}
                            className={styles.avatarBadge}
                            size={96}
                          />
                          <span className={styles.occupantName}>{occupant.displayName}</span>
                        </button>
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

