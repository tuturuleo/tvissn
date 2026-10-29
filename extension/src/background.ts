import { FollowMode } from "./follow";
import { ServiceRouter } from "./routes";
const router = new ServiceRouter();
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connectionServer = "";
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
  bestRtt = Infinity,
  ping: number | null = null;
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
let clockTimer: ReturnType<typeof setInterval> | undefined;
let widgetPrefs: Record<string, unknown> = {};
const follow = new FollowMode({
  hasPermission: (origin) =>
    chrome.permissions.contains({ origins: [origin + "/*"] }),
  navigate: async (tabId, url) => {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && samePage(tab.url, url)) {
      queueMicrotask(() => follow.complete(tabId, url));
      return;
    }
    await Promise.allSettled(
      [...new Set([...candidates.values()].map((c) => c.frameId))].map(
        (frameId) =>
          chrome.tabs.sendMessage(tabId, { type: "TVISSN_STOP" }, { frameId }),
      ),
    );
    candidates.clear();
    selectedPlayer = null;
    await chrome.tabs.update(tabId, { url });
  },
  notify: (message) => {
    error = message;
    updateBadge();
  },
  changed: () => {
    void saveWatch();
    void deliver();
  },
});
async function saveWatch() {
  await chrome.storage.local.set({
    watch: { enabled, tabId: targetTab, autoFollow: follow.enabled },
  });
}
const init = (async () => {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const stored = await chrome.storage.local.get<{
    session?: ExtensionSession;
    watch?: { tabId: number | null; enabled: boolean; autoFollow?: boolean };
    widgetPrefs?: Record<string, unknown>;
  }>(["session", "watch", "widgetPrefs"]);
  widgetPrefs = stored.widgetPrefs || {};
  session = stored.session || null;
  if (stored.watch) {
    targetTab = stored.watch.tabId;
    enabled = stored.watch.enabled;
    follow.configure(!!stored.watch.autoFollow, targetTab);
  }
  if (enabled && session) await restore();
})();
function updateBadge() {
  void chrome.action.setBadgeText({
    text: follow.pendingGrant ? "!" : enabled ? (connected ? "ON" : "…") : "",
  });
  void chrome.action.setBadgeBackgroundColor({
    color: connected ? "#476a58" : "#595052",
  });
}
function state() {
  return {
    session: session
      ? { id: session.id, name: session.name, server: session.server }
      : null,
    connected,
    connectionServer,
    enabled,
    targetTab,
    snapshot,
    ping,
    error,
    candidates: [...candidates.values()],
    selectedPlayer,
    autoFollow: follow.enabled,
    pendingNavigation: follow.pendingGrant,
    installedVersion: chrome.runtime.getManifest().version,
  };
}
function reconnect(s: Socket) {
  if (socket !== s || !session) return;
  router.next(session.server);
  s.removeAllListeners();
  s.disconnect();
  socket = null;
  connected = false;
  ping = null;
  clearInterval(clockTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 1000);
}
function connect() {
  if (!session || socket) return;
  clearTimeout(reconnectTimer);
  connectionServer = router.current(session.server);
  const endpoint = connectionServer;
  const s = io(endpoint, {
    transports: ["websocket"],
    auth: { token: session.token },
    reconnection: false,
    timeout: 10000,
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
        ping = rtt;
        if (rtt < bestRtt + 20) {
          bestRtt = Math.min(rtt, bestRtt);
          clockOffset = r.serverTime - (start + rtt / 2);
        }
      },
    );
  };
  s.on("connect", () => {
    if (session) router.prefer(session.server, endpoint);
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
    if (enabled)
      void follow.update(
        next.playback.externalUrl,
        next.playback.mediaRevision,
      );
    void deliver();
  });
  s.on("disconnect", (reason) => {
    connected = false;
    ping = null;
    updateBadge();
    void deliver();
    if (reason === "io server disconnect") {
      error = "Сессия завершена. Войдите снова.";
      session = null;
      void chrome.storage.local.remove("session");
      socket = null;
      clearInterval(clockTimer);
    } else reconnect(s);
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
      clearInterval(clockTimer);
    } else reconnect(s);
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
          players: all.map((p) => ({ id: p.id, title: p.title })),
          selectedPlayer,
          autoFollow: follow.enabled,
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
    (await chrome.storage.local.get<{server?: string}>("server")).server ||
    DEFAULT_SERVER;
  const { response: r, server: downloadServer } = await router.fetch(server, "/api/extension/latest");
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
      downloadServer +
      "/extension/tvissn-extension.zip?v=" +
      encodeURIComponent(data.version),
  };
}
async function stop() {
  clearTimeout(reconnectTimer);
  enabled = false;
  follow.configure(false, null);
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  connected = false;
  ping = null;
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
    if (message.type === "TVISSN_PREFS_GET") {
      reply({ ok: true, result: widgetPrefs });
      return;
    }
    if (message.type === "TVISSN_PREFS_SET") {
      const next = message.prefs || {};
      const clean: Record<string, unknown> = {};
      for (const key of ["normal", "fullscreen"]) {
        const p = next[key];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y))
          clean[key] = {
            x: Math.max(0, Math.min(1, p.x)),
            y: Math.max(0, Math.min(1, p.y)),
          };
      }
      if (Number.isFinite(next.volume))
        clean.volume = Math.max(0, Math.min(1, next.volume));
      if (typeof next.muted === "boolean") clean.muted = next.muted;
      if (typeof next.folded === "boolean") clean.folded = next.folded;
      widgetPrefs = { ...widgetPrefs, ...clean };
      void chrome.storage.local.set({ widgetPrefs });
      reply({ ok: true });
      return;
    }
    if (message.type === "TVISSN_RESCAN_REQUEST") {
      void rescan().then(() => reply({ ok: true }));
      return true;
    }
    if (message.type === "TVISSN_SELECT_PLAYER") {
      selectedPlayer =
        typeof message.playerId === "string" ? message.playerId : null;
      void deliver();
      reply({ ok: true });
      return;
    }
    if (message.type === "TVISSN_DISCONNECT") {
      void stop().then(() => reply({ ok: true }));
      return true;
    }
    if (message.type === "TVISSN_FOLLOW") {
      setFollow(!!message.enabled);
      reply({ ok: true });
      return;
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
      if (message.type === "INVITE") {
        if (!session) throw new Error("Сначала войдите.");
        const { response: r } = await router.fetch(session.server, "/api/extension/invite", {
          method: "POST",
          headers: { Authorization: "Bearer " + session.token },
        });
        const data = await r.json();
        if (!r.ok)
          throw new Error(data.error || "Не удалось создать приглашение.");
        const url = new URL("tvissn://join");
        url.searchParams.set("server", session.server);
        url.searchParams.set("invite", data.code);
        return { invitation: url.toString(), expiresAt: data.expiresAt };
      }
      if (message.type === "FOLLOW") {
        setFollow(!!message.enabled);
        return state();
      }
      if (message.type === "NAVIGATE") {
        await follow.retry();
        return state();
      }
      if (message.type === "LOGIN") {
        const server = serverOrigin(message.server || DEFAULT_SERVER);
        const { response: res } = await router.fetch(server, "/api/extension/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: message.name, code: message.code }),
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
        follow.configure(follow.enabled, targetTab);
        await saveWatch();
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
        await rescan();
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
function setFollow(value: boolean) {
  error = "";
  follow.configure(value, targetTab);
  if (value && snapshot)
    void follow.update(
      snapshot.playback.externalUrl,
      snapshot.playback.mediaRevision,
    );
  updateBadge();
}
async function rescan() {
  if (targetTab === null) throw new Error("Сначала подключите вкладку.");
  candidates.clear();
  selectedPlayer = null;
  await inject(targetTab);
  void chrome.tabs
    .sendMessage(targetTab, { type: "TVISSN_RESCAN" })
    .catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!enabled || tabId !== targetTab) return;
  if (change.url) follow.onUrl(tabId, change.url);
  if (change.status === "complete") {
    if (tab.url) follow.complete(tabId, tab.url);
    void init.then(() => inject(tabId));
  }
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
      clearTimeout(reconnectTimer);
      socket?.removeAllListeners();
      socket?.disconnect();
      socket = null;
      connected = false;
      clearInterval(clockTimer);
    }
  });
});
