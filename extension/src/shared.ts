import identity from "../identity.json";
export const DEFAULT_SERVER = identity.defaultServer;
export interface ExtensionSession {
  server: string;
  token: string;
  name: string;
  id: string;
  exp: number;
}
export function serverOrigin(value: string) {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error(
      "Укажите HTTPS-адрес сервиса. HTTP разрешён только для localhost.",
    );
  if (url.username || url.password)
    throw new Error("Адрес сервиса не должен содержать пароль.");
  return url.origin;
}
export function samePage(a: string, b: string) {
  try {
    const x = new URL(a),
      y = new URL(b);
    return (
      x.origin + x.pathname + x.search === y.origin + y.pathname + y.search
    );
  } catch {
    return false;
  }
}
export function isNewer(a: string, b: string) {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}
export function parseInvitation(value: string): {
  code: string;
  server?: string;
} {
  try {
    const url = new URL(value);
    const code =
      new URLSearchParams(url.hash.slice(1)).get("invite") ||
      url.searchParams.get("invite");
    if (!code) return { code: value.trim() };
    const server =
      url.protocol === "tvissn:"
        ? serverOrigin(url.searchParams.get("server") || DEFAULT_SERVER)
        : serverOrigin(url.origin);
    return { code, server };
  } catch {
    return { code: value.trim() };
  }
}
export function credential(value: string) {
  return parseInvitation(value).code;
}
