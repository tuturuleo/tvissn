import { createWidget, type WidgetPreferences } from "./widget";
import type { Playback, Snapshot } from "../../shared/protocol";
import { positionAt } from "../../shared/timeline";

// Idempotent injection: attaching a second time reuses the same observer and media listeners.
const guard = "__tvissnContentV1" as const;
if (!(globalThis as any)[guard]) {
  (globalThis as any)[guard] = true;
  start();
}
function start() {
  type PlayAttempt = { video: HTMLVideoElement; mediaRevision: number };
  let blocked: PlayAttempt | null = null,
    playAttempt: PlayAttempt | null = null;
  let video: HTMLVideoElement | null = null,
    shared: Playback | null = null,
    primary = false,
    connected = false,
    active = true,
    offset = 0,
    ignoreUntil = 0,
    last = { position: 0, time: 0 };
  const videoKeys = new WeakMap<HTMLVideoElement, string>();
  let counter = 0,
    chosenVideoKey: string | null = null;
  let widget: ReturnType<typeof createWidget> | null = null;
  let playerOptions: { id: string; title: string }[] = [],
    selectedPlayer: string | null = null,
    autoFollow = false;
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
      if (r && !r.ok) widget?.showError(r.error);
    });
  };
  function updatePanel() {
    if (!primary) return;
    if (!widget) {
      widget = createWidget({
        video: () => video,
        command: intent,
        resync: () => apply(true),
        rescan: () => {
          void send({ type: "TVISSN_RESCAN_REQUEST" });
        },
        selectPlayer: (id) => {
          void send({ type: "TVISSN_SELECT_PLAYER", playerId: id });
        },
        disconnect: () => {
          void send({ type: "TVISSN_DISCONNECT" });
        },
        toggleFollow: (value) => {
          void send({ type: "TVISSN_FOLLOW", enabled: value });
        },
        save: (prefs) => {
          void send({ type: "TVISSN_PREFS_SET", prefs });
        },
      });
      void send({ type: "TVISSN_PREFS_GET" }).then((result) => {
        if (result?.ok) widget?.preferences(result.result as WidgetPreferences);
      });
    }
    widget.update({
      playing: !!shared?.playing,
      connected,
      blocked: !!blocked,
      players: playerOptions,
      selectedPlayer,
      autoFollow,
    });
  }
  function removePanel() {
    widget?.destroy();
    widget = null;
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
      if (shared.playing && video.paused && !blocked && !playAttempt) {
        ignoreUntil = Date.now() + 1400;
        const attempt = { video, mediaRevision: shared.mediaRevision };
        playAttempt = attempt;
        void video.play().then(
          () => {
            if (playAttempt === attempt) playAttempt = null;
          },
          () => {
            if (
              playAttempt !== attempt ||
              video !== attempt.video ||
              shared?.mediaRevision !== attempt.mediaRevision
            )
              return;
            playAttempt = null;
            blocked = attempt;
            updatePanel();
            status("connecting");
          },
        );
      }
      if (!shared.playing && !video.paused) {
        ignoreUntil = Date.now() + 1400;
        video.pause();
      }
    } catch {
      playAttempt = null;
      status("error");
      widget?.showError("Плеер не принимает управление");
    }
  }
  const onPlay = () => {
    if (primary) {
      blocked = null;
      updatePanel();
      status("ready");
    }
    if (Date.now() < ignoreUntil || !primary || !connected) return;
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
    ["volumechange", () => widget?.volumeChanged()],
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
      blocked = null;
      playAttempt = null;
      last = { position: 0, time: 0 };
      if (video)
        for (const [name, fn] of events) video.addEventListener(name, fn);
      if (primary) {
        widget?.videoChanged();
        updatePanel();
        apply(true);
      }
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
    active = true;
    const before = shared;
    shared = (m.snapshot as Snapshot).playback;
    if (before?.mediaRevision !== shared.mediaRevision) {
      blocked = null;
      playAttempt = null;
    }
    primary = !!m.primary;
    connected = !!m.connected;
    offset = m.serverTime - Date.now();
    if (m.videoKey && m.videoKey !== chosenVideoKey) {
      chosenVideoKey = m.videoKey;
      findVideo(false);
    }
    if (!primary) {
      removePanel();
      return;
    }
    playerOptions = m.players || [];
    selectedPlayer = m.selectedPlayer || null;
    autoFollow = !!m.autoFollow;
    updatePanel();
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
  let scanning = false;
  const observer = new MutationObserver((records) => {
    if (
      scanning ||
      records.every(
        (r) => r.target instanceof Element && r.target.closest("[data-tvissn]"),
      )
    )
      return;
    scanning = true;
    queueMicrotask(() => {
      scanning = false;
      findVideo();
    });
  });
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
