import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type { Snapshot } from "../server/protocol";
import identity from "../extension/identity.json";
const wait = (n: number) => new Promise((r) => setTimeout(r, n));
test(
  "API-only server: extension auth, signed invitations, equal control, reconnect and persistence",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "tvissn-test-"));
    await mkdir(join(dir, "dist", "extension"), { recursive: true });
    await writeFile(
      join(dir, "dist", "extension", "tvissn-extension.zip"),
      "zip-fixture",
    );
    const port = 20000 + Math.floor(Math.random() * 20000),
      base = `http://127.0.0.1:${port}`,
      origin = `chrome-extension://${identity.id}`,
      code = "integration-only-invite";
    let proc: ChildProcess | undefined;
    const sockets: Socket[] = [];
    async function start() {
      proc = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), resolve("server/index.ts")],
        {
          cwd: dir,
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATABASE_URL: "",
            INVITE_CODE: code,
            PORT: String(port),
          },
          stdio: "pipe",
        },
      );
      let logs = "";
      proc.stdout?.on("data", (d) => (logs += String(d)));
      proc.stderr?.on("data", (d) => (logs += String(d)));
      for (let i = 0; i < 80; i++) {
        if (proc.exitCode !== null) throw new Error(logs);
        try {
          if ((await fetch(base + "/health")).ok) return;
        } catch {}
        await wait(60);
      }
      throw new Error(logs);
    }
    async function stop() {
      if (proc && proc.exitCode === null) {
        const exit = once(proc, "exit");
        proc.kill("SIGTERM");
        await exit;
      }
    }
    async function login(name: string, invite = code) {
      const r = await fetch(base + "/api/extension/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ name, code: invite }),
      });
      assert.equal(r.status, 200);
      return (await r.json()) as { token: string };
    }
    async function connect(token?: string) {
      return new Promise<Socket>((resolve, reject) => {
        const s = io(base, {
          transports: ["websocket"],
          extraHeaders: { Origin: origin },
          auth: { token },
          reconnection: false,
          timeout: 3000,
        });
        sockets.push(s);
        s.once("connect", () => resolve(s));
        s.once("connect_error", reject);
      });
    }
    const command = (s: Socket, c: Record<string, unknown>) =>
      new Promise<{ ok: boolean; error?: string }>((resolve, reject) =>
        s
          .timeout(4000)
          .emit("command", c, (e: Error | null, r: any) =>
            e ? reject(e) : resolve(r),
          ),
      );
    const snapshot = (s: Socket) =>
      new Promise<Snapshot>((resolve) => {
        s.once("snapshot", resolve);
        s.emit("sync");
      });
    try {
      await start();
      for (const path of [
        "/",
        "/extension",
        "/index.html",
        "/extension/index.html",
        "/api/login",
      ]) {
        const r = await fetch(base + path);
        assert.equal(r.status, 404);
        assert.match(r.headers.get("content-type") || "", /json/);
      }
      const zip = await fetch(
        base + "/extension/tvissn-extension.zip?v=fixture",
      );
      assert.equal(zip.status, 200);
      assert.equal(zip.headers.get("cache-control"), "no-store");
      assert.match(zip.headers.get("content-type") || "", /zip/);
      assert.equal(
        (
          await fetch(base + "/api/extension/login", {
            method: "POST",
            headers: {
              Origin: "https://evil.example",
              "Content-Type": "application/json",
            },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(base + "/api/extension/login", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "A", code: "wrong" }),
          })
        ).status,
        401,
      );
      await assert.rejects(connect());
      const aSession = await login("Аня"),
        bSession = await login("Борис");
      const a = await connect(aSession.token),
        b = await connect(bSession.token);
      const invite = await fetch(base + "/api/extension/invite", {
        method: "POST",
        headers: { Origin: origin, Authorization: "Bearer " + aSession.token },
      });
      assert.equal(invite.status, 200);
      const newCode = ((await invite.json()) as { code: string }).code;
      assert.ok(newCode);
      assert.equal(
        (
          await fetch(base + "/api/extension/invite", {
            method: "POST",
            headers: { Origin: origin },
          })
        ).status,
        401,
      );
      const cSession = await login("Вера", newCode);
      assert.ok(cSession.token);
      assert.equal(
        (
          await fetch(base + "/api/extension/login", {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "D", code: newCode + "x" }),
          })
        ).status,
        401,
      );
      const load = {
        type: "loadExternal",
        commandId: randomUUID(),
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      };
      assert.equal((await command(a, load)).ok, true);
      let s = await snapshot(b);
      const revision = s.playback.revision;
      assert.equal(s.playback.externalUrl, load.url);
      assert.equal((await command(a, load)).ok, true);
      assert.equal((await snapshot(b)).playback.revision, revision);
      assert.equal(
        (
          await command(b, {
            type: "play",
            commandId: randomUUID(),
            mediaRevision: 1,
          })
        ).ok,
        true,
      );
      assert.equal((await snapshot(a)).playback.playing, true);
      assert.equal(
        (
          await command(a, {
            type: "seek",
            commandId: randomUUID(),
            mediaRevision: 0,
            position: 90,
          })
        ).ok,
        false,
      );
      assert.equal(
        (
          await command(b, {
            type: "seek",
            commandId: randomUUID(),
            mediaRevision: 1,
            position: 120,
          })
        ).ok,
        true,
      );
      b.disconnect();
      const joined = await connect(bSession.token);
      s = await snapshot(joined);
      assert.ok(s.playback.position >= 120);
      assert.equal(s.playback.playing, true);
      assert.equal(
        (
          await command(a, {
            type: "loadExternal",
            commandId: randomUUID(),
            url: "https://example.com/second",
          })
        ).ok,
        true,
      );
      assert.equal(
        (await snapshot(joined)).playback.externalUrl,
        "https://example.com/second",
      );
      joined.disconnect();
      a.disconnect();
      await stop();
      await start();
      const restored = await connect(aSession.token);
      s = await snapshot(restored);
      assert.equal(s.playback.playing, false);
      assert.equal(s.playback.externalUrl, "https://example.com/second");
    } finally {
      for (const s of sockets) s.disconnect();
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
