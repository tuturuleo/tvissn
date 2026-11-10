import test from "node:test";
import assert from "node:assert/strict";
import { wireSchema } from "../extension/src/room";
import {
  applyCommand,
  parseYoutube,
  positionAt,
  commandSchema,
  type Playback,
} from "../shared/protocol";

const initial: Playback = {
  videoId: null,
  position: 0,
  playing: false,
  rate: 1,
  anchor: 1000,
  revision: 0,
  mediaRevision: 0,
  updatedBy: null,
};
const id = "a2ec06d7-a30b-4217-a92f-c4f64b2415e3";
test("YouTube links accept exact supported hosts and timecodes", () => {
  for (const link of [
    "https://youtu.be/dQw4w9WgXcQ?t=1m20s",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=80",
    "https://youtube.com/shorts/dQw4w9WgXcQ?t=80",
    "https://www.youtube.com/embed/dQw4w9WgXcQ#t=80",
  ])
    assert.deepEqual(parseYoutube(link), {
      videoId: "dQw4w9WgXcQ",
      position: 80,
    });
  for (const link of [
    "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)",
    "https://evil.com/dQw4w9WgXcQ",
    "https://youtube.com/watch?v=short",
    "https://user@youtube.com/watch?v=dQw4w9WgXcQ",
  ])
    assert.equal(parseYoutube(link), null);
});
test("shared timeline advances by rate and freezes on pause", () => {
  let s = applyCommand(
    initial,
    { type: "load", commandId: id, url: "https://youtu.be/dQw4w9WgXcQ?t=20" },
    "A",
    1000,
  );
  assert.equal(s.playing, false);
  s = applyCommand(
    s,
    { type: "play", commandId: id, mediaRevision: 1 },
    "B",
    2000,
  );
  assert.equal(positionAt(s, 5000), 23);
  s = applyCommand(
    s,
    { type: "rate", commandId: id, mediaRevision: 1, rate: 2 },
    "A",
    5000,
  );
  assert.equal(positionAt(s, 7000), 27);
  s = applyCommand(
    s,
    { type: "pause", commandId: id, mediaRevision: 1 },
    "B",
    7000,
  );
  assert.equal(positionAt(s, 9000), 27);
  assert.equal(s.updatedBy, "B");
});
test("pause clamps the shared timeline to a valid snapshot position", () => {
  const now = Date.now();
  const s: Playback = {
    ...initial,
    videoId: "dQw4w9WgXcQ",
    playing: true,
    position: 604790,
    rate: 2,
    anchor: now - 60000,
  };
  const result = applyCommand(
    s,
    { type: "pause", commandId: id, mediaRevision: s.mediaRevision },
    "A",
    now,
  );
  assert.equal(result.position, 604800);
  assert.equal(result.playing, false);
  assert.doesNotThrow(() =>
    wireSchema.parse({
      type: "snapshot",
      snapshot: {
        epoch: crypto.randomUUID(),
        serverTime: now,
        playback: result,
        participants: [],
      },
    }),
  );
});
test("old video commands cannot mutate a replacement video", () => {
  const s = applyCommand(
    initial,
    { type: "load", commandId: id, url: "https://youtu.be/dQw4w9WgXcQ" },
    "A",
    1000,
  );
  assert.throws(() =>
    applyCommand(
      s,
      { type: "seek", commandId: id, mediaRevision: 0, position: 50 },
      "B",
      2000,
    ),
  );
});
test("ended from before a seek is ignored and repeated ended is idempotent", () => {
  let s = applyCommand(
    {
      ...initial,
      videoId: "dQw4w9WgXcQ",
      mediaRevision: 1,
      playing: true,
      position: 500,
    },
    { type: "seek", commandId: id, mediaRevision: 1, position: 50 },
    "A",
    1000,
  );
  assert.equal(
    applyCommand(
      s,
      { type: "ended", commandId: id, mediaRevision: 1, position: 500 },
      "A",
      1500,
    ),
    s,
  );
  s = applyCommand(
    s,
    { type: "ended", commandId: id, mediaRevision: 1, position: 51 },
    "A",
    2000,
  );
  assert.equal(s.playing, false);
  assert.equal(
    applyCommand(
      s,
      { type: "ended", commandId: id, mediaRevision: 1, position: 51 },
      "A",
      2000,
    ),
    s,
  );
});
test("reject invalid command values", () => {
  assert.equal(
    commandSchema.safeParse({
      type: "seek",
      commandId: id,
      mediaRevision: 1,
      position: -1,
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "rate",
      commandId: id,
      mediaRevision: 1,
      rate: 1.01,
    }).success,
    false,
  );
});
