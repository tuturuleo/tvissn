import test from "node:test";
import assert from "node:assert/strict";
import { ServiceRouter, serviceRoutes } from "../extension/src/routes";
import { proxyRequest } from "../infra/proxy/worker";
const proxy = "https://tvissn-proxy.lissn.workers.dev";
const direct = "https://tvissn.onrender.com";
test("known service routes fail over and retain a successful route without retrying auth errors", async () => {
  const calls: string[] = [];
  const router = new ServiceRouter((async (url: string) => {
    calls.push(url);
    if (url.startsWith(proxy)) throw new Error("network");
    return Response.json({ ok: true });
  }) as typeof fetch);
  const result = await router.fetch(direct, "/health");
  assert.equal(result.server, direct);
  assert.deepEqual(calls, [proxy + "/health", direct + "/health"]);
  assert.equal(router.current(proxy), direct);
  assert.equal(router.next(direct), proxy);
  assert.deepEqual(serviceRoutes("https://private.example"), ["https://private.example"]);
  let attempts = 0;
  const denied = new ServiceRouter((async () => { attempts++; return new Response(null, { status: 401 }); }) as typeof fetch);
  assert.equal((await denied.fetch(proxy, "/api/extension/login")).response.status, 401);
  assert.equal(attempts, 1);
});
test("fixed proxy preserves auth, forwards upgrades untouched and rejects arbitrary destinations", async () => {
  const response = await proxyRequest(new Request(proxy + "/api/extension/latest?url=https://evil.example", {
    headers: { Origin: "chrome-extension://test", Authorization: "Bearer token", Cookie: "private=secret" },
  }), (async (request: Request) => {
    assert.equal(new URL(request.url).origin, direct);
    assert.equal(request.headers.get("Origin"), "chrome-extension://test");
    assert.equal(request.headers.get("Authorization"), "Bearer token");
    assert.equal(request.headers.has("Cookie"), false);
    return Response.json({ version: "1" });
  }) as typeof fetch);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const upgrade = { status: 101 } as Response;
  assert.equal(await proxyRequest(new Request(proxy + "/socket.io/?EIO=4&transport=websocket", {
    headers: { Upgrade: "websocket" },
  }), (async () => upgrade) as typeof fetch), upgrade);
  assert.equal((await proxyRequest(new Request(proxy + "/https://evil.example"))).status, 404);
  assert.equal((await proxyRequest(new Request(proxy + "/socket.io/?transport=polling"))).status, 400);
});
