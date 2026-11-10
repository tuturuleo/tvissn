import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { applyCommand, type Playback } from "../shared/protocol";

import { isNewer, pickPrimary, samePage } from "../extension/src/shared";
import identity from "../extension/identity.json";

test("pickPrimary returns no players without an external URL", () => {
  const candidates = [{ id: "a", url: "https://example.com/video", area: 100 }];
  for (const externalUrl of [undefined, null, ""]) {
    assert.deepEqual(pickPrimary(candidates, externalUrl, "a"), {
      matching: [],
      primary: undefined,
    });
  }
});

test("pickPrimary prefers the selected player over a larger player", () => {
  const url = "https://example.com/video";
  const candidates = [
    { id: "large", url, area: 1000 },
    { id: "selected", url, area: 100 },
  ];
  assert.equal(pickPrimary(candidates, url, "selected").primary, candidates[1]);
});

test("pickPrimary falls back to the largest player and keeps the first on ties", () => {
  const url = "https://example.com/video";
  const candidates = [
    { id: "small", url, area: 100 },
    { id: "large", url, area: 1000 },
    { id: "tied", url, area: 1000 },
  ];
  for (const selectedPlayer of [null, "missing"]) {
    assert.equal(pickPrimary(candidates, url, selectedPlayer).primary, candidates[1]);
  }
  assert.deepEqual(pickPrimary([], url, null), {
    matching: [],
    primary: undefined,
  });
});

test("pickPrimary filters other paths and searches but ignores hashes", () => {
  const url = "https://example.com/video?episode=1";
  const candidates = [
    { id: "same", url, area: 100 },
    { id: "path", url: "https://example.com/other?episode=1", area: 1000 },
    { id: "search", url: "https://example.com/video?episode=2", area: 1000 },
    { id: "hash", url: url + "#player", area: 200 },
  ];
  const result = pickPrimary(candidates, url, "path");
  assert.deepEqual(result.matching, [candidates[0], candidates[3]]);
  assert.equal(result.primary, candidates[3]);
});

test("pickPrimary preserves input and matching insertion order", () => {
  const url = "https://example.com/video";
  const candidates = [
    { id: "small", url, area: 100 },
    { id: "large", url, area: 1000 },
    { id: "medium", url, area: 500 },
  ];
  const original = structuredClone(candidates);
  assert.deepEqual(pickPrimary(candidates, url, null).matching, original);
  assert.deepEqual(candidates, original);
  const map = new Map(candidates.map((c) => [c.id, c]));
  assert.deepEqual(pickPrimary(map.values(), url, null).matching, original);
  assert.deepEqual([...map.values()], original);
});

