import { io, Socket } from "socket.io-client";

let sharedSocket: Socket | null = null;
let refCount = 0;

// Production frontend is served by Cloudflare Pages at example.com, but CF
// Pages can't proxy WebSocket upgrades — so the socket has to connect
// directly to the Replit backend origin. Anywhere else (dev, Replit's own
// preview domains, localhost) we use same-origin so the socket goes
// through the same server as REST.
function getSocketTarget(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window.location.hostname;
  if (host === "example.com" || host === "www.example.com") {
    return "wss://club34.replit.app";
  }
  return undefined;
}

// auth_token is HttpOnly so it can't be read by JS, and a cross-origin
// WebSocket handshake won't send it anyway. setStoredToken() mirrors the
// JWT into localStorage so we can re-send it in socket.io's `auth` payload.
// server/socket.ts reads handshake.auth.token first, falls back to the
// cookie for same-origin requests.
function readAuthToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return localStorage.getItem("auth_token") || undefined;
}

function createSocket(): Socket {
  const target = getSocketTarget();
  const opts = {
    path: "/ws",
    withCredentials: true,
    transports: ["websocket", "polling"] as ("websocket" | "polling")[],
    auth: { token: readAuthToken() },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    autoConnect: false,
  };
  const socket = target ? io(target, opts) : io(opts);
  // Re-read the token before every reconnect so a token written after the
  // socket was constructed (e.g. login completed in a different tab) is
  // picked up without recreating the connection.
  socket.io.on("reconnect_attempt", () => {
    socket.auth = { token: readAuthToken() };
  });
  return socket;
}

export function acquireBackendSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = createSocket();
  }
  refCount++;
  sharedSocket.auth = { token: readAuthToken() };
  if (!sharedSocket.connected) {
    sharedSocket.connect();
  }
  return sharedSocket;
}

export function releaseBackendSocket(): void {
  refCount--;
  if (refCount <= 0) {
    refCount = 0;
    if (sharedSocket) {
      sharedSocket.disconnect();
      sharedSocket = null;
    }
  }
}

export type { Socket };
