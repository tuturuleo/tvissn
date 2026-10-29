// Fixed upstream: this endpoint cannot be used as an arbitrary forwarding proxy.
const UPSTREAM = "https://tvissn.onrender.com";
const METHODS: Record<string, string[]> = {
  "/health": ["GET", "HEAD"],
  "/api/health": ["GET", "HEAD"],
  "/api/extension/latest": ["GET", "HEAD", "OPTIONS"],
  "/api/extension/login": ["POST", "OPTIONS"],
  "/api/extension/invite": ["POST", "OPTIONS"],
  "/extension/tvissn-extension.zip": ["GET", "HEAD"],
  "/socket.io/": ["GET"],
};
const json = (error: string, status: number) => Response.json(
  { error }, { status, headers: { "Cache-Control": "no-store" } },
);
export async function proxyRequest(request: Request, forward: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const methods = METHODS[url.pathname];
  if (!methods) return json("Not found", 404);
  if (!methods.includes(request.method)) return json("Method not allowed", 405);
  const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (url.pathname === "/socket.io/" && (!upgrade || url.searchParams.get("transport") !== "websocket"))
    return json("WebSocket required", 400);
  if (upgrade && url.pathname !== "/socket.io/") return json("Not found", 404);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");
  // Origin and Authorization are preserved; authentication remains on the original server.
  try {
    const response = await forward(new Request(UPSTREAM + url.pathname + url.search, {
      method: request.method, headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    }));
    // Return the original 101 response so Workers can forward WebSocket frames natively.
    if (response.status === 101) return response;
    if (response.status >= 300 && response.status < 400) return json("Unexpected upstream redirect", 502);
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", "no-store");
    return result;
  } catch {
    return json("Сервис временно недоступен. Повторяем подключение…", 502);
  }
}
export default { fetch: (request: Request) => proxyRequest(request) };
