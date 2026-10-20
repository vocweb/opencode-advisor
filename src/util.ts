import type { ModelRef } from "./types.ts"

/** Escape the only character that can forge our pseudo-XML structure. */
export function escapeLt(s: string): string {
  return s.replace(/</g, "&lt;")
}

/**
 * Keep the head and the tail of a long string, dropping the middle.
 * The marker states how many characters were dropped so the advisor knows it is looking at a cut.
 */
export function truncateMiddle(s: string, max: number): string {
  if (max <= 0) return ""
  if (s.length <= max) return s
  const marker = (n: number) => `\n…[${n} chars omitted]…\n`
  const keep = Math.max(0, max - marker(s.length).length)
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  const omitted = s.length - head - tail
  return s.slice(0, head) + marker(omitted) + (tail > 0 ? s.slice(s.length - tail) : "")
}

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return s || "advisor"
}

/** Normalization used for dedupe: lowercase, NFKC, non-alphanumerics collapsed to a single space. */
export function normalizeNote(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** "provider/model-id" -> {providerID, modelID}. Model ids may themselves contain slashes. */
export function parseModel(s: string | undefined | null): ModelRef | undefined {
  if (!s) return undefined
  const i = s.indexOf("/")
  if (i <= 0 || i === s.length - 1) return undefined
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) }
}

const LEVELS: Record<string, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true }

// 既知の思考レベル語だけを接尾辞とみなす。モデル ID に ":" が含まれ得るため。
// Chỉ coi từ level đã biết là hậu tố, vì model id có thể chứa ":" hợp lệ.
export function parseModelSelector(s: string | undefined | null): { ref: ModelRef; level?: string } | undefined {
  if (!s) return undefined
  const i = s.lastIndexOf(":")
  if (i > 0 && Object.hasOwn(LEVELS, s.slice(i + 1).toLowerCase())) {
    const ref = parseModel(s.slice(0, i))
    return ref ? { ref, level: s.slice(i + 1).toLowerCase() } : undefined
  }
  const ref = parseModel(s)
  return ref ? { ref } : undefined
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…"
}
