export interface Point {
  x: number;
  y: number;
}
export interface WidgetPreferences {
  normal?: Point;
  fullscreen?: Point;
  volume?: number;
  muted?: boolean;
  folded?: boolean;
}
export interface WidgetState {
  playing: boolean;
  connected: boolean;
  blocked: boolean;
  error?: string;
  players?: { id: string; title: string }[];
  selectedPlayer?: string | null;
  autoFollow?: boolean;
}
interface Options {
  document?: Document;
  video: () => HTMLVideoElement | null;
  command: (command: Record<string, unknown>) => void;
  resync: () => void;
  rescan: () => void;
  selectPlayer: (id: string | null) => void;
  disconnect: () => void;
  toggleFollow: (enabled: boolean) => void;
  save: (prefs: WidgetPreferences) => void;
}
const paths: Record<string, string> = {
  play: "M8 5v14l11-7z",
  rewind: "M3 10V4m0 0h6M3 4l4 4a8 8 0 1 1-2 8M9 11v6M13 11h3v6h-3z",
  forward: "M21 10V4m0 0h-6M21 4l-4 4a8 8 0 1 0 2 8M9 11v6M13 11h3v6h-3z",
  pause: "M8 5v14M16 5v14",
  sync: "M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.6-2L20 9M4 15l2.3 3A7 7 0 0 0 18 16",
  volume: "M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14",
  muted: "M11 5 6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6",
  fullscreen: "M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5",
  menu: "M5 12h.01M12 12h.01M19 12h.01",
  fold: "M6 9l6 6 6-6",
  expand: "M6 15l6-6 6 6",
  grip: "M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01",
};
export function clampPoint(
  p: Point,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
): Point {
  return {
    x: Math.max(8, Math.min(Math.max(8, viewWidth - width - 8), p.x)),
    y: Math.max(8, Math.min(Math.max(8, viewHeight - height - 8), p.y)),
  };
}
export function createWidget(options: Options) {
  const doc = options.document || document,
    win = doc.defaultView!;
  let state: WidgetState = { playing: false, connected: false, blocked: false },
    prefs: WidgetPreferences = {},
    destroyed = false;
  let dragging = false,
    hover = false,
    focused = false,
    keyboardMode = false,
    menuOpen = false,
    folded = false,
    hidden = false;
  let idle: number | undefined,
    saveTimer: number | undefined,
    localError = "";
  let point: Point = { x: 18, y: Math.max(8, win.innerHeight - 76) },
    drag: {
      id: number;
      x: number;
      y: number;
      left: number;
      top: number;
    } | null = null,
    mode: "normal" | "fullscreen" = "normal";
  let ownFullscreen: {
    container: HTMLElement;
    containerStyle: string | null;
    video: HTMLVideoElement;
    videoStyle: string | null;
    wrapper: boolean;
  } | null = null;
  const host = doc.createElement("div");
  host.dataset.tvissn = "";
  host.setAttribute("popover", "manual");
  host.style.cssText =
    "all:initial;position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;z-index:2147483647;max-width:calc(100vw - 16px);box-sizing:border-box;";
  const root = host.attachShadow({ mode: "open" }),
    style = doc.createElement("style");
  style.textContent = `:host{color-scheme:dark}*{box-sizing:border-box}.widget{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fafafa;position:relative;max-width:calc(100vw - 16px);opacity:1;visibility:visible;transition:opacity 140ms ease,visibility 0s linear 0s;filter:drop-shadow(0 8px 24px #0005)}.widget.idle{opacity:0;visibility:hidden;pointer-events:none;transition:opacity 300ms cubic-bezier(.2,0,0,1),visibility 0s linear 300ms}.bar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:6px;border:1px solid #ffffff26;border-radius:12px;background:#18181bef;backdrop-filter:blur(18px);max-width:calc(100vw - 16px)}button,select,input{font:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:7px;flex-shrink:0;min-width:30px;height:30px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:#dedee4;cursor:pointer;touch-action:manipulation}button:hover{background:#ffffff13;color:#fff}button:active{background:#ffffff20}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #d4d4d8;outline-offset:2px}svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.handle{cursor:grab;touch-action:none;user-select:none;gap:0;padding:0 7px}.handle:active{cursor:grabbing}.handle svg{width:15px;color:#71717a}.handle.connected svg{color:#a1a1aa}.play{background:#f4f4f5;color:#18181b}.play:hover{background:#d4d4d8;color:#18181b}.volume{display:flex;align-items:center;gap:2px}.volume input{width:65px;height:20px;accent-color:#e4e4e7;cursor:pointer}.permission{width:auto;padding:0 9px;background:#f4f4f5;color:#18181b;font-size:11px}.notice{display:none;background:#211a17;border:1px solid #785b45;border-radius:8px;font-size:11px;line-height:1.5;padding:9px 11px;margin-bottom:7px;max-width:360px;color:#f0d2b8}.notice.visible{display:block}.menu{position:absolute;left:0;top:calc(100% + 7px);width:240px;padding:8px;border:1px solid #ffffff26;border-radius:10px;background:#18181bf8;backdrop-filter:blur(18px);box-shadow:0 8px 24px #0005}.menu.above{top:auto;bottom:calc(100% + 7px)}.menu[hidden],[hidden]{display:none!important}.menu button{width:100%;justify-content:flex-start;font-size:12px;padding:0 9px;height:33px}.menu .row{display:flex;gap:4px}.menu .row button{width:50%;justify-content:center;border:1px solid #ffffff15}.menu label{display:block;padding:8px 9px;color:#a1a1aa;font-size:11px}.menu select{width:100%;height:30px;border:1px solid #3f3f46;border-radius:6px;background:#27272a;color:#fafafa;margin-top:6px}.menu small{display:block;color:#a1a1aa;font-size:10px;padding:7px 9px;line-height:1.5}.status{padding:6px 9px;font-size:10px;color:#a1a1aa;border-bottom:1px solid #ffffff15;margin-bottom:4px}.divider{height:19px;width:1px;background:#ffffff19;margin:0 3px}.widget.folded .detail{display:none}.widget.dragging{transition:none;user-select:none}@media(prefers-reduced-motion:reduce){.widget,.widget.idle{transition:none!important}}@media(max-width:420px){.volume input{width:44px}.handle{padding-right:5px}.bar{gap:1px}button{min-width:28px;padding:0 6px}}`;
  function icon(button: HTMLElement, name: string) {
    button.replaceChildren();
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[name]);
    svg.append(path);
    button.append(svg);
  }
  function button(name: string, title: string, action: () => void) {
    const b = doc.createElement("button");
    b.type = "button";
    b.title = title;
    b.ariaLabel = title;
    b.dataset.action = name;
    icon(b, name);
    b.addEventListener("click", () => {
      localError = "";
      wake();
      action();
    });
    return b;
  }
  const widget = doc.createElement("section");
  widget.className = "widget";
  widget.ariaLabel = "Панель совместного просмотра tvissn";
  const notice = doc.createElement("div");
  notice.className = "notice";
  notice.setAttribute("role", "status");
  const bar = doc.createElement("div");
  bar.className = "bar";
  const handle = button("grip", "Переместить виджет", () => {});
  handle.className = "handle";
  const play = button("play", "Смотреть вместе", () => {
    const v = options.video();
    if (!state.playing && v) void v.play().catch(() => {});
    options.command({ type: state.playing ? "pause" : "play" });
  });
  play.className = "play";
  const sync = button("sync", "Синхронизировать мой плеер", options.resync);
  sync.className = "detail";
  const volumeGroup = doc.createElement("div");
  volumeGroup.className = "volume detail";
  const mute = button("volume", "Выключить звук у себя", () => {
    const v = options.video();
    if (!v) return;
    v.muted = !v.muted;
    prefs.muted = v.muted;
    syncVolume();
    save();
  });
  const volume = doc.createElement("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "100";
  volume.step = "1";
  volume.value = "100";
  volume.ariaLabel = "Громкость только у меня";
  volume.title = "Громкость только у меня";
  volume.addEventListener("input", () => {
    const v = options.video();
    if (!v) return;
    v.volume = Number(volume.value) / 100;
    v.muted = v.volume === 0;
    prefs.volume = v.volume;
    prefs.muted = v.muted;
    syncVolume();
    clearTimeout(saveTimer);
    saveTimer = win.setTimeout(save, 200);
    wake();
  });
  volumeGroup.append(mute, volume);
  const fullscreen = button("fullscreen", "Видео на весь экран", () => {
    void toggleFullscreen();
  });
  fullscreen.className = "detail";
  const menuButton = button("menu", "Меню просмотра", () => {
    menuOpen = !menuOpen;
    menu.hidden = !menuOpen;
    menuButton.setAttribute("aria-expanded", String(menuOpen));
    menuPosition();
    scheduleHide();
  });
  menuButton.className = "detail";
  menuButton.setAttribute("aria-expanded", "false");
  const fold = button("fold", "Свернуть панель", () => {
    folded = !folded;
    prefs.folded = folded;
    renderFold();
    save();
  });
  const permission = doc.createElement("button");
  permission.type = "button";
  permission.className = "permission";
  permission.textContent = "Разрешить просмотр";
  permission.hidden = true;
  permission.addEventListener("click", () => {
    const v = options.video();
    if (v)
      void v
        .play()
        .then(() => {
          state.blocked = false;
          render();
          wake();
        })
        .catch(() => showError("Нажмите play в плеере сайта."));
  });
  const menu = doc.createElement("div");
  menu.className = "menu";
  menu.hidden = true;
  const status = doc.createElement("div");
  status.className = "status";
  function textButton(title: string, fn: () => void) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = title;
    b.addEventListener("click", () => {
      wake();
      fn();
    });
    return b;
  }
  function seekBy(delta: number) {
    const v = options.video();
    if (!v) return;
    options.command({
      type: "seek",
      position: Math.max(0, Math.min(
        Number.isFinite(v.duration) ? v.duration : 604800,
        v.currentTime + delta,
      )),
    });
  }
  const rewind = button("rewind", "Назад на 10 секунд для всех", () => seekBy(-10));
  const forward = button("forward", "Вперёд на 10 секунд для всех", () => seekBy(10));
  const rateLabel = doc.createElement("label");
  rateLabel.textContent = "Общая скорость";
  const rate = doc.createElement("select");
  rate.ariaLabel = "Общая скорость";
  for (const n of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    const o = doc.createElement("option");
    o.value = String(n);
    o.textContent = n + "×";
    rate.append(o);
  }
  rate.addEventListener("change", () =>
    options.command({ type: "rate", rate: Number(rate.value) }),
  );
  rateLabel.append(rate);
  const playerLabel = doc.createElement("label");
  playerLabel.textContent = "Плеер";
  const players = doc.createElement("select");
  players.ariaLabel = "Выбрать плеер";
  players.addEventListener("change", () =>
    options.selectPlayer(players.value === "auto" ? null : players.value),
  );
  playerLabel.append(players);
  const scan = textButton("Найти плееры заново", () => {
    menuOpen = false;
    menu.hidden = true;
    options.rescan();
  });
  scan.dataset.action = "rescan";
  const reset = textButton("Вернуть панель в угол", () => {
    point = { x: 18, y: Math.max(8, win.innerHeight - measure().height - 18) };
    position();
    remember();
  });
  const leave = textButton("Отключиться от просмотра", options.disconnect);
  const hint = doc.createElement("small");
  hint.textContent =
    "Громкость меняется только у вас. Пауза и перемотка — у всех.";
  const followLabel = doc.createElement("label");
  followLabel.style.cssText =
    "display:flex;align-items:center;gap:8px;cursor:pointer";
  const follow = doc.createElement("input");
  follow.type = "checkbox";
  follow.ariaLabel = "Автопереход за общим видео";
  follow.addEventListener("change", () => options.toggleFollow(follow.checked));
  followLabel.append(follow, doc.createTextNode("Автопереход за общим видео"));
  const changeForm = doc.createElement("form");
  changeForm.style.cssText = "padding:8px 9px";
  const changeUrl = doc.createElement("input");
  changeUrl.type = "url";
  changeUrl.required = true;
  changeUrl.placeholder = "Ссылка на другое видео";
  changeUrl.ariaLabel = "Ссылка на другое общее видео";
  changeUrl.style.cssText =
    "width:100%;height:30px;border:1px solid #3f3f46;border-radius:6px;background:#27272a;color:#fafafa;padding:0 7px;font:inherit";
  const changeButton = doc.createElement("button");
  changeButton.type = "submit";
  changeButton.textContent = "Установить видео для всех";
  changeForm.append(changeUrl, changeButton);
  changeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (changeUrl.value.trim()) {
      options.command({ type: "loadExternal", url: changeUrl.value.trim() });
      menuOpen = false;
      menu.hidden = true;
    }
  });
  menu.append(
    status,
    rateLabel,
    playerLabel,
    scan,
    followLabel,
    changeForm,
    reset,
    leave,
    hint,
  );
  bar.append(
    handle,
    rewind,
    play,
    forward,
    sync,
    volumeGroup,
    fullscreen,
    menuButton,
    permission,
    fold,
  );
  widget.append(notice, bar, menu);
  root.append(style, widget);
  function measure() {
    const r = bar.getBoundingClientRect();
    return {
      width: r.width || 330,
      height:
        (r.height || 44) +
        (notice.classList.contains("visible")
          ? notice.getBoundingClientRect().height + 7
          : 0),
    };
  }
  function position() {
    if (destroyed) return;
    const size = measure();
    point = clampPoint(
      point,
      size.width,
      size.height,
      win.innerWidth,
      win.innerHeight,
    );
    host.style.left = point.x + "px";
    host.style.top = point.y + "px";
    menuPosition();
  }
  function measureBarHeight() {
    return bar.getBoundingClientRect().height || 44;
  }
  function menuPosition() {
    const below = win.innerHeight - point.y - measureBarHeight() - 16,
      above = point.y - 16;
    const wanted = menu.getBoundingClientRect().height || 430;
    const up = below < wanted && above > below;
    menu.classList.toggle("above", up);
    menu.style.maxHeight = Math.max(80, up ? above : below) + "px";
    menu.style.overflowY = "auto";
    const room = win.innerWidth - 240 - point.x - 8;
    menu.style.left = Math.min(0, room) + "px";
  }
  function restorePosition() {
    const stored = prefs[mode];
    const size = measure();
    point = stored
      ? {
          x: stored.x * Math.max(0, win.innerWidth - size.width - 16) + 8,
          y: stored.y * Math.max(0, win.innerHeight - size.height - 16) + 8,
        }
      : { x: 18, y: Math.max(8, win.innerHeight - size.height - 18) };
    position();
  }
  function remember() {
    const size = measure();
    prefs[mode] = {
      x: Math.max(
        0,
        Math.min(
          1,
          (point.x - 8) / Math.max(1, win.innerWidth - size.width - 16),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          1,
          (point.y - 8) / Math.max(1, win.innerHeight - size.height - 16),
        ),
      ),
    };
    save();
  }
  function save() {
    if (!destroyed) options.save({ ...prefs });
  }
  function pinned() {
    return (
      !state.playing ||
      !state.connected ||
      state.blocked ||
      !!state.error ||
      !!localError ||
      dragging ||
      hover ||
      focused ||
      menuOpen
    );
  }
  function scheduleHide() {
    clearTimeout(idle);
    if (!pinned())
      idle = win.setTimeout(() => {
        if (!pinned()) {
          hidden = true;
          widget.classList.add("idle");
          widget.setAttribute("aria-hidden", "true");
        }
      }, 2000);
  }
  function wake() {
    if (destroyed) return;
    hidden = false;
    widget.classList.remove("idle");
    widget.removeAttribute("aria-hidden");
    scheduleHide();
  }
  function syncVolume() {
    const v = options.video();
    if (!v) return;
    volume.value = String(Math.round(v.volume * 100));
    icon(mute, v.muted || v.volume === 0 ? "muted" : "volume");
    mute.ariaLabel = v.muted ? "Включить звук у себя" : "Выключить звук у себя";
    mute.title = mute.ariaLabel;
  }
  function renderFold() {
    widget.classList.toggle("folded", folded);
    icon(fold, folded ? "expand" : "fold");
    fold.ariaLabel = folded ? "Развернуть панель" : "Свернуть панель";
    fold.title = fold.ariaLabel;
    win.requestAnimationFrame(position);
  }
  let playersKey = "";
  function render() {
    follow.checked = !!state.autoFollow;
    handle.classList.toggle("connected", state.connected);
    status.textContent = state.connected
      ? state.playing
        ? "Смотрим вместе"
        : "Общая пауза"
      : "Нет связи — переподключение";
    icon(play, state.playing ? "pause" : "play");
    play.ariaLabel = state.playing ? "Пауза для всех" : "Смотреть вместе";
    play.title = play.ariaLabel;
    play.disabled = !state.connected;
    rewind.disabled = forward.disabled = !state.connected;
    permission.hidden = !state.blocked;
    notice.textContent =
      localError ||
      state.error ||
      (!state.connected
        ? "Восстанавливаем соединение…"
        : state.blocked
          ? "Браузер ожидает разрешения на воспроизведение."
          : "");
    notice.classList.toggle("visible", !!notice.textContent);
    const v = options.video();
    if (v) rate.value = String(v.playbackRate);
    syncVolume();
    const nextKey = JSON.stringify([state.players, state.selectedPlayer]);
    if (nextKey !== playersKey) {
      playersKey = nextKey;
      players.replaceChildren();
      const auto = doc.createElement("option");
      auto.value = "auto";
      auto.textContent = "Автоматически";
      players.append(auto);
      for (const p of state.players || []) {
        const o = doc.createElement("option");
        o.value = p.id;
        o.textContent = p.title;
        players.append(o);
      }
      players.value = state.selectedPlayer || "auto";
    }
    playerLabel.hidden = (state.players?.length || 0) < 2;
    position();
  }
  function showError(message: string) {
    localError = message;
    render();
    wake();
  }
  function deepFullscreen(): Element | null {
    let el = doc.fullscreenElement;
    while (el?.shadowRoot?.fullscreenElement)
      el = el.shadowRoot.fullscreenElement;
    return el;
  }
  function showLayer() {
    try {
      if (
        typeof host.showPopover === "function" &&
        !host.matches(":popover-open")
      )
        host.showPopover();
    } catch {
      host.removeAttribute("popover");
    }
  }
  function restoreOwn() {
    const own = ownFullscreen;
    if (!own) return;
    ownFullscreen = null;
    own.videoStyle === null
      ? own.video.removeAttribute("style")
      : own.video.setAttribute("style", own.videoStyle);
    if (own.wrapper) {
      if (own.container.parentNode) own.container.replaceWith(own.video);
    } else
      own.containerStyle === null
        ? own.container.removeAttribute("style")
        : own.container.setAttribute("style", own.containerStyle);
  }
  function onFullscreen() {
    if (destroyed) return;
    const fs = deepFullscreen(),
      next = fs ? "fullscreen" : "normal";
    if (!fs) restoreOwn();
    if (next !== mode) {
      mode = next;
      restorePosition();
    }
    const parent =
      fs && fs !== options.video() && fs.tagName !== "IFRAME"
        ? fs
        : doc.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    showLayer();
    position();
    wake();
  }
  async function toggleFullscreen() {
    const v = options.video();
    if (!v) return;
    if (doc.fullscreenElement) {
      try {
        await doc.exitFullscreen();
      } catch {
        showError("Не удалось выйти из полноэкранного режима. Нажмите Esc.");
      }
      return;
    }
    let parent =
      v.closest<HTMLElement>(
        ".html5-video-player,.video-js,.plyr,[data-player]",
      ) || v.parentElement;
    let wrapper = false;
    if (!parent || parent === doc.body || parent === doc.documentElement) {
      parent = doc.createElement("div");
      v.before(parent);
      parent.append(v);
      wrapper = true;
    }
    const saved = {
      container: parent,
      containerStyle: parent.getAttribute("style"),
      video: v,
      videoStyle: v.getAttribute("style"),
      wrapper,
    };
    ownFullscreen = saved;
    try {
      if (!parent.requestFullscreen) throw new Error();
      await parent.requestFullscreen({ navigationUI: "hide" });
      if (destroyed) return;
      parent.style.setProperty("background", "#000", "important");
      parent.style.setProperty("display", "flex", "important");
      parent.style.setProperty("align-items", "center", "important");
      parent.style.setProperty("justify-content", "center", "important");
      v.style.setProperty("width", "100%", "important");
      v.style.setProperty("height", "100%", "important");
      v.style.setProperty("object-fit", "contain", "important");
      onFullscreen();
    } catch {
      restoreOwn();
      showError(
        "Этот плеер не разрешил fullscreen. Используйте кнопку плеера.",
      );
    }
  }
  const move = (e: PointerEvent) => {
    wake();
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    point = {
      x: drag.left + e.clientX - drag.x,
      y: drag.top + e.clientY - drag.y,
    };
    position();
  };
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    dragging = false;
    widget.classList.remove("dragging");
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {}
    remember();
    wake();
  };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: point.x,
      top: point.y,
    };
    widget.classList.add("dragging");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {}
    wake();
  });
  handle.addEventListener("keydown", (e) => {
    const steps: Record<string, Point> = {
      ArrowLeft: { x: -10, y: 0 },
      ArrowRight: { x: 10, y: 0 },
      ArrowUp: { x: 0, y: -10 },
      ArrowDown: { x: 0, y: 10 },
    };
    const step = steps[e.key];
    if (step) {
      e.preventDefault();
      point = { x: point.x + step.x, y: point.y + step.y };
      position();
      remember();
    }
  });
  bar.addEventListener("pointerenter", () => {
    hover = true;
    wake();
  });
  widget.addEventListener("pointerleave", () => {
    hover = false;
    scheduleHide();
  });
  root.addEventListener("focusin", () => {
    focused = keyboardMode;
    wake();
  });
  root.addEventListener("focusout", () => {
    win.setTimeout(() => {
      focused = keyboardMode && !!root.activeElement;
      scheduleHide();
    }, 0);
  });
  function outside(e: Event) {
    keyboardMode = false;
    focused = false;
    if (!e.composedPath().includes(host) && menuOpen) {
      menuOpen = false;
      menu.hidden = true;
      menuButton.setAttribute("aria-expanded", "false");
    }
    scheduleHide();
  }
  function key(e: KeyboardEvent) {
    keyboardMode = true;
    focused = !!root.activeElement;
    if (e.key === "Escape" && menuOpen) {
      menuOpen = false;
      menu.hidden = true;
      menuButton.focus();
    }
    wake();
  }
  const resize = () => {
    restorePosition();
    wake();
  };
  win.addEventListener("pointermove", move, { passive: false });
  win.addEventListener("pointerup", end);
  win.addEventListener("pointercancel", end);
  win.addEventListener("resize", resize);
  doc.addEventListener("keydown", key);
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("fullscreenchange", onFullscreen);
  doc.documentElement.append(host);
  showLayer();
  restorePosition();
  render();
  return {
    element: host,
    root,
    update(next: WidgetState) {
      const changed =
        state.playing !== next.playing ||
        state.connected !== next.connected ||
        state.blocked !== next.blocked ||
        state.error !== next.error;
      state = next;
      render();
      if (changed) wake();
    },
    preferences(next: WidgetPreferences) {
      prefs = { ...prefs, ...next };
      folded = !!prefs.folded;
      renderFold();
      const v = options.video();
      if (v) {
        if (prefs.volume !== undefined) v.volume = prefs.volume;
        if (prefs.muted !== undefined) v.muted = prefs.muted;
      }
      syncVolume();
      if (!dragging) restorePosition();
    },
    videoChanged() {
      const v = options.video();
      if (v) {
        if (prefs.volume !== undefined) v.volume = prefs.volume;
        if (prefs.muted !== undefined) v.muted = prefs.muted;
      }
      onFullscreen();
      render();
      wake();
    },
    volumeChanged: syncVolume,
    showError,
    destroy() {
      destroyed = true;
      clearTimeout(idle);
      clearTimeout(saveTimer);
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", end);
      win.removeEventListener("pointercancel", end);
      win.removeEventListener("resize", resize);
      doc.removeEventListener("keydown", key);
      doc.removeEventListener("pointerdown", outside);
      doc.removeEventListener("fullscreenchange", onFullscreen);
      if (ownFullscreen) {
        void doc.exitFullscreen?.().catch(() => {});
        restoreOwn();
      }
      host.remove();
    },
    get hidden() {
      return hidden;
    },
  };
}
