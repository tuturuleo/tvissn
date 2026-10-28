import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { applyCommand, type Playback } from "../server/protocol";

import {
  credential,
  parseInvitation,
  isNewer,
  samePage,
  serverOrigin,
} from "../extension/src/shared";
import identity from "../extension/identity.json";

test("extension parses website-free invitations and old fragment links", () => {
  const url = new URL("tvissn://join");
  url.searchParams.set("server", "https://tvissn.onrender.com");
  url.searchParams.set("invite", "signed+invitation");
  assert.deepEqual(parseInvitation(url.toString()), {
    server: "https://tvissn.onrender.com",
    code: "signed+invitation",
  });
  assert.equal(
    credential("https://tvissn.onrender.com/#invite=old-code"),
    "old-code",
  );
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
  assert.throws(() => serverOrigin("http://example.com"));
  assert.equal(serverOrigin("http://localhost:3000"), "http://localhost:3000");
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
test("popup announces a newer version and its download button opens the release ZIP", async () => {
  const compiled = await build({
    entryPoints: ["extension/src/popup.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    target: "chrome116",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const window = new Window({
    url: `chrome-extension://${identity.id}/popup.html`,
  });
  const opened: string[] = [];
  (window as any).chrome = {
    runtime: {
      getManifest: () => ({ version: "0.2.0.0" }),
      connect: () => ({ disconnect() {} }),
      sendMessage: async (m: any) => ({
        ok: true,
        result:
          m.type === "UPDATE"
            ? {
                version: "0.2.1.0",
                extensionId: identity.id,
                downloadUrl:
                  "https://tvissn.onrender.com/extension/tvissn-extension.zip",
              }
            : { session: null },
      }),
    },
    tabs: {
      query: async () => [],
      create: async (o: any) => {
        opened.push(o.url);
      },
    },
  };
  window.document.body.innerHTML = '<div id="root"></div>';
  try {
    window.eval(compiled.outputFiles[0].text);
    for (
      let i = 0;
      i < 30 && !window.document.body.textContent.includes("Доступна версия");
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.match(
      window.document.body.textContent,
      /Доступна версия 0\.2\.1\.0/,
    );
    const download = [...window.document.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Скачать обновление"),
    )!;
    assert.ok(download);
    download.click();
    assert.deepEqual(opened, [
      "https://tvissn.onrender.com/extension/tvissn-extension.zip",
    ]);
  } finally {
    await window.happyDOM.close();
  }
});
test("popup shows room participants and local server ping", async () => {
  const compiled = await build({
    entryPoints: ["extension/src/popup.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    target: "chrome116",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const window = new Window({
    url: `chrome-extension://${identity.id}/popup.html`,
  });
  (window as any).chrome = {
    runtime: {
      getManifest: () => ({ version: "0.2.0.0" }),
      connect: () => ({ disconnect() {} }),
      sendMessage: async (m: any) => ({
        ok: true,
        result:
          m.type === "UPDATE"
            ? { version: "0.2.0.0" }
            : {
                session: {
                  id: "a",
                  name: "Анна",
                  server: "https://example.com",
                },
                connected: true,
                ping: 42,
                enabled: false,
                snapshot: {
                  participants: [
                    { id: "a", name: "Анна", status: "ready" },
                    { id: "b", name: "Борис", status: "buffering" },
                  ],
                  playback: { externalUrl: null },
                },
              },
      }),
    },
    tabs: { query: async () => [] },
  };
  window.document.body.innerHTML = '<div id="root"></div>';
  try {
    window.eval(compiled.outputFiles[0].text);
    for (
      let i = 0;
      i < 30 && !window.document.body.textContent.includes("Борис");
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.match(window.document.body.textContent, /Борис/);
    assert.match(window.document.body.textContent, /42 мс/);
    assert.match(window.document.body.textContent, /Загружает видео/);
  } finally {
    await window.happyDOM.close();
  }
});
