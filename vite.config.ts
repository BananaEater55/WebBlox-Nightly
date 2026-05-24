import { defineConfig, type Plugin } from "vite";
import path from "path";

const rawPort = process.env.PORT;
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

const basePath = process.env.BASE_PATH;
if (!basePath) throw new Error("BASE_PATH environment variable is required but was not provided.");

interface RoomState {
  owner: any | null;
  members: Set<any>;
  playerIndexOf: Map<any, number>;
  nextIndex: number;
  gameUrl: string | null;
  gameName: string | null;
}

function wsRelayPlugin(): Plugin {
  return {
    name: "ws-relay",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        import("ws").then(({ WebSocketServer }) => {
          const rooms = new Map<string, RoomState>();
          const wss = new WebSocketServer({ noServer: true });

          function getRoom(id: string): RoomState {
            if (!rooms.has(id)) {
              rooms.set(id, {
                owner: null,
                members: new Set(),
                playerIndexOf: new Map(),
                nextIndex: 1,
                gameUrl: null,
                gameName: null,
              });
            }
            return rooms.get(id)!;
          }

          function send(ws: any, obj: object) {
            try { ws.send(JSON.stringify(obj)); } catch (_) {}
          }

          function broadcast(room: RoomState, obj: object, exclude?: any) {
            const text = JSON.stringify(obj);
            room.members.forEach((c: any) => {
              if (c !== exclude && c.readyState === 1) {
                try { c.send(text); } catch (_) {}
              }
            });
          }

          wss.on("connection", (ws: any, req: any) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            const roomId = url.searchParams.get("room") ?? "default";
            const room = getRoom(roomId);

            // Assign player index
            const playerIndex = room.nextIndex++;
            room.members.add(ws);
            room.playerIndexOf.set(ws, playerIndex);

            // First member becomes owner
            const isOwner = room.owner === null;
            if (isOwner) room.owner = ws;

            // Tell the new client their role and player index
            send(ws, {
              type: "role",
              isOwner,
              playerIndex,
              playerName: "Player" + playerIndex,
              gameUrl: room.gameUrl,
              gameName: room.gameName,
              players: room.members.size,
            });

            // Tell existing members the updated count
            broadcast(room, { type: "players", count: room.members.size }, ws);

            ws.on("message", (data: any, isBinary: boolean) => {
              if (!isBinary) {
                // Control message — only owner sends game-select/start controls
                try {
                  const msg = JSON.parse(data.toString());
                  if (msg.type === "select" && ws === room.owner) {
                    room.gameUrl  = msg.url  ?? null;
                    room.gameName = msg.name ?? null;
                    broadcast(room, { type: "select", url: room.gameUrl, name: room.gameName });
                  } else if (msg.type === "start" && ws === room.owner) {
                    broadcast(room, { type: "start", url: room.gameUrl, name: room.gameName });
                  }
                  // Non-control JSON (game engine may send JSON too) — relay to all peers
                  else if (!["select","start"].includes(msg.type)) {
                    const text = data.toString();
                    room.members.forEach((c: any) => {
                      if (c !== ws && c.readyState === 1) {
                        try { c.send(text); } catch (_) {}
                      }
                    });
                  }
                } catch (_) {
                  // Not JSON — relay as text
                  room.members.forEach((c: any) => {
                    if (c !== ws && c.readyState === 1) {
                      try { c.send(data); } catch (_) {}
                    }
                  });
                }
              } else {
                // Binary game-engine packets — relay to all peers
                room.members.forEach((c: any) => {
                  if (c !== ws && c.readyState === 1) {
                    try { c.send(data, { binary: true }); } catch (_) {}
                  }
                });
              }
            });

            ws.on("close", () => {
              room.playerIndexOf.delete(ws);
              room.members.delete(ws);

              if (room.members.size === 0) {
                rooms.delete(roomId);
                return;
              }

              if (ws === room.owner) {
                room.owner = room.members.values().next().value;
                const newIdx = room.playerIndexOf.get(room.owner) ?? 1;
                send(room.owner, {
                  type: "promoted",
                  playerIndex: newIdx,
                  playerName: "Player" + newIdx,
                });
              }

              broadcast(room, { type: "players", count: room.members.size });
            });
          });

          server.httpServer?.on("upgrade", (req: any, socket: any, head: any) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            if (url.pathname === "/_ws") {
              wss.handleUpgrade(req, socket, head, (ws: any) => {
                wss.emit("connection", ws, req);
              });
            }
          });
        });
      });
    },
  };
}

export default defineConfig({
  base: basePath,
  root: path.resolve(import.meta.dirname),
  plugins: [wsRelayPlugin()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
