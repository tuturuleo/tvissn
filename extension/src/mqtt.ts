// Minimal MQTT 3.1.1 client over WebSocket: just enough to publish retained messages and subscribe to a topic filter.
// Retained messages give the same "history" the ntfy transport relies on, so a friend can join after the invitation was sent.
const encoder = new TextEncoder(), decoder = new TextDecoder();
function str(s: string) { const b = encoder.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function packet(type: number, body: number[] | Uint8Array) {
  const head = [type];
  let n = body.length;
  do { let digit = n % 128; n = Math.floor(n / 128); if (n > 0) digit |= 128; head.push(digit); } while (n > 0);
  const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length);
  return out;
}
type Packet = { type: number; flags: number; body: Uint8Array };
type Session = { send(p: Uint8Array): void; next(type: number, ms: number): Promise<Packet>; onPublish(fn: (topic: string, payload: Uint8Array) => void): void; close(): void; closed: Promise<void> };
function connect(url: string, signal?: AbortSignal): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, "mqtt");
    ws.binaryType = "arraybuffer";
    let buffer = new Uint8Array(0), publishFn: ((t: string, p: Uint8Array) => void) | null = null, ping: ReturnType<typeof setInterval> | undefined;
    const waiters: { type: number; resolve: (p: Packet) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
    let finish!: () => void; const closed = new Promise<void>(r => { finish = r; });
    const fail = (e: Error) => { clearInterval(ping); for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(e); } finish(); reject(e); };
    const session: Session = {
      send: p => { if (ws.readyState === WebSocket.OPEN) ws.send(p); },
      next: (type, ms) => new Promise((res, rej) => { const timer = setTimeout(() => { const i = waiters.findIndex(w => w.timer === timer); if (i >= 0) waiters.splice(i, 1); rej(new Error("Брокер MQTT не ответил.")); }, ms); waiters.push({ type, resolve: res, reject: rej, timer }); }),
      onPublish: fn => { publishFn = fn; },
      close: () => { clearInterval(ping); try { session.send(new Uint8Array([0xe0, 0])); ws.close(); } catch {} finish(); },
      closed,
    };
    signal?.addEventListener("abort", () => session.close(), { once: true });
    ws.onerror = () => fail(new Error("Брокер MQTT недоступен."));
    ws.onclose = () => fail(new Error("Брокер MQTT закрыл соединение."));
    ws.onmessage = e => {
      const chunk = new Uint8Array(e.data as ArrayBuffer);
      const merged = new Uint8Array(buffer.length + chunk.length); merged.set(buffer); merged.set(chunk, buffer.length); buffer = merged;
      for (;;) {
        let length = 0, mul = 1, i = 1;
        for (; i < buffer.length && i < 5; i++) { length += (buffer[i] & 127) * mul; mul *= 128; if (!(buffer[i] & 128)) break; }
        if (i >= buffer.length || buffer.length < i + 1 + length) return;
        const p = { type: buffer[0] >> 4, flags: buffer[0] & 15, body: buffer.slice(i + 1, i + 1 + length) };
        buffer = buffer.slice(i + 1 + length);
        if (p.type === 3) {
          const t = (p.body[0] << 8) | p.body[1], qos = (p.flags >> 1) & 3;
          const topic = decoder.decode(p.body.subarray(2, 2 + t)), start = 2 + t + (qos ? 2 : 0);
          if (qos === 1) session.send(packet(0x40, [p.body[2 + t], p.body[3 + t]]));
          publishFn?.(topic, p.body.subarray(start));
          continue;
        }
        const w = waiters.findIndex(x => x.type === p.type);
        if (w >= 0) { const [x] = waiters.splice(w, 1); clearTimeout(x.timer); x.resolve(p); }
      }
    };
    ws.onopen = async () => {
      try {
        const id = "tvissn-" + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
        // Every acknowledgement is awaited before its request is sent, so a fast reply cannot be missed.
        const pending = session.next(2, 10000);
        session.send(packet(0x10, [...str("MQTT"), 4, 0x02, 0, 60, ...str(id)]));
        const ack = await pending;
        if (ack.body[1] !== 0) throw new Error(`Брокер MQTT отказал в подключении (${ack.body[1]}).`);
        ping = setInterval(() => session.send(new Uint8Array([0xc0, 0])), 30000);
        resolve(session);
      } catch (e) { session.close(); fail(e as Error); }
    };
  });
}
export async function mqttPublish(url: string, topic: string, payload: string) {
  const s = await connect(url);
  try {
    const id = 1 + Math.floor(Math.random() * 65534);
    // QoS 1 + retain: the broker confirms storage with PUBACK before we hang up.
    const ack = s.next(4, 10000);
    s.send(packet(0x33, [...str(topic), id >> 8, id & 255, ...encoder.encode(payload)]));
    await ack;
  } finally { s.close(); }
}
export async function mqttSubscribe(url: string, filter: string, signal: AbortSignal, onPayload: (text: string) => void) {
  const s = await connect(url, signal);
  s.onPublish((_topic, payload) => { if (payload.length) onPayload(decoder.decode(payload)); });
  const pending = s.next(9, 10000);
  s.send(packet(0x82, [0, 1, ...str(filter), 0]));
  const ack = await pending;
  if (ack.body[2] === 0x80) { s.close(); throw new Error("Брокер MQTT отказал в подписке."); }
  await s.closed;
  if (!signal.aborted) throw new Error("Брокер MQTT закрыл соединение.");
}
