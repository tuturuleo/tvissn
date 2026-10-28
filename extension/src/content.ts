import type { Playback, Snapshot } from "../../server/protocol";
import { positionAt } from "../../server/timeline";

// Idempotent injection: attaching a second time reuses the same observer and media listeners.
const guard = "__tvissnContentV1" as const;
if (!(globalThis as any)[guard]) {
  (globalThis as any)[guard] = true;
  start();
}
function start() {
  let video: HTMLVideoElement | null = null,
    shared: Playback | null = null,
    primary = false,
    connected = false,
    active = true,
    offset = 0,
    ignoreUntil = 0,
    last = { position: 0, time: 0 },
    blocked = false;
  const videoKeys = new WeakMap<HTMLVideoElement, string>();
  let counter = 0,
    chosenVideoKey: string | null = null;
  let host: HTMLDivElement | null = null,
    label: HTMLSpanElement | null = null,
    playButton: HTMLButtonElement | null = null,
    permissionButton: HTMLButtonElement | null = null;
  const send = (m: unknown) => {
    try {
      return chrome.runtime.sendMessage(m).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };
  const status = (s: string) => void send({ type: "TVISSN_STATUS", status: s });
  const intent = (command: Record<string, unknown>) => {
    if (!primary || !connected) return;
    void send({ type: "TVISSN_INTENT", command }).then((r) => {
      if (r && !r.ok && label) label.textContent = r.error;
    });
  };
  function panel() {
    if (host) return;
    host = document.createElement("div");
    host.dataset.tvissn = "";
    host.style.cssText =
      "position:fixed;bottom:18px;left:18px;z-index:2147483646;";
    const shadow = host.attachShadow({ mode: "closed" }),
      style = document.createElement("style");
    style.textContent =
      ":host{font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#fafafa} .bar{display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid #3f3f46;border-radius:12px;background:#18181bf5;box-shadow:0 5px 24px #0005;max-width:min(520px,85vw);flex-wrap:wrap} strong{font-weight:650} span{color:#b7b7c2;font-size:11px}button{border:1px solid #3f3f46;border-radius:6px;padding:6px 9px;background:#27272a;color:#fafafa;cursor:pointer;font:inherit}button:hover{background:#3f3f46}button:focus-visible{outline:2px solid white;outline-offset:3px}.permission{background:#fafafa;color:#18181b}";
    const bar = document.createElement("div");
    bar.className = "bar";
    const brand = document.createElement("strong");
    brand.textContent = "tvissn.";
    label = document.createElement("span");
    label.textContent = "Подключаем плеер…";
    playButton = document.createElement("button");
    playButton.type = "button";
    playButton.textContent = "Play / Pause";
    playButton.addEventListener("click", () => {
      if (!shared || !video) return;
      ignoreUntil = Date.now() + 1400;
      if (!shared.playing)
        void video.play().catch(() => {
          blocked = true;
        });
      intent({ type: shared.playing ? "pause" : "play" });
    });
    const sync = document.createElement("button");
    sync.type = "button";
    sync.textContent = "↻";
    sync.ariaLabel = "Синхронизировать мой плеер";
    sync.addEventListener("click", () => apply(true));
    permissionButton = document.createElement("button");
    permissionButton.className = "permission";
    permissionButton.type = "button";
    permissionButton.textContent = "Разрешить просмотр";
    permissionButton.hidden = true;
    permissionButton.addEventListener("click", () => {
      blocked = false;
      ignoreUntil = Date.now() + 1400;
      void video
        ?.play()
        .then(() => {
          permissionButton!.hidden = true;
          status("ready");
        })
        .catch(() => {
          blocked = true;
          permissionButton!.hidden = false;
        });
    });
    const hide = document.createElement("button");
    hide.type = "button";
    hide.textContent = "−";
    hide.ariaLabel = "Свернуть панель tvissn";
    let folded = false;
    hide.addEventListener("click", () => {
      folded = !folded;
      for (const el of [label, playButton, sync, permissionButton])
        if (el)
          (el as HTMLElement).hidden =
            folded || (el === permissionButton && !blocked);
      hide.textContent = folded ? "+" : "−";
    });
    bar.append(brand, label, playButton, sync, permissionButton, hide);
    shadow.append(style, bar);
    document.documentElement.appendChild(host);
  }
  function removePanel() {
    host?.remove();
    host = null;
    label = null;
    playButton = null;
    permissionButton = null;
  }
  function apply(hard = false) {
    if (!video || !shared || !primary || !connected || !active) return;
    const target = positionAt(shared, Date.now() + offset);
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      status("connecting");
      return;
    }
    const end = Math.max(0, video.duration - 0.05),
      clamped = Math.min(target, end);
    try {
      if (hard || Math.abs(video.currentTime - clamped) > 0.7) {
        ignoreUntil = Date.now() + 1400;
        video.currentTime = clamped;
        last = { position: clamped, time: Date.now() };
      }
      if (video.playbackRate !== shared.rate) {
        ignoreUntil = Date.now() + 1400;
        video.playbackRate = shared.rate;
      }
      if (shared.playing && video.paused && !blocked) {
        ignoreUntil = Date.now() + 1400;
        void video.play().catch(() => {
          blocked = true;
          if (permissionButton) permissionButton.hidden = false;
          status("connecting");
        });
      }
      if (!shared.playing && !video.paused) {
        ignoreUntil = Date.now() + 1400;
        video.pause();
      }
    } catch {
      status("error");
      if (label) label.textContent = "Плеер не принимает управление";
    }
  }
  const onPlay = () => {
    if (Date.now() < ignoreUntil || !primary || !connected) return;
    blocked = false;
    status("ready");
    if (!shared?.playing) intent({ type: "play" });
  };
  const onPause = () => {
    if (Date.now() < ignoreUntil || !primary || !connected || video?.ended)
      return;
    if (shared?.playing) intent({ type: "pause" });
  };
  const onSeek = () => {
    if (Date.now() < ignoreUntil || !primary || !connected || !video) return;
    ignoreUntil = Date.now() + 700;
    intent({ type: "seek", position: video.currentTime });
  };
  const onRate = () => {
    if (Date.now() < ignoreUntil || !primary || !connected || !video) return;
    intent({ type: "rate", rate: video.playbackRate });
  };
  const onEnded = () => {
    if (Date.now() >= ignoreUntil && primary && video)
      intent({ type: "ended", position: video.currentTime });
  };
  const onWaiting = () => {
    if (primary) status("buffering");
  };
  const onReady = () => {
    if (primary) {
      status("ready");
      apply();
    }
  };
  const events: [string, EventListener][] = [
    ["play", onPlay],
    ["pause", onPause],
    ["seeked", onSeek],
    ["ratechange", onRate],
    ["ended", onEnded],
    ["waiting", onWaiting],
    ["loadedmetadata", onReady],
    ["canplay", onReady],
  ];
  function findVideo(report = true) {
    if (!active) return;
    // Choose the largest visible HTML5 video; popup can select another frame.
    const visible = [...document.querySelectorAll("video")].filter((v) => {
      const style = getComputedStyle(v);
      return (
        v.getBoundingClientRect().width > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    });
    for (const v of visible)
      if (!videoKeys.has(v)) videoKeys.set(v, String(++counter));
    const found =
      visible.find((v) => videoKeys.get(v) === chosenVideoKey) ||
      visible.sort((a, b) => {
        const x = a.getBoundingClientRect(),
          y = b.getBoundingClientRect();
        return y.width * y.height - x.width * x.height;
      })[0] ||
      null;
    if (found !== video) {
      if (video)
        for (const [name, fn] of events) video.removeEventListener(name, fn);
      video = found;
      last = { position: 0, time: 0 };
      if (video)
        for (const [name, fn] of events) video.addEventListener(name, fn);
      if (primary) apply(true);
    }
    if (report)
      void send({
        type: "TVISSN_CANDIDATE",
        candidates: visible.map((v) => {
          const rect = v.getBoundingClientRect();
          return {
            videoKey: videoKeys.get(v),
            area: rect.width * rect.height,
            duration: v.duration,
            url: location.href,
            title: document.title + " · видео " + videoKeys.get(v),
          };
        }),
      });
  }
  chrome.runtime.onMessage.addListener((m, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (m.type === "TVISSN_RESCAN") {
      chosenVideoKey = null;
      findVideo();
      return;
    }
    if (m.type === "TVISSN_RESUME") {
      active = true;
      findVideo();
      return;
    }
    if (m.type === "TVISSN_STOP") {
      active = false;
      primary = false;
      removePanel();
      return;
    }
    if (m.type !== "TVISSN_STATE") return;
    if (m.videoKey && m.videoKey !== chosenVideoKey) {
      chosenVideoKey = m.videoKey;
      findVideo(false);
    }
    active = true;
    const before = shared;
    shared = (m.snapshot as Snapshot).playback;
    primary = !!m.primary;
    connected = !!m.connected;
    offset = m.serverTime - Date.now();
    if (!primary) {
      removePanel();
      return;
    }
    panel();
    if (label)
      label.textContent = connected
        ? shared.playing
          ? "Смотрим вместе"
          : "Общая пауза"
        : "Нет связи · переподключение";
    if (playButton) {
      playButton.textContent = shared.playing ? "Пауза" : "Смотреть";
      playButton.disabled = !connected;
    }
    if (!connected && video && !video.paused) {
      ignoreUntil = Date.now() + 1400;
      video.pause();
    }
    if (
      before?.mediaRevision !== shared.mediaRevision ||
      before?.revision !== shared.revision
    )
      apply(before?.mediaRevision !== shared.mediaRevision);
  });
  const observer = new MutationObserver(() => findVideo());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  setInterval(() => {
    if (!active) return;
    findVideo();
    if (!video || !primary || !shared || !connected) return;
    const now = Date.now(),
      position = video.currentTime;
    if (
      now > ignoreUntil &&
      last.time &&
      Math.abs(
        position -
          last.position -
          (video.paused ? 0 : ((now - last.time) / 1000) * video.playbackRate),
      ) > 1.5
    ) {
      ignoreUntil = now + 700;
      intent({ type: "seek", position });
    } else if (
      now > ignoreUntil &&
      Math.abs(position - positionAt(shared, now + offset)) > 1
    )
      apply();
    last = { position, time: now };
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && primary) apply(true);
  });
  findVideo();
}
