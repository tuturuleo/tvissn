import { io, type Socket } from "socket.io-client";
import {
  DEFAULT_SERVER,
  serverOrigin,
  samePage,
  type ExtensionSession,
} from "./shared";
import type { Snapshot } from "../../server/protocol";

let session: ExtensionSession | null = null,
  socket: Socket | null = null,
  snapshot: Snapshot | null = null;
let targetTab: number | null = null,
  selectedPlayer: string | null = null,
  enabled = false,
  connected = false,
  error = "",
  clockOffset = 0,
  bestRtt = Infinity;
let candidates = new Map<
  string,
  {
    id: string;
    videoKey: string;
    frameId: number;
    area: number;
    duration: number;
    url: string;
    title: string;
    seenAt: number;
  }
>();
let pending: Promise<void> | null = null,
  clockTimer: ReturnType<typeof setInterval> | undefined;
const init = (async () => {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const stored = await chrome.storage.local.get<{
    session?: ExtensionSession;
    watch?: { tabId: number | null; enabled: boolean };
  }>(["session", "watch"]);
  session = stored.session || null;
  if (stored.watch) {
    targetTab = stored.watch.tabId;
    enabled = stored.watch.enabled;
  }
  if (enabled && session) await restore();
})();
function updateBadge() {
  void chrome.action.setBadgeText({
    text: enabled ? (connected ? "ON" : "…") : "",
  });
  void chrome.action.setBadgeBackgroundColor({
    color: connected ? "#476a58" : "#595052",
  });
}
function state() {
  return {
    session: session ? { name: session.name, server: session.server } : null,
    connected,
    enabled,
    targetTab,
    snapshot,
    error,
    candidates: [...candidates.values()],
    selectedPlayer,
    installedVersion: chrome.runtime.getManifest().version,
  };
}
function connect() {
  if (!session || socket) return;
  const s = io(session.server, {
    transports: ["websocket"],
    auth: { token: session.token },
    reconnection: true,
    reconnectionDelayMax: 10000,
  });
  socket = s;
  const sample = () => {
    const start = Date.now();
    s.timeout(5000).emit(
      "clock",
      {},
      (e: Error | null, r: { serverTime: number }) => {
        if (e || !r) return;
        const rtt = Date.now() - start;
        if (rtt < bestRtt + 20) {
          bestRtt = Math.min(rtt, bestRtt);
          clockOffset = r.serverTime - (start + rtt / 2);
        }
      },
    );
  };
  s.on("connect", () => {
    connected = true;
    error = "";
    bestRtt = Infinity;
    sample();
    s.emit("sync");
    updateBadge();
  });
  s.on("snapshot", (next: Snapshot) => {
    if (
      snapshot &&
      snapshot.epoch === next.epoch &&
      snapshot.playback.revision > next.playback.revision
    )
      return;
    snapshot = next;
    void deliver();
  });
  s.on("disconnect", (reason) => {
    connected = false;
    updateBadge();
    void deliver();
    if (reason === "io server disconnect") {
      error = "Сессия завершена. Войдите снова.";
      session = null;
      void chrome.storage.local.remove("session");
    }
  });
  s.on("connect_error", (e) => {
    connected = false;
    error =
      e.message === "SESSION_EXPIRED"
        ? "Сессия истекла. Войдите снова."
        : "Не удалось соединиться с сервисом. Повторяем подключение…";
    if (e.message === "SESSION_EXPIRED") {
      session = null;
      void chrome.storage.local.remove("session");
      s.disconnect();
      socket = null;
    }
    updateBadge();
    void deliver();
  });
  clockTimer = setInterval(sample, 20000);
}
async function restore() {
  if (!session || session.exp < Date.now()) {
    session = null;
    enabled = false;
    await chrome.storage.local.remove("session");
    return;
  }
  if (targetTab !== null) {
    try {
      await chrome.tabs.get(targetTab);
    } catch {
      targetTab = null;
      enabled = false;
    }
  }
  if (enabled) {
    connect();
    if (targetTab !== null) await inject(targetTab);
  }
}
async function inject(tabId: number) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
    void chrome.tabs
      .sendMessage(tabId, { type: "TVISSN_RESUME" })
      .catch(() => {});
  } catch {
    error =
      "Не удалось подключить плеер. Разрешите доступ к сайту и обновите страницу.";
  }
}
async function deliver() {
  if (!enabled || targetTab === null || !snapshot) return;
  for (const [key, c] of candidates)
    if (Date.now() - c.seenAt > 6000) candidates.delete(key);
  const all = [...candidates.values()].filter(
    (c) =>
      snapshot?.playback.externalUrl &&
      samePage(c.url, snapshot.playback.externalUrl),
  );
  const primary =
    all.find((c) => c.id === selectedPlayer) ||
    all.sort((a, b) => b.area - a.area)[0];
  for (const frameId of new Set([...candidates.values()].map((c) => c.frameId)))
    void chrome.tabs
      .sendMessage(
        targetTab,
        {
          type: "TVISSN_STATE",
          snapshot,
          connected,
          serverTime: Date.now() + clockOffset,
          primary: frameId === primary?.frameId,
          videoKey: primary?.videoKey,
        },
        { frameId },
      )
      .catch(() => {});
}
async function sendCommand(command: Record<string, unknown>) {
  if (!socket?.connected) throw new Error("Нет соединения с комнатой.");
  return new Promise<void>((resolve, reject) =>
    socket!.timeout(10000).emit(
      "command",
      {
        ...command,
        commandId: crypto.randomUUID(),
        ...(["load", "loadExternal"].includes(String(command.type))
          ? {}
          : { mediaRevision: snapshot?.playback.mediaRevision }),
      },
      (e: Error | null, result: { ok: boolean; error?: string }) => {
        if (e) reject(new Error("Нет подтверждения от сервера."));
        else if (!result?.ok)
          reject(new Error(result?.error || "Действие отклонено."));
        else resolve();
      },
    ),
  );
}
async function checkUpdate() {
  const server =
    session?.server ||
    (await chrome.storage.local.get("server")).server ||
    DEFAULT_SERVER;
  const r = await fetch(server + "/api/extension/latest", {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("Не удалось проверить обновления.");
  const data = await r.json();
  if (
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(data.version) ||
    data.extensionId !== chrome.runtime.id
  )
    throw new Error("Сервис вернул несовместимое обновление.");
  return {
    ...data,
    downloadUrl:
      server +
      "/extension/tvissn-extension.zip?v=" +
      encodeURIComponent(data.version),
  };
}
async function stop() {
  enabled = false;
  socket?.disconnect();
  socket = null;
  connected = false;
  clearInterval(clockTimer);
  if (targetTab !== null)
    for (const c of candidates.values())
      void chrome.tabs
        .sendMessage(targetTab, { type: "TVISSN_STOP" }, { frameId: c.frameId })
        .catch(() => {});
  candidates.clear();
  selectedPlayer = null;
  targetTab = null;
  await chrome.storage.local.set({ watch: { enabled: false, tabId: null } });
  updateBadge();
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (sender.tab) {
    if (!enabled || sender.tab.id !== targetTab) return;
    if (
      message.type === "TVISSN_CANDIDATE" &&
      typeof sender.frameId === "number"
    ) {
      if (!Array.isArray(message.candidates)) return;
      for (const [key, c] of candidates)
        if (c.frameId === sender.frameId) candidates.delete(key);
      for (const m of message.candidates.slice(0, 20)) {
        if (
          typeof m.area !== "number" ||
          !Number.isFinite(m.area) ||
          typeof m.videoKey !== "string"
        )
          continue;
        const id = sender.frameId + ":" + m.videoKey;
        candidates.set(id, {
          id,
          videoKey: m.videoKey,
          frameId: sender.frameId,
          area: Math.max(0, Math.min(m.area, 1e8)),
          duration: Number(m.duration) || 0,
          url: sender.tab.url || "",
          title: String(m.title || "Плеер").slice(0, 100),
          seenAt: Date.now(),
        });
      }
      void deliver();
      reply({ ok: true });
      return;
    }
    if (message.type === "TVISSN_INTENT") {
      const primary = [...candidates.values()].filter(
        (c) =>
          snapshot?.playback.externalUrl &&
          samePage(c.url, snapshot.playback.externalUrl),
      );
      const chosen =
        primary.find((c) => c.id === selectedPlayer) ||
        primary.sort((a, b) => b.area - a.area)[0];
      if (sender.frameId !== chosen?.frameId) return;
      void init
        .then(() => sendCommand(message.command))
        .then(() => reply({ ok: true }))
        .catch((e) => reply({ ok: false, error: e.message }));
      return true;
    }
    if (message.type === "TVISSN_STATUS") {
      socket?.emit("status", message.status);
      reply({ ok: true });
      return;
    }
    return;
  }
  // Privileged operations are only available to packaged extension pages, never webpage senders.
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  void init
    .then(async () => {
      if (message.type === "STATE") return state();
      if (message.type === "UPDATE") return checkUpdate();
      if (message.type === "LOGIN") {
        const server = serverOrigin(message.server || DEFAULT_SERVER);
        const res = await fetch(server + "/api/extension/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: message.name, code: message.code }),
          signal: AbortSignal.timeout(20000),
        });
        const data = await res.json();
        if (!res.ok)
          throw new Error(
            res.status === 429
              ? "Слишком много попыток. Подождите минуту."
              : data.error || "Не удалось войти.",
          );
        await stop();
        session = {
          server,
          token: data.token,
          name: data.name,
          id: data.id,
          exp: data.exp,
        };
        await chrome.storage.local.set({ session, server });
        connect();
        return state();
      }
      if (message.type === "ATTACH") {
        if (!session) throw new Error("Сначала войдите по коду.");
        const tab = await chrome.tabs.get(message.tabId);
        if (
          !tab.url ||
          !/^https?:/.test(tab.url) ||
          tab.url.startsWith(session.server)
        )
          throw new Error("Откройте вкладку внешнего сайта с видео.");
        if (targetTab !== null && targetTab !== tab.id)
          for (const c of candidates.values())
            void chrome.tabs
              .sendMessage(
                targetTab,
                { type: "TVISSN_STOP" },
                { frameId: c.frameId },
              )
              .catch(() => {});
        targetTab = tab.id!;
        enabled = true;
        selectedPlayer = null;
        candidates.clear();
        await chrome.storage.local.set({
          watch: { enabled: true, tabId: targetTab },
        });
        connect();
        if (!connected)
          throw new Error(
            "Соединяемся с комнатой. Нажмите подключение ещё раз через несколько секунд.",
          );
        if (
          !snapshot?.playback.externalUrl ||
          !samePage(tab.url, snapshot.playback.externalUrl)
        )
          await sendCommand({ type: "loadExternal", url: tab.url });
        await inject(targetTab);
        updateBadge();
        return state();
      }
      if (message.type === "PLAYER") {
        selectedPlayer =
          typeof message.playerId === "string" ? message.playerId : null;
        await deliver();
        return state();
      }
      if (message.type === "RESCAN") {
        if (targetTab === null) throw new Error("Сначала подключите вкладку.");
        candidates.clear();
        selectedPlayer = null;
        await inject(targetTab);
        void chrome.tabs
          .sendMessage(targetTab, { type: "TVISSN_RESCAN" })
          .catch(() => {});
        return state();
      }
      if (message.type === "COMMAND") {
        await sendCommand(message.command);
        return state();
      }
      if (message.type === "STOP") {
        await stop();
        return state();
      }
      if (message.type === "LOGOUT") {
        await stop();
        session = null;
        await chrome.storage.local.remove("session");
        return state();
      }
      if (message.type === "IFRAMES") {
        const results = await chrome.scripting.executeScript({
          target: { tabId: message.tabId },
          func: () =>
            [...document.querySelectorAll("iframe")]
              .map((f) => {
                try {
                  return new URL(f.src).origin + "/*";
                } catch {
                  return "";
                }
              })
              .filter(
                (s) => s.startsWith("https://") || s.startsWith("http://"),
              ),
        });
        return {
          origins: [...new Set(results.flatMap((r) => r.result || []))],
        };
      }
      throw new Error("Неизвестное действие.");
    })
    .then((result) => reply({ ok: true, result }))
    .catch((e) =>
      reply({
        ok: false,
        error: e instanceof Error ? e.message : "Ошибка расширения.",
      }),
    );
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (enabled && tabId === targetTab && change.status === "complete")
    void init.then(() => inject(tabId));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === targetTab) void stop();
});
chrome.runtime.onStartup.addListener(() => {
  void init;
});
chrome.runtime.onInstalled.addListener(() => {
  void init;
});
chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== "popup" ||
    (port.sender?.url && !port.sender.url.startsWith(chrome.runtime.getURL("")))
  )
    return;
  void init.then(() => {
    if (session) connect();
  });
  port.onDisconnect.addListener(() => {
    if (!enabled) {
      socket?.disconnect();
      socket = null;
      connected = false;
      clearInterval(clockTimer);
    }
  });
});
