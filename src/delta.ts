import { isSelfMessage } from "./render.ts"
import type { Msg } from "./types.ts"

export interface Delta {
  /** Messages the advisor has not seen yet (self-injected ones included; the renderer skips them). */
  items: Msg[]
  /** Cursor to store after a *successful* review. */
  cursor: string | undefined
  /** True when messages between the old cursor and the oldest fetched message were not fetched. */
  gap: boolean
}

/**
 * Compute what is new since `cursor` (a message id).
 *
 *  - ids are monotonic, so "unseen" means `id > cursor`;
 *  - an assistant message that has not completed yet is still streaming: the delta stops *before* it so
 *    ordering is preserved and the message is reviewed once it is complete;
 *  - if `limit` messages were fetched and the cursor is older than all of them, there is a gap.
 */
export function computeDelta(msgs: Msg[], cursor: string | undefined, fetchLimit?: number): Delta {
  const sorted = [...msgs].sort((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
  let gap = false
  if (fetchLimit !== undefined && sorted.length >= fetchLimit && sorted[0] && (cursor === undefined || sorted[0].info.id > cursor)) gap = true
  const items: Msg[] = []
  let last = cursor
  for (const m of sorted) {
    if (cursor !== undefined && m.info.id <= cursor) continue
    if (m.info.role === "assistant" && !m.info.time.completed) break
    items.push(m)
    last = m.info.id
  }
  return { items, cursor: last, gap }
}

/** Cursor that makes the next delta start at the last `n` messages (used to (re)prime an advisor). */
export function tailCursor(msgs: Msg[], n: number): string | undefined {
  const sorted = [...msgs].sort((a, b) => (a.info.id < b.info.id ? -1 : 1))
  const idx = sorted.length - n - 1
  return idx >= 0 ? sorted[idx]!.info.id : undefined
}

/** Cursor that makes the next delta start at the latest user message (seed for resumed sessions). */
export function currentTurnCursor(msgs: Msg[]): string | undefined {
  const sorted = [...msgs].sort((a, b) => (a.info.id < b.info.id ? -1 : 1))
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i]!
    if (m.info.role === "user" && !isSelfMessage(m)) return i > 0 ? sorted[i - 1]!.info.id : undefined
  }
  return undefined
}

/** Cursor that skips every message created before `t` (ms epoch): used after `/advisor on`. */
export function cursorBefore(msgs: Msg[], t: number): string | undefined {
  const sorted = [...msgs].sort((a, b) => (a.info.id < b.info.id ? -1 : 1))
  let last: string | undefined
  for (const m of sorted) if (m.info.time.created < t) last = m.info.id
  return last
}
