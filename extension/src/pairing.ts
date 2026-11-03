import { z } from "zod";
const schema = z.object({ v: z.literal(1), kind: z.enum(["offer", "answer"]),
  pair: z.string().uuid(), expires: z.number().finite(),
  sdp: z.string().min(1).max(60000) }).strict();
const CLOCK_SKEW = 10 * 60000;
export type Pairing = z.infer<typeof schema>;
export function encodePairing(value: Pairing): string {
  const bytes = new TextEncoder().encode(JSON.stringify(schema.parse(value)));
  return "tvissn-p2p:" + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodePairing(code: string, kind?: Pairing["kind"]): Pairing {
  const text = code.trim();
  if (!text.startsWith("tvissn-p2p:") || text.length > 100000) throw new Error("Нужен код P2P из новой версии расширения.");
  let value: Pairing;
  try { value = schema.parse(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.slice(11).replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))))); }
  catch { throw new Error("Код подключения повреждён."); }
  // expires comes from the creator's clock; tolerate a few minutes of drift between the two devices.
  if (value.expires < Date.now() - CLOCK_SKEW) throw new Error("Код устарел. Создайте новый.");
  if (value.expires > Date.now() + 30 * 60000 + CLOCK_SKEW) throw new Error("Код недействителен: часы на устройствах сильно расходятся. Проверьте дату и время.");
  if (kind && value.kind !== kind) throw new Error(kind === "answer" ? "Вставьте ответный код друга." : "Вставьте первый код подключения.");
  return value;
}
