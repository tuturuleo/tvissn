import identity from "../identity.json";

export function serviceRoutes(server: string): string[] {
  const known = [identity.defaultServer, ...(identity.fallbackServers || [])];
  return known.includes(server) ? [...new Set(known)] : [server];
}
export class ServiceRouter {
  private preferred = new Map<string, string>();
  constructor(private transport: typeof fetch = fetch, private timeoutMs = 12000) {}
  current(server: string): string {
    return this.preferred.get(serviceRoutes(server)[0]) || serviceRoutes(server)[0];
  }
  prefer(server: string, endpoint: string) {
    const routes = serviceRoutes(server);
    if (routes.includes(endpoint)) this.preferred.set(routes[0], endpoint);
  }
  next(server: string) {
    const routes = serviceRoutes(server);
    const index = routes.indexOf(this.current(server));
    this.prefer(server, routes[(index + 1) % routes.length]);
    return this.current(server);
  }
  async fetch(server: string, path: string, init: RequestInit = {}) {
    const preferred = this.current(server);
    const routes = [preferred, ...serviceRoutes(server).filter(r => r !== preferred)];
    for (let i = 0; i < routes.length; i++) {
      const endpoint = routes[i];
      try {
        const response = await this.transport(endpoint + path, {
          ...init, cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status >= 500 && i < routes.length - 1) {
          await response.body?.cancel();
          continue;
        }
        if (response.status < 500) this.prefer(server, endpoint);
        return { response, server: endpoint };
      } catch {
        if (i === routes.length - 1)
          throw new Error("Не удалось подключиться ни к одному адресу сервиса. Проверьте сеть.");
      }
    }
    throw new Error("Сервис недоступен.");
  }
}
