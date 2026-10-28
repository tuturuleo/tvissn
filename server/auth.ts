import { createHmac, timingSafeEqual } from "node:crypto";
export interface Session {
  id: string;
  name: string;
  exp: number;
}
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function signSession(s: Session, secret: string) {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function readSession(
  token: string | undefined,
  secret: string,
): Session | null {
  if (!token || token.length > 2048) return null;
  const [body, sig, ...rest] = token.split(".");
  if (
    !body ||
    !sig ||
    rest.length ||
    !safeEqual(
      sig,
      createHmac("sha256", secret).update(body).digest("base64url"),
    )
  )
    return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString());
    return typeof s.id === "string" &&
      typeof s.name === "string" &&
      s.name.length <= 32 &&
      typeof s.exp === "number" &&
      s.exp > Date.now()
      ? s
      : null;
  } catch {
    return null;
  }
}
