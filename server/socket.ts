import type { Server as HttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import { verifyToken } from "./auth";

let io: SocketServer | null = null;

function getAllowedOrigins(): string[] | true {
  if (process.env.NODE_ENV === "production" && process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  }
  return true;
}

export function setupSocketIO(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    path: "/ws",
    cors: {
      origin: getAllowedOrigins(),
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      parseCookie(socket.handshake.headers.cookie || "", "auth_token");

    if (!token) {
      return next(new Error("Authentication required"));
    }

    const user = verifyToken(token);
    if (!user) {
      return next(new Error("Invalid or expired token"));
    }

    if (user.approvalStatus !== "approved") {
      return next(new Error("Account not approved"));
    }

    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.userId}`);
    console.log(`[WS] Connected: ${user.email} (${socket.id})`);

    socket.on("disconnect", (reason) => {
      console.log(`[WS] Disconnected: ${user.email} (${reason})`);
    });
  });

  return io;
}

export function getIO(): SocketServer {
  if (!io) {
    throw new Error("Socket.io not initialized — call setupSocketIO first");
  }
  return io;
}

export function emitToAll(event: string, data?: unknown): void {
  if (!io) return;
  io.emit(event, data);
}

export function emitToUser(userId: string, event: string, data?: unknown): void {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

function parseCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? match.split("=")[1] : undefined;
}
