import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Command, Snapshot } from "../../server/protocol";

export function useRoom(onExpired: () => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [ping, setPing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const socket = useRef<Socket | null>(null);
  const offset = useRef(0);
  const bestRtt = useRef(Infinity);
  const latest = useRef<Snapshot | null>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    const s = io({
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      withCredentials: true,
    });
    socket.current = s;
    const sample = () => {
      const start = Date.now();
      s.timeout(5000).emit(
        "clock",
        {},
        (err: Error | null, res: { serverTime: number }) => {
          if (err || !res) return;
          const rtt = Date.now() - start;
          setPing(rtt);
          if (rtt < bestRtt.current + 20) {
            bestRtt.current = Math.min(rtt, bestRtt.current);
            offset.current = res.serverTime - (start + rtt / 2);
          }
        },
      );
    };
    s.on("connect", () => {
      setConnected(true);
      setError("");
      bestRtt.current = Infinity;
      sample();
      s.emit("sync");
    });
    s.on("disconnect", (reason) => {
      setConnected(false);
      if (reason === "io server disconnect") expired.current();
    });
    s.on("connect_error", (e) => {
      setConnected(false);
      if (e.message === "SESSION_EXPIRED") expired.current();
      else setError("Соединение прервано. Подключаемся снова…");
    });
    s.on("snapshot", (next: Snapshot) => {
      const prev = latest.current;
      if (
        prev &&
        prev.epoch === next.epoch &&
        prev.playback.revision > next.playback.revision
      )
        return;
      latest.current = next;
      setSnapshot(next);
    });
    const timer = setInterval(sample, 10000);
    const visible = () => {
      if (document.visibilityState === "visible") {
        sample();
        s.emit("sync");
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      s.disconnect();
      socket.current = null;
    };
  }, []);
  const command = useCallback(
    (
      partial:
        | Omit<Extract<Command, { type: "load" }>, "commandId">
        | {
            type: "play" | "pause" | "seek" | "rate" | "ended";
            position?: number;
            rate?: number;
          },
    ) => {
      const s = socket.current;
      if (!s?.connected) {
        setError("Нет соединения с комнатой. Дождитесь подключения.");
        return;
      }
      setError("");
      const payload = {
        ...partial,
        commandId: crypto.randomUUID(),
        ...(partial.type !== "load"
          ? { mediaRevision: latest.current?.playback.mediaRevision }
          : {}),
      };
      s.timeout(10000).emit(
        "command",
        payload,
        (err: Error | null, res: { ok: boolean; error?: string }) => {
          if (err) setError("Не получили подтверждение. Обновляем состояние…");
          else if (!res.ok)
            setError(res.error || "Не удалось выполнить действие.");
          if (err || !res?.ok) s.emit("sync");
        },
      );
    },
    [],
  );
  const report = useCallback((status: string) => {
    socket.current?.emit("status", status);
  }, []);
  const resync = useCallback(() => socket.current?.emit("sync"), []);
  return {
    snapshot,
    connected,
    ping,
    error,
    setError,
    command,
    report,
    resync,
    serverNow: () => Date.now() + offset.current,
  };
}
