import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  createWidget,
  clampPoint,
  type WidgetPreferences,
} from "../extension/src/widget";
import { FollowMode } from "../extension/src/follow";
function setup() {
  const window = new Window({ url: "https://example.com/watch" });
  const doc = window.document;
  const container = doc.createElement("div");
  const video = doc.createElement("video");
  container.append(video);
  doc.body.append(container);
  const commands: Record<string, unknown>[] = [],
    saves: WidgetPreferences[] = [];
  const widget = createWidget({
    document: doc as unknown as Document,
    video: () => video as unknown as HTMLVideoElement,
    command: (c) => commands.push(c),
    resync() {},
    rescan() {},
    selectPlayer() {},
    disconnect() {},
    toggleFollow() {},
    save: (p) => saves.push(structuredClone(p)),
  });
  return { window, doc, container, video, commands, saves, widget };
}
const pause = { playing: false, connected: true, blocked: false };
test("widget local volume never sends room commands, drag is clamped and persisted", async () => {
  const { window, video, commands, saves, widget } = setup();
  try {
    widget.update(pause);
    const volume =
      widget.root.querySelector<HTMLInputElement>("input[type=range]")!;
    volume.value = "35";
    volume.dispatchEvent(new window.Event("input") as unknown as Event);
    assert.equal(video.volume, 0.35);
    assert.equal(commands.length, 0);
    widget.root
      .querySelector<HTMLButtonElement>("[data-action=volume]")!
      .click();
    assert.equal(video.muted, true);
    assert.equal(commands.length, 0);
    widget.root.querySelector<HTMLButtonElement>("[data-action=play]")!.click();
    assert.deepEqual(commands, [{ type: "play" }]);
    widget.root.querySelector<HTMLButtonElement>("[data-action=fold]")!.click();
    assert.ok(widget.root.querySelector(".widget.folded"));
    const rewind = widget.root.querySelector<HTMLButtonElement>("[data-action=rewind]")!;
    const forward = widget.root.querySelector<HTMLButtonElement>("[data-action=forward]")!;
    assert.equal(rewind.classList.contains("detail"), false);
    assert.equal(forward.classList.contains("detail"), false);
    video.currentTime = 5;
    rewind.click();
    video.currentTime = 25;
    forward.click();
    assert.deepEqual(commands.slice(1), [
      { type: "seek", position: 0 },
      { type: "seek", position: 35 },
    ]);
    const grip = widget.root.querySelector<HTMLElement>("[data-action=grip]")!;
    grip.dispatchEvent(
      new window.PointerEvent("pointerdown", {
        button: 0,
        pointerId: 7,
        clientX: 30,
        clientY: 30,
      }) as unknown as Event,
    );
    window.dispatchEvent(
      new window.PointerEvent("pointermove", {
        pointerId: 7,
        clientX: 110,
        clientY: 100,
      }),
    );
    window.dispatchEvent(
      new window.PointerEvent("pointerup", {
        pointerId: 7,
        clientX: 110,
        clientY: 100,
      }),
    );
    assert.equal(parseFloat(widget.element.style.left), 98);
    assert.ok(saves.some((p) => p.normal));
    assert.ok(parseFloat(widget.element.style.top) <= window.innerHeight - 8);
    assert.deepEqual(clampPoint({ x: 10000, y: -100 }, 330, 44, 1024, 768), {
      x: 686,
      y: 8,
    });
  } finally {
    widget.destroy();
    await window.happyDOM.close();
  }
});
test("widget relocates into fullscreen, restores layout on exit and preserves separate positions", async () => {
  const { window, doc, container, video, widget, saves } = setup();
  let fullscreen: Element | null = null;
  Object.defineProperty(doc, "fullscreenElement", {
    configurable: true,
    get: () => fullscreen,
  });
  (container as any).requestFullscreen = async () => {
    fullscreen = container as unknown as Element;
    doc.dispatchEvent(new window.Event("fullscreenchange"));
  };
  (doc as any).exitFullscreen = async () => {
    fullscreen = null;
    doc.dispatchEvent(new window.Event("fullscreenchange"));
  };
  try {
    widget.update(pause);
    video.setAttribute("style", "width:75%");
    container.setAttribute("style", "padding:4px");
    widget.root
      .querySelector<HTMLButtonElement>("[data-action=fullscreen]")!
      .click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(widget.element.parentElement, container);
    assert.equal(video.style.objectFit, "contain");
    await (doc as any).exitFullscreen();
    assert.equal(widget.element.parentElement, doc.documentElement);
    assert.equal(video.getAttribute("style"), "width:75%");
    assert.equal(container.getAttribute("style"), "padding:4px");
    widget.preferences({ normal: { x: 0, y: 0 }, fullscreen: { x: 1, y: 1 } });
    assert.equal(widget.element.style.left, "8px");
    fullscreen = container as unknown as Element;
    doc.dispatchEvent(new window.Event("fullscreenchange"));
    assert.ok(parseFloat(widget.element.style.left) > 8);
    fullscreen = null;
    doc.dispatchEvent(new window.Event("fullscreenchange"));
    assert.equal(widget.element.style.left, "8px");
  } finally {
    widget.destroy();
    await window.happyDOM.close();
  }
});
test(
  "widget hides while idle, wakes on pointer movement and stays visible with menu or error",
  { timeout: 12000 },
  async () => {
    const { window, widget } = setup();
    try {
      widget.update({ playing: true, connected: true, blocked: false });
      await new Promise((r) => setTimeout(r, 2150));
      assert.equal(widget.hidden, true);
      window.dispatchEvent(
        new window.PointerEvent("pointermove", { clientX: 10, clientY: 10 }),
      );
      assert.equal(widget.hidden, false);
      widget.root
        .querySelector<HTMLButtonElement>("[data-action=menu]")!
        .click();
      await new Promise((r) => setTimeout(r, 2150));
      assert.equal(widget.hidden, false);
      widget.root
        .querySelector<HTMLButtonElement>("[data-action=menu]")!
        .click();
      widget.showError("Проверка ошибки");
      widget.update({ playing: true, connected: true, blocked: false });
      assert.equal(widget.hidden, false);
      assert.match(widget.root.textContent || "", /Проверка ошибки/);
    } finally {
      widget.destroy();
      await window.happyDOM.close();
    }
  },
);
test("autofollow is opt-in, changes only the bound tab and stops after manual navigation", async () => {
  const calls: { tab: number; url: string }[] = [];
  let allowed = true;
  const messages: string[] = [];
  const follow = new FollowMode({
    hasPermission: async () => allowed,
    navigate: async (tab, url) => {
      calls.push({ tab, url });
    },
    notify: (m) => messages.push(m),
    changed() {},
  });
  await follow.update("https://example.com/one", 1);
  assert.equal(calls.length, 0);
  follow.configure(true, 42);
  await follow.update("https://example.com/one", 1);
  assert.deepEqual(calls, [{ tab: 42, url: "https://example.com/one" }]);
  follow.onUrl(42, "https://example.com/one");
  follow.complete(42, "https://example.com/one");
  follow.onUrl(99, "https://other.example/");
  assert.equal(follow.enabled, true);
  await follow.update("https://example.com/two", 2);
  assert.equal(calls.length, 2);
  follow.complete(42, "https://example.com/two");
  follow.onUrl(42, "https://example.com/user-choice");
  assert.equal(follow.enabled, false);
  await follow.update("https://example.com/three", 3);
  assert.equal(calls.length, 2);
  allowed = false;
  follow.configure(true, 42);
  await follow.update("https://new.example/movie", 4);
  assert.equal(follow.pendingGrant, "https://new.example/movie");
  assert.equal(calls.length, 2);
  allowed = true;
  await follow.retry();
  assert.equal(calls.at(-1)?.url, "https://new.example/movie");
  assert.equal(follow.pendingGrant, null);
});
test("rapid shared-video changes cannot complete a stale permission check or navigate twice", async () => {
  const checks: ((v: boolean) => void)[] = [],
    calls: string[] = [];
  const follow = new FollowMode({
    hasPermission: () => new Promise((r) => checks.push(r)),
    navigate: async (_tab, url) => {
      calls.push(url);
    },
    notify() {},
    changed() {},
  });
  follow.configure(true, 1);
  const a = follow.update("https://example.com/old", 1),
    b = follow.update("https://example.com/new", 2);
  checks[0](true);
  checks[1](true);
  await Promise.all([a, b]);
  assert.deepEqual(calls, ["https://example.com/new"]);
  follow.complete(1, "https://example.com/redirected");
  assert.equal(follow.enabled, false);
});
