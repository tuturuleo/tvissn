import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { newRoom, publish, seal, subscribe, unseal, type Room } from "../extension/src/relay";

type FetchCall = { url: string; init?: RequestInit };
type FetchHandler = (call: FetchCall, index: number) => Response | Promise<Response>;

// Replaces globalThis.fetch for the duration of `run`, recording every request.
async function withFetch<T>(handler: FetchHandler, run: (calls: FetchCall[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// An ntfy-like streaming response that delivers the given text pieces as separate chunks.
function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(encoder.encode(chunks[next++]));
      else controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const line = (event: object) => JSON.stringify(event) + "\n";
const message = async (room: Room, id: string, text: string) => line({ id, event: "message", message: await seal(room.secret, text) });

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await sleep(5);
  }
}

// Subscribes, serves one stream, waits until `expected` texts arrive (plus a short grace period), then aborts.
async function receiveOnce(room: Room, chunks: string[], expected: number) {
  return withFetch(() => streamOf(chunks), async () => {
    const controller = new AbortController();
    const texts: string[] = [];
    const errors: Error[] = [];
    const done = subscribe(room, controller.signal, text => texts.push(text), error => errors.push(error));
    await waitFor(() => texts.length >= expected);
    await sleep(50);
    controller.abort();
    await done;
    return { texts, errors };
  });
}

test("subscribe reassembles NDJSON lines split across stream chunks", async () => {
  const room = newRoom("https://relay.test");
  const first = await message(room, "m1", "hello");
  const second = await message(room, "m2", "world");
  const joined = first + second;
  // Cut inside the first JSON object, then right after its newline, then inside the second object.
  const cuts = [7, first.length - 3, first.length, first.length + 10];
  const chunks = [0, ...cuts].map((start, i) => joined.slice(start, [...cuts, joined.length][i]));

  const { texts, errors } = await receiveOnce(room, chunks, 2);

  assert.deepEqual(texts.sort(), ["hello", "world"]);
  assert.deepEqual(errors, []);
});

test("subscribe ignores non-message events and malformed JSON", async () => {
  const room = newRoom("https://relay.test");
  const chunks = [
    line({ id: "o1", event: "open" }),
    line({ id: "k1", event: "keepalive" }),
    "{not json\n",
    line({ id: "x1", event: "message" }),
    await message(room, "m1", "payload"),
  ];

  const { texts, errors } = await receiveOnce(room, chunks, 1);

  assert.deepEqual(texts, ["payload"]);
  assert.deepEqual(errors, []);
});

test("subscribe drops messages sealed with a different room secret", async () => {
  const room = newRoom("https://relay.test");
  const stranger = newRoom("https://relay.test");
  const chunks = [await message(stranger, "s1", "not for us"), await message(room, "m1", "for us")];

  const { texts } = await receiveOnce(room, chunks, 1);

  assert.deepEqual(texts, ["for us"]);
});

test("subscribe reconnects with since=<id of the last message> after the stream ends", async () => {
  const room = newRoom("https://relay.test");
  const firstStream = [await message(room, "m1", "one"), await message(room, "m2", "two"), line({ id: "k9", event: "keepalive" })];
  const controller = new AbortController();

  const calls = await withFetch((_call, index) => {
    if (index === 0) return streamOf(firstStream);
    // Stop right after the reconnect request has been recorded.
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  }, async calls => {
    const errors: Error[] = [];
    await subscribe(room, controller.signal, () => {}, error => errors.push(error));
    assert.deepEqual(errors, []);
    return calls;
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/relay\.test\/tvissn_[0-9a-f]{32}\/json\?since=all$/);
  assert.equal(new URL(calls[1].url).searchParams.get("since"), "m2");
  assert.equal(new URL(calls[1].url).pathname, new URL(calls[0].url).pathname);
});

test("publish posts a body sealed with the room secret", async () => {
  const room = newRoom("https://relay.test");

  const calls = await withFetch(() => new Response("", { status: 200 }), async calls => {
    await publish(room, "invitation");
    return calls;
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(await unseal(room.secret, String(calls[0].init?.body)), "invitation");
});

test("publish rejects bodies longer than 3900 characters without sending them", async () => {
  const room = newRoom("https://relay.test");
  // Random bytes do not compress, so the sealed body stays well above the limit.
  const incompressible = Buffer.from(crypto.getRandomValues(new Uint8Array(4000))).toString("base64");

  const calls = await withFetch(() => new Response("", { status: 200 }), async calls => {
    await assert.rejects(publish(room, incompressible), /слишком большой/);
    return calls;
  });

  assert.equal(calls.length, 0);
});

test("publish throws when the server answers with an error status", async () => {
  const room = newRoom("https://relay.test");

  await withFetch(() => new Response("", { status: 503 }), async () => {
    await assert.rejects(publish(room, "invitation"), /503/);
  });
});
