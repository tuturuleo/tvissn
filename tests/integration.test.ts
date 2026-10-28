import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type { Snapshot } from "../server/protocol";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "real HTTP and WebSocket clients: authentication, equal control, idempotence, reconnect and restart",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "tvissn-test-"));
    const port = 20000 + Math.floor(Math.random() * 20000),
      origin = `http://127.0.0.1:${port}`;
    const code = "integration-only-invite";
    let proc: ChildProcess | undefined;
    const sockets: Socket[] = [];
    const start = async () => {
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
            APP_ORIGIN: origin,
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
          if ((await fetch(origin + "/health")).ok) return;
        } catch {}
        await wait(60);
      }
      throw new Error("Server start timeout: " + logs);
    };
    const stop = async () => {
      if (proc && proc.exitCode === null) {
        const exit = once(proc, "exit");
        proc.kill("SIGTERM");
        await exit;
      }
    };
    const login = async (name: string) => {
      const response = await fetch(origin + "/api/login", {
        method: "POST",
        headers: { origin, "Content-Type": "application/json" },
        body: JSON.stringify({ name, code }),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie")!.split(";")[0];
    };
    const connect = (cookie?: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = io(origin, {
          transports: ["websocket"],
          extraHeaders: {
            Origin: origin,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          reconnection: false,
          timeout: 3000,
        });
        sockets.push(socket);
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", reject);
      });
    const command = (socket: Socket, c: Record<string, unknown>) =>
      new Promise<{ ok: boolean; error?: string }>((resolve) =>
        socket
          .timeout(4000)
          .emit(
            "command",
            c,
            (err: Error | null, res: { ok: boolean; error?: string }) => {
              assert.ifError(err);
              resolve(res);
            },
          ),
      );
    const snap = (socket: Socket) =>
      new Promise<Snapshot>((resolve) => {
        socket.once("snapshot", resolve);
        socket.emit("sync");
      });
    try {
      await start();
      assert.equal((await fetch(origin + "/api/session")).status, 401);
      assert.equal(
        (
          await fetch(origin + "/api/login", {
            method: "POST",
            headers: {
              origin: "https://evil.example",
              "Content-Type": "application/json",
            },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(origin + "/api/login", {
            method: "POST",
            headers: { origin, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "A", code: "wrong" }),
          })
        ).status,
        401,
      );
      await assert.rejects(connect());
      const cookieA = await login("Аня"),
        cookieB = await login("Борис");
      const a = await connect(cookieA),
        b = await connect(cookieB);
      assert.equal((await snap(a)).participants.length, 2);
      const load = {
        type: "load",
        commandId: randomUUID(),
        url: "https://youtu.be/dQw4w9WgXcQ?t=10",
      };
      assert.equal((await command(a, load)).ok, true);
      let s = await snap(b);
      assert.equal(s.playback.videoId, "dQw4w9WgXcQ");
      assert.equal(s.playback.position, 10);
      const revision = s.playback.revision;
      assert.equal((await command(a, load)).ok, true);
      assert.equal((await snap(b)).playback.revision, revision);
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
      assert.equal((await snap(a)).playback.playing, true);
      assert.equal(
        (
          await command(a, {
            type: "seek",
            commandId: randomUUID(),
            mediaRevision: 0,
            position: 120,
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
      s = await snap(a);
      assert.ok(s.playback.position >= 120);
      assert.equal(s.playback.updatedBy, "Борис");
      b.disconnect();
      const rejoined = await connect(cookieB);
      s = await snap(rejoined);
      assert.equal(s.playback.playing, true);
      assert.ok(s.playback.position >= 120);
      assert.equal(s.participants.length, 2);
      await fetch(origin + "/api/logout", {
        method: "POST",
        headers: { origin, Cookie: cookieB },
      });
      await wait(80);
      assert.equal(rejoined.connected, false);
      a.disconnect();
      await stop();
      await start();
      const restored = await connect(cookieA);
      s = await snap(restored);
      assert.equal(s.playback.playing, false);
      assert.equal(s.playback.videoId, "dQw4w9WgXcQ");
      assert.ok(s.playback.position >= 120);
    } finally {
      for (const socket of sockets) socket.disconnect();
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
