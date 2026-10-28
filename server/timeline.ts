import type { Playback } from "./protocol";
export function positionAt(s: Playback, now: number) {
  return Math.max(
    0,
    s.position +
      (s.playing ? (Math.max(0, now - s.anchor) / 1000) * s.rate : 0),
  );
}
