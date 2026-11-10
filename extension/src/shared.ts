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
export function pickPrimary<T extends { id: string; url: string; area: number }>(
  candidates: Iterable<T>,
  externalUrl: string | null | undefined,
  selectedPlayer: string | null,
): { matching: T[]; primary: T | undefined } {
  const matching = externalUrl
    ? [...candidates].filter((c) => samePage(c.url, externalUrl))
    : [];
  const primary =
    matching.find((c) => c.id === selectedPlayer) ||
    [...matching].sort((a, b) => b.area - a.area)[0];
  return { matching, primary };
}
export function isNewer(a: string, b: string) {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}
