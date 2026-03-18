import type { RealtimeEventEnvelope, RealtimeMessage } from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import { listBoardAttentionItems } from "../services/attention-service";
import type { RealtimeHub } from "./hub";

const DEFAULT_ACTOR_ID = "local-board";

export async function loadAttentionRealtimeSnapshot(
  db: BopoDb,
  companyId: string
): Promise<Extract<RealtimeMessage, { kind: "event" }>> {
  const items = await listBoardAttentionItems(db, companyId, DEFAULT_ACTOR_ID);
  return createAttentionRealtimeEvent(companyId, {
    type: "attention.snapshot",
    items
  });
}

export function createAttentionRealtimeEvent(
  companyId: string,
  event: Extract<RealtimeEventEnvelope, { channel: "attention" }>["event"]
): Extract<RealtimeMessage, { kind: "event" }> {
  return {
    kind: "event",
    companyId,
    channel: "attention",
    event
  };
}

export async function publishAttentionSnapshot(
  db: BopoDb,
  realtimeHub: RealtimeHub | undefined,
  companyId: string,
  actorId = DEFAULT_ACTOR_ID
) {
  if (!realtimeHub) {
    return;
  }
  const items = await listBoardAttentionItems(db, companyId, actorId);
  realtimeHub.publish(
    createAttentionRealtimeEvent(companyId, {
      type: "attention.snapshot",
      items
    })
  );
}
