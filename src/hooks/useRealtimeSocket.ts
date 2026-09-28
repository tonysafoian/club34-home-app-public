import { useEffect, useRef, useState, useCallback } from "react";
import { acquireBackendSocket, releaseBackendSocket, type Socket } from "@/lib/api/backendSocket";

export function useRealtimeSocket() {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = acquireBackendSocket();
    socketRef.current = socket;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = (err: Error) => {
      console.error("[WS] Connection error:", err.message);
      setConnected(false);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    if (socket.connected) setConnected(true);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      releaseBackendSocket();
    };
  }, []);

  const on = useCallback(
    (event: string, handler: (...args: unknown[]) => void) => {
      const socket = socketRef.current;
      if (!socket) return () => {};
      socket.on(event, handler);
      return () => {
        socket.off(event, handler);
      };
    },
    []
  );

  return { socket: socketRef.current, connected, on };
}

export function useSocketEvent(
  event: string,
  handler: (data: unknown) => void
) {
  const { on } = useRealtimeSocket();

  useEffect(() => {
    return on(event, handler);
  }, [event, handler, on]);
}
