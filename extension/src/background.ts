import { FollowMode } from "./follow";
import { isNewer, samePage } from "./shared";
import type { Snapshot } from "../../shared/protocol";

let session: {id:string;name:string} | null = null,
  snapshot: Snapshot | null = null;
let targetTab: number | null = null,
  selectedPlayer: string | null = null,
  enabled = false,
  connected = false,
  error = "",
  clockOffset = 0,
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
let peerState: any = {phase:"idle",connected:false,code:""};
let creating: Promise<void> | undefined;
async function ensurePeer() {
  if(await chrome.offscreen.hasDocument()) return;
  if(!creating) creating=chrome.offscreen.createDocument({url:"offscreen.html",reasons:[chrome.offscreen.Reason.WEB_RTC],justification:"Keep a direct WebRTC data connection alive while popup is closed and tabs navigate."}).finally(()=>{creating=undefined;});
  await creating;
}
async function peerRequest(type:string,data:Record<string,unknown>={}) {
  await ensurePeer();
  const r=await chrome.runtime.sendMessage({target:"peer",type,...data});
  if(!r?.ok)throw new Error(r?.error||"Фоновое P2P-соединение не ответило.");
  return r.result;
}
function acceptPeer(next:any) {
  peerState=next;session=next.person?{id:next.person.id,name:next.person.name}:null;
  connected=!!next.connected;snapshot=next.snapshot;ping=next.ping;clockOffset=next.clockOffset||0;error=next.error||"";
  updateBadge();if(connected&&enabled&&snapshot)void follow.update(snapshot.playback.externalUrl,snapshot.playback.mediaRevision);void deliver();
}
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
  await chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"});
  const stored=await chrome.storage.local.get<{watch?:{tabId:number|null;enabled:boolean;autoFollow?:boolean};widgetPrefs?:Record<string,unknown>}>(["watch","widgetPrefs"]);
  widgetPrefs=stored.widgetPrefs||{};
  if(stored.watch){targetTab=stored.watch.tabId;enabled=!!stored.watch.enabled;follow.configure(!!stored.watch.autoFollow,targetTab);}
  await chrome.storage.local.remove(["session","server"]);
  acceptPeer(await peerRequest("STATE"));
  if(targetTab!==null){try{await chrome.tabs.get(targetTab);if(enabled)await inject(targetTab);}catch{targetTab=null;enabled=false;}}
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
      ? { id: session.id, name: session.name }
      : null,
    connected,
    peer: {phase:peerState.phase,code:peerState.code,invite:peerState.invite,notice:peerState.notice,coordinator:peerState.coordinator,diagnostics:peerState.diagnostics},
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
  if(!connected)throw new Error("Нет P2P-соединения с другом.");
  await peerRequest("COMMAND",{command:{...command,commandId:crypto.randomUUID(),...(["load","loadExternal"].includes(String(command.type))?{}:{mediaRevision:snapshot?.playback.mediaRevision})}});
}
const REPOSITORY = "tuturuleo/tvissn";
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`;
type UpdateInfo = {installed:string;latest:string;available:boolean;downloadUrl:string|null;releasesUrl:string;checkedAt:number};
let updateInfo: UpdateInfo | null = null;
// The repository is public, so the unauthenticated GitHub API is enough; results are cached to stay under its hourly limit.
async function checkUpdate(force = false): Promise<UpdateInfo> {
  if (!force && updateInfo && Date.now() - updateInfo.checkedAt < 30 * 60000) return updateInfo;
  const r = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? "GitHub временно ограничил проверки. Попробуйте позже." : `GitHub ответил ${r.status}.`);
  const release = await r.json();
  const latest = String(release.tag_name || "").replace(/^extension-v/, "");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(latest)) throw new Error("Не удалось определить версию последнего выпуска.");
  const asset = Array.isArray(release.assets) ? release.assets.find((a: any) => a?.name === "tvissn-extension.zip") : null;
  const url = typeof asset?.browser_download_url === "string" && asset.browser_download_url.startsWith(`https://github.com/${REPOSITORY}/releases/download/`) ? asset.browser_download_url : null;
  const installed = chrome.runtime.getManifest().version;
  updateInfo = { installed, latest, available: isNewer(latest, installed), downloadUrl: url, releasesUrl: RELEASES_URL, checkedAt: Date.now() };
  return updateInfo;
}
async function downloadUpdate() {
  const info = await checkUpdate(true);
  if (!info.downloadUrl) throw new Error("В последнем выпуске нет архива расширения.");
  await chrome.downloads.download({ url: info.downloadUrl, filename: `tvissn-extension-${info.latest}.zip`, conflictAction: "uniquify" });
  return info;
}
async function stop() {
  enabled = false;
  follow.configure(false, null);
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
  if(message.target==="peer")return;
  if(message.type==="PEER_EVENT"){
    if(sender.url===chrome.runtime.getURL("offscreen.html"))acceptPeer(message.state);
    return;
  }
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
      void peerRequest("STATUS", {status:message.status}).catch(()=>{});
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
      if (message.type === "UPDATE") return checkUpdate(!!message.force);
      if (message.type === "DOWNLOAD_UPDATE") return downloadUpdate();
      if (["CREATE","JOIN","ANSWER"].includes(message.type)) {
        if(message.type!=="ANSWER")await stop();
        const next=await peerRequest(message.type,{name:message.name,code:message.code,server:typeof message.server==="string"?message.server:""});
        acceptPeer(next);if(message.name)await chrome.storage.local.set({peerName:message.name});return state();
      }
      if (message.type === "FOLLOW") {
        setFollow(!!message.enabled);
        return state();
      }
      if (message.type === "NAVIGATE") {
        await follow.retry();
        return state();
      }
      if (message.type === "ATTACH") {
        if (!session || !connected) throw new Error("Сначала подключите друга по P2P.");
        const tab = await chrome.tabs.get(message.tabId);
        if (
          !tab.url ||
          !/^https?:/.test(tab.url)
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
        acceptPeer(await peerRequest("CLOSE"));
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
