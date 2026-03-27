/**
 * Read-only decode of the Bopo actor token payload for UI labels (not verified; never for auth).
 * Token shape: base64url(JSON).signature (see apps/api security actor-token).
 */

type ActorPayloadV1 = {
  v: 1;
  actorType?: string;
  actorId?: string;
};

function decodeBase64UrlSegment(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const pad = trimmed.length % 4 === 0 ? "" : "=".repeat(4 - (trimmed.length % 4));
    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/") + pad;
    if (typeof atob !== "function") {
      return null;
    }
    return atob(b64);
  } catch {
    return null;
  }
}

function parseActorPayload(rawToken: string): ActorPayloadV1 | null {
  const [payloadPart] = rawToken.split(".");
  if (!payloadPart) {
    return null;
  }
  const json = decodeBase64UrlSegment(payloadPart);
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as ActorPayloadV1;
  } catch {
    return null;
  }
}

function displayNameFromActor(actorType: string | undefined, actorId: string | undefined): string {
  const id = actorId?.trim() || "";
  const type = actorType?.trim().toLowerCase() || "";

  if (type === "board") {
    return "Board";
  }
  if (type === "agent") {
    return id ? `Agent · ${id.length > 12 ? `${id.slice(0, 8)}…` : id}` : "Agent";
  }
  if (id.includes("@")) {
    const local = id.split("@")[0]?.trim();
    if (local) {
      return local;
    }
  }
  if (id && id.length <= 32 && !/^[a-f0-9-]{20,}$/i.test(id)) {
    return id;
  }
  return "You";
}

export function readActorTokenFromBrowser(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem("bopo.actorToken")?.trim() || "";
}

/** Seed for avatars; stable per actor id + type. */
export function getViewerChatProfile(): { displayName: string; avatarSeed: string; actorType: string } {
  const fromEnv =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_BOPO_ACTOR_TOKEN?.trim() ?? "" : "";
  const raw = typeof window !== "undefined" ? readActorTokenFromBrowser() || fromEnv : fromEnv;
  if (!raw) {
    return { displayName: "You", avatarSeed: "viewer:you", actorType: "member" };
  }
  const payload = parseActorPayload(raw);
  const actorType = payload?.actorType ?? "member";
  const actorId = payload?.actorId ?? "unknown";
  const displayName = displayNameFromActor(actorType, actorId);
  return {
    displayName,
    avatarSeed: `${actorType}:${actorId}`,
    actorType
  };
}
