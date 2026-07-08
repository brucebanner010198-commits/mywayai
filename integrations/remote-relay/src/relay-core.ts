// A small, from-scratch implementation of the collab relay wire contract
// documented in vendor/oh-my-pi/docs/collab.md and demonstrated (for local
// dev only) by vendor/oh-my-pi/packages/collab-web/scripts/local-relay.ts.
//
// This is NOT an import of that vendored script: `@oh-my-pi/collab-web` is
// `"private": true` and unpublished, so integrations/ cannot depend on it at
// runtime the way it depends on `@oh-my-pi/pi-coding-agent` (see
// docs/architecture.md "Extension vs. bridge duplication" for the same
// constraint applied to omp-omniroute-extension). This file re-implements
// the documented contract deliberately, with one addition the vendored
// reference does not have: a per-room guest cap (docs/adr/0002-remote-control.md
// R1, docs/remote-control-threat-model.md T6).
//
// Every frame this relay forwards is opaque, AES-256-GCM-sealed bytes from
// the client's perspective (vendor/oh-my-pi/packages/collab-web/src/lib/codec.ts).
// This relay never parses, decrypts, or logs frame payloads — only the
// 4-byte plaintext routing prefix each envelope carries
// (vendor/oh-my-pi/packages/wire/src/index.ts `ENVELOPE_HEADER_LENGTH`).

const ROOM_PATH_PATTERN = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;

interface RelaySocketData {
  roomId: string;
  role: "host" | "guest";
  /** Assigned on open for guests; the host stays 0. */
  peerId: number;
}

type RelaySocket = Bun.ServerWebSocket<RelaySocketData>;

interface Room {
  host: RelaySocket;
  guests: Map<number, RelaySocket>;
  nextPeerId: number;
}

export interface RelayOptions {
  port: number;
  bind: string;
  /** Guests beyond this count per room are rejected with close code 4029 ("room is full"). */
  maxGuestsPerRoom: number;
}

export interface RunningRelay {
  readonly url: string;
  readonly port: number;
  /** Closes every live room and stops the HTTP/WS server. Idempotent. */
  stop(): void;
}

/**
 * Reads the plaintext peerId prefix from a binary envelope
 * (`[4B uint32 BE peerId][sealed payload]`). Returns `undefined` for a
 * malformed/too-short frame so callers can drop it instead of throwing.
 */
function readEnvelopePeerId(data: Uint8Array): number | undefined {
  if (data.byteLength < ENVELOPE_HEADER_LENGTH) return undefined;
  return new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
}

/** Overwrites the peerId prefix in place, leaving the sealed payload untouched. */
function rewriteEnvelopePeerId(data: Uint8Array, peerId: number): void {
  new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

function handleGuestOpen(ws: RelaySocket, room: Room | undefined, maxGuestsPerRoom: number): void {
  if (!room) {
    ws.close(4004, "no such room");
    return;
  }
  if (room.guests.size >= maxGuestsPerRoom) {
    ws.close(4029, "room is full");
    return;
  }
  const peerId = room.nextPeerId++;
  ws.data.peerId = peerId;
  room.guests.set(peerId, ws);
  room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
}

function forwardHostMessage(room: Room, message: Uint8Array): void {
  const peerId = readEnvelopePeerId(message);
  if (peerId === undefined) return;
  if (peerId === 0) {
    for (const guest of room.guests.values()) guest.send(message);
    return;
  }
  room.guests.get(peerId)?.send(message);
}

function forwardGuestMessage(room: Room, ws: RelaySocket, message: Uint8Array): void {
  if (message.byteLength < ENVELOPE_HEADER_LENGTH) return;
  rewriteEnvelopePeerId(message, ws.data.peerId);
  room.host.send(message);
}

function closeRoom(room: Room, reason: string, guestCode: number): void {
  const closure = JSON.stringify({ t: "room-closed" });
  for (const guest of room.guests.values()) {
    guest.send(closure);
    guest.close(guestCode, reason);
  }
  room.guests.clear();
}

/** Boots the relay and returns a handle to stop it. Never throws on a normal bind. */
export function createRelay(opts: RelayOptions): RunningRelay {
  const rooms = new Map<string, Room>();

  const server = Bun.serve<RelaySocketData>({
    port: opts.port,
    hostname: opts.bind,
    fetch(req, srv): Response | undefined {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response(JSON.stringify({ status: "ok", rooms: rooms.size }), {
          headers: { "content-type": "application/json" },
        });
      }
      const match = ROOM_PATH_PATTERN.exec(url.pathname);
      const role = url.searchParams.get("role");
      if (!match || (role !== "host" && role !== "guest")) {
        return new Response("not found", { status: 404 });
      }
      const data: RelaySocketData = { roomId: match[1]!, role, peerId: 0 };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response("websocket upgrade required", { status: 426 });
    },
    websocket: {
      open(ws: RelaySocket): void {
        const { roomId, role } = ws.data;
        if (role === "host") {
          if (rooms.has(roomId)) {
            ws.close(4009, "a host is already connected for this room");
            return;
          }
          rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
          return;
        }
        handleGuestOpen(ws, rooms.get(roomId), opts.maxGuestsPerRoom);
      },
      message(ws: RelaySocket, message: string | Buffer): void {
        if (typeof message === "string") return; // clients never send TEXT
        const room = rooms.get(ws.data.roomId);
        if (!room) return;
        if (ws.data.role === "host") {
          forwardHostMessage(room, message);
          return;
        }
        forwardGuestMessage(room, ws, message);
      },
      close(ws: RelaySocket): void {
        const { roomId, role, peerId } = ws.data;
        const room = rooms.get(roomId);
        if (!room) return;
        if (role === "host") {
          if (room.host !== ws) return; // a rejected second host tearing down is not ours to garbage-collect
          rooms.delete(roomId);
          closeRoom(room, "room closed", 4001);
          return;
        }
        if (room.guests.delete(peerId)) {
          room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
        }
      },
    },
  });

  const port = server.port ?? opts.port;
  return {
    url: `ws://${opts.bind}:${port}`,
    port,
    stop(): void {
      for (const room of rooms.values()) {
        closeRoom(room, "relay shutting down", 4001);
        room.host.close(1001, "relay shutting down");
      }
      rooms.clear();
      server.stop(true);
    },
  };
}
