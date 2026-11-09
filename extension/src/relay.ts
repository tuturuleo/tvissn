import { mqttPublish, mqttSubscribe } from "./mqtt";
// Optional automatic exchange of pairing codes through an ntfy server (https://) or an MQTT broker over WebSocket (wss://).
// The server only sees a topic hashed from the room secret and AES-GCM ciphertext; the secret never leaves the code.
export type Room = { secret: string; server: string };
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const PREFIX = "tvissn-room:";
export const DEFAULT_SERVER = "wss://broker.emqx.io:8084/mqtt";
export const SUGGESTED_SERVERS = [DEFAULT_SERVER, "https://ntfy.sh", "https://ntfy.envs.net", "https://ntfy.adminforge.de", "https://ntfy.mzte.de", "https://ntfy.hostux.net"];
const isMqtt = (server: string) => server.startsWith("wss://");
export function normalizeServer(input: string): string {
  const text = input.trim();
  let url: URL;
  try { url = new URL(text.includes("://") ? text : "https://" + text); } catch { throw new Error("Некорректный адрес сервера обмена."); }
  if ((url.protocol !== "https:" && url.protocol !== "wss:") || url.username || url.password || url.search || url.hash) throw new Error("Сервер обмена должен быть адресом https:// (ntfy) или wss:// (MQTT) без параметров.");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}
export function newRoom(server: string): Room {
  // Rejection sampling: bytes at or above the largest multiple of the alphabet size would skew the distribution.
  const limit = 256 - 256 % ALPHABET.length;
  let chars = "";
  while (chars.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < limit && chars.length < 12) chars += ALPHABET[b % ALPHABET.length];
  }
  return { secret: chars.match(/.{4}/g)!.join("-"), server: normalizeServer(server) };
}
export function encodeRoom(room: Room): string { return PREFIX + room.secret + "@" + room.server.replace(/^https:\/\//, ""); }
export function isRoomCode(code: string) { return code.trim().toLowerCase().startsWith(PREFIX); }
export function decodeRoom(code: string): Room {
  const m = code.trim().match(/^tvissn-room:([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})@(\S{1,200})$/i);
  const secret = m?.[1].toUpperCase();
  if (!m || ![...secret!.replaceAll("-", "")].every(c => ALPHABET.includes(c))) throw new Error("Код комнаты повреждён.");
  return { secret: secret!, server: normalizeServer(m[2]) };
}
const derived = new Map<string, Promise<{ topic: string; key: CryptoKey }>>();
function derive(secret: string) {
  let value = derived.get(secret);
  if (!value) {
    const hash = (label: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(label + secret));
    value = Promise.all([hash("tvissn-room-v1:"), hash("tvissn-key-v1:")]).then(async ([t, k]) => ({
      topic: "tvissn_" + [...new Uint8Array(t).subarray(0, 16)].map(b => b.toString(16).padStart(2, "0")).join(""),
      key: await crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]),
    }));
    derived.set(secret, value);
  }
  return value;
}
async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}
const toBase64 = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export async function seal(secret: string, text: string): Promise<string> {
  const { key } = await derive(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await pipe(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, packed));
  const out = new Uint8Array(iv.length + sealed.length); out.set(iv); out.set(sealed, iv.length);
  return toBase64(out);
}
export async function unseal(secret: string, text: string): Promise<string | null> {
  try {
    const { key } = await derive(secret);
    const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const packed = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
    return new TextDecoder().decode(await pipe(packed, new DecompressionStream("deflate-raw")));
  } catch { return null; }
}
export async function publish(room: Room, text: string) {
  const { topic } = await derive(room.secret);
  const body = await seal(room.secret, text);
  if (isMqtt(room.server)) {
    // Each message gets its own retained subtopic, so the answer does not replace the stored invitation.
    const id = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
    return mqttPublish(room.server, `tvissn/${topic}/${id}`, body);
  }
  // ntfy turns bodies over 4 KB into attachments, which the subscriber would have to fetch separately.
  if (body.length > 3900) throw new Error("Код слишком большой для сервера обмена.");
  const r = await fetch(`${room.server}/${topic}`, { method: "POST", body, cache: "no-store" });
  if (!r.ok) throw new Error(`Сервер обмена ответил ${r.status}.`);
}
// Streams the topic (stored history first, then live) until aborted, reconnecting after network errors.
export async function subscribe(room: Room, signal: AbortSignal, onText: (text: string) => void, onError: (e: Error) => void) {
  const { topic } = await derive(room.secret);
  let cursor = "all";
  while (!signal.aborted) {
    try {
      if (isMqtt(room.server)) {
        await mqttSubscribe(room.server, `tvissn/${topic}/#`, signal, m => void unseal(room.secret, m).then(t => { if (t && !signal.aborted) onText(t); }));
        continue;
      }
      const r = await fetch(`${room.server}/${topic}/json?since=${encodeURIComponent(cursor)}`, { signal, cache: "no-store" });
      if (!r.ok || !r.body) throw new Error(`Сервер обмена ответил ${r.status}.`);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          let m: any; try { m = JSON.parse(line); } catch { continue; }
          if (m?.event !== "message" || typeof m.message !== "string" || typeof m.id !== "string") continue;
          cursor = m.id;
          void unseal(room.secret, m.message).then(t => { if (t && !signal.aborted) onText(t); });
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      onError(e instanceof Error ? e : new Error(String(e)));
    }
    await new Promise<void>(resolve => { const t = setTimeout(resolve, 3000); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
  }
}