test("stable ID derives from the checked-in public key; Chrome versions compare numerically", () => {
  const id = [
    ...createHash("sha256")
      .update(Buffer.from(identity.key, "base64"))
      .digest()
      .subarray(0, 16),
  ]
    .flatMap((b) => [b >> 4, b & 15])
    .map((n) => String.fromCharCode(97 + n))
    .join("");
  assert.equal(id, identity.id);
  assert.equal(id, "fkohpgglbodngaicfehkgdojlbgpbijo");
  assert.equal(isNewer("0.2.27400.2", "0.2.27399.65535"), true);
  assert.equal(isNewer("0.2.1.9", "0.2.1.10"), false);
  assert.equal(
    samePage("https://example.com/video#player2", "https://example.com/video"),
    true,
  );

});
test("external media uses the same authoritative timeline and rejects unsafe URLs", () => {
  const start: Playback = {
    videoId: null,
    mediaRevision: 0,
    position: 0,
    playing: false,
    rate: 1,
    anchor: 0,
    revision: 0,
    updatedBy: null,
  };
  const s = applyCommand(
    start,
    {
      type: "loadExternal",
      commandId: crypto.randomUUID(),
      url: "https://example.com/video",
    },
    "A",
    1000,
  );
  assert.equal(s.externalUrl, "https://example.com/video");
  assert.equal(
    applyCommand(
      s,
      { type: "play", commandId: crypto.randomUUID(), mediaRevision: 1 },
      "B",
      2000,
    ).playing,
    true,
  );
  assert.throws(() =>
    applyCommand(
      start,
      {
        type: "loadExternal",
        commandId: crypto.randomUUID(),
        url: "javascript:alert(1)",
      },
      "A",
      1000,
    ),
  );
});
test("content adapter selects multiple players, rescans replacement video and can reattach after stop", async () => {
  const compiled = await build({
    entryPoints: ["extension/src/content.ts"],
    bundle: true,
    format: "iife",
    write: false,
    target: "chrome116",
  });
  const window = new Window({ url: "https://example.com/video" });
  const reports: any[] = [];
  let listener: (m: any, s: any) => void = () => {};
  const chrome = {
    runtime: {
      id: identity.id,
      onMessage: { addListener: (fn: any) => (listener = fn) },
      sendMessage: async (m: any) => {
        reports.push(m);
        return { ok: true };
      },
    },
  };
  (window as any).chrome = chrome;
  function video(width: number) {
    const v = window.document.createElement("video");
    v.getBoundingClientRect = () => ({ width, height: 200 }) as any;
    Object.defineProperty(v, "duration", { value: 600 });
    Object.defineProperty(v, "paused", { value: true });
    window.document.body.appendChild(v);
    return v;
  }
  try {
    const a = video(640),
      b = video(320);
    window.eval(compiled.outputFiles[0].text);
    const candidates = reports.find(
      (r) => r.type === "TVISSN_CANDIDATE",
    ).candidates;
    assert.equal(candidates.length, 2);
    const snapshot = {
      playback: {
        videoId: null,
        externalUrl: "https://example.com/video",
        mediaRevision: 1,
        revision: 1,
        position: 25,
        playing: false,
        rate: 1,
        anchor: Date.now(),
      },
      epoch: "test",
      serverTime: Date.now(),
      participants: [],
    };
    listener(
      {
        type: "TVISSN_STATE",
        primary: true,
        connected: true,
        videoKey: candidates[0].videoKey,
        snapshot,
        serverTime: Date.now(),
      },
      { id: identity.id },
    );
    assert.equal(a.currentTime, 25);
    listener(
      {
        type: "TVISSN_STATE",
        primary: true,
        connected: true,
        videoKey: candidates[1].videoKey,
        snapshot,
        serverTime: Date.now(),
      },
      { id: identity.id },
    );
    assert.equal(b.currentTime, 25);
    a.remove();
    b.remove();
    const c = video(800);
    listener({ type: "TVISSN_RESCAN" }, { id: identity.id });
    const latest = reports
      .filter((r) => r.type === "TVISSN_CANDIDATE")
      .at(-1).candidates;
    assert.equal(latest.length, 1);
    assert.notEqual(latest[0].videoKey, candidates[0].videoKey);
    assert.equal(c.currentTime, 25);
    listener({ type: "TVISSN_STOP" }, { id: identity.id });
    listener({ type: "TVISSN_RESUME" }, { id: identity.id });
    assert.equal(
      reports.filter((r) => r.type === "TVISSN_CANDIDATE").at(-1).candidates
        .length,
      1,
    );
  } finally {
    await window.happyDOM.close();
  }
});

async function playbackAdapter() {
  const compiled = await build({
    entryPoints: ["extension/src/content.ts"],
    bundle: true,
    format: "iife",
    write: false,
    target: "chrome116",
  });
  const window = new Window({ url: "https://example.com/video" });
  const reports: any[] = [];
  let listener: (m: any, s: any) => void = () => {};
  (window as any).chrome = {
    runtime: {
      id: identity.id,
      onMessage: { addListener: (fn: any) => (listener = fn) },
      sendMessage: async (m: any) => {
        reports.push(m);
        return { ok: true };
      },
    },
  };
  function video(width: number, play: () => Promise<void>) {
    const v = window.document.createElement("video");
    v.getBoundingClientRect = () => ({ width, height: 200 }) as any;
    Object.defineProperty(v, "duration", { value: 600 });
    Object.defineProperty(v, "paused", { value: true });
    v.play = play;
    window.document.body.appendChild(v);
    return v;
  }
  let revision = 0;
  return {
    window,
    reports,
    video,
    start: () => window.eval(compiled.outputFiles[0].text),
    state: (videoKey: string, mediaRevision = 1) => {
      listener(
        {
          type: "TVISSN_STATE",
          primary: true,
          connected: true,
          videoKey,
          snapshot: {
            playback: {
              videoId: null,
              mediaRevision,
              revision: ++revision,
              position: 25,
              playing: true,
              rate: 1.25,
              anchor: Date.now(),
            },
          },
          serverTime: Date.now(),
        },
        { id: identity.id },
      );
    },
    rescan: () => listener({ type: "TVISSN_RESCAN" }, { id: identity.id }),
  };
}

function deferredPlay() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flushPlayback = () => new Promise<void>((resolve) => setImmediate(resolve));

test("blocked playback retries on another player and suppresses programmatic intents", async () => {
  const adapter = await playbackAdapter();
  const { window, reports, video, state } = adapter;
  let firstPlays = 0,
    secondPlays = 0;
  try {
    const a = video(640, () => {
      firstPlays++;
      return Promise.reject(new Error("Autoplay denied"));
    });
    const b = video(320, () => {
      secondPlays++;
      for (const name of ["play", "pause", "seeked", "ratechange", "ended"])
        b.dispatchEvent(new window.Event(name));
      return Promise.resolve();
    });
    adapter.start();
    state("1");
    await flushPlayback();
    for (let i = 0; i < 3; i++) {
      state("1");
      a.dispatchEvent(new window.Event("canplay"));
      window.document.dispatchEvent(new window.Event("visibilitychange"));
    }
    assert.equal(firstPlays, 1, "the blocked video must not retry");
    state("2");
    await flushPlayback();
    assert.equal(secondPlays, 1, "selecting another player permits playback");
    assert.equal(reports.filter((r) => r.type === "TVISSN_INTENT").length, 0);
  } finally {
    await window.happyDOM.close();
  }
});

test("replacing a blocked video element permits playback", async () => {
  const adapter = await playbackAdapter();
  const { window, video, state } = adapter;
  let replacementPlays = 0;
  try {
    const a = video(640, () => Promise.reject(new Error("Autoplay denied")));
    adapter.start();
    state("1");
    await flushPlayback();
    a.remove();
    video(640, () => {
      replacementPlays++;
      return Promise.resolve();
    });
    adapter.rescan();
    await flushPlayback();
    assert.equal(replacementPlays, 1);
  } finally {
    await window.happyDOM.close();
  }
});

test("a late rejection from the previous player cannot block the selected player", async () => {
  const adapter = await playbackAdapter();
  const { window, reports, video, state } = adapter;
  const oldPlay = deferredPlay(),
    newPlay = deferredPlay();
  let plays = 0;
  try {
    video(640, () => oldPlay.promise);
    const b = video(320, () => {
      plays++;
      return plays === 1 ? newPlay.promise : Promise.resolve();
    });
    adapter.start();
    state("1");
    state("2");
    state("2");
    assert.equal(plays, 1, "pending playback must not create concurrent attempts");
    const reportCount = reports.length;
    oldPlay.reject(new Error("Late autoplay denial"));
    await flushPlayback();
    assert.equal(
      reports.slice(reportCount).filter((r) => r.type === "TVISSN_STATUS").length,
      0,
      "the stale rejection must not change the current player status",
    );
    newPlay.resolve();
    await flushPlayback();
    b.dispatchEvent(new window.Event("canplay"));
    assert.equal(plays, 2, "the current player remains eligible for playback");
  } finally {
    await window.happyDOM.close();
  }
});

test("mediaRevision resets blocking and invalidates pending playback on the same element", async () => {
  const adapter = await playbackAdapter();
  const { window, video, state } = adapter;
  const oldPlay = deferredPlay();
  let plays = 0;
  try {
    const a = video(640, () => {
      plays++;
      if (plays === 1) return Promise.reject(new Error("Autoplay denied"));
      if (plays === 2) return oldPlay.promise;
      return Promise.resolve();
    });
    adapter.start();
    state("1", 1);
    await flushPlayback();
    state("1", 1);
    assert.equal(plays, 1);
    state("1", 2);
    assert.equal(plays, 2, "new shared media permits another attempt");
    state("1", 3);
    assert.equal(plays, 3, "pending playback belongs to its mediaRevision");
    await flushPlayback();
    oldPlay.reject(new Error("Late denial for previous media"));
    await flushPlayback();
    a.dispatchEvent(new window.Event("canplay"));
    assert.equal(plays, 4, "a rejection for old media cannot block current media");
  } finally {
    await window.happyDOM.close();
  }
});
