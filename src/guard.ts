import { SEVERITY_RANK, type Note, type Severity } from "./types.ts"
import { normalizeNote } from "./util.ts"

/**
 * Per-advisor emission guard (port of oh-my-pi's AdvisorEmissionGuard):
 *  1. normalization (lowercase, NFKC, punctuation collapsed)
 *  2. content-free phrase filter ("lgtm", "done", ...)
 *  3. severity-aware dedupe: a repeat is dropped unless it escalates the severity
 *  4. per-review budget for non-blockers; a higher-severity note may displace a lower-severity pending one
 * Blockers are exempt from the budget.
 */

const CONTENT_FREE = new Set([
  "stop",
  "done",
  "complete",
  "completed",
  "ok",
  "okay",
  "fine",
  "good",
  "looks good",
  "all good",
  "lgtm",
  "no issue",
  "no issues",
  "no issue continue",
  "no issues continue",
  "no concerns",
  "nothing to add",
  "nothing to report",
  "nothing further",
  "continue",
  "proceed",
  "carry on",
])

const HISTORY_CAP = 4096

export type AdmitStatus = "accepted" | "duplicate" | "noise" | "budget"

export interface AdmitResult {
  status: AdmitStatus
  /** A pending, lower-ranked note that was displaced to make room. */
  displaced?: Note
}

export class EmissionGuard {
  private history = new Map<string, number>() // normalized -> highest severity rank seen
  private pending: Note[] = [] // non-blocker notes admitted in the current review

  constructor(private maxNotes: number) {}

  setMaxNotes(n: number): void {
    this.maxNotes = Math.max(1, Math.min(32, Math.floor(n)))
  }

  /** Start a new review: previous pending notes have been routed and keep their history entries. */
  beginReview(): void {
    this.pending = []
  }

  reset(): void {
    this.history.clear()
    this.pending = []
  }

  admit(note: Note): AdmitResult {
    const key = normalizeNote(note.text)
    if (key === "" || CONTENT_FREE.has(key)) return { status: "noise" }

    const rank = SEVERITY_RANK[note.severity]
    const seen = this.history.get(key)
    if (seen !== undefined && seen >= rank) return { status: "duplicate" }

    if (note.severity === "blocker") {
      this.remember(key, rank)
      return { status: "accepted" }
    }

    // An escalation of a note already pending in this review replaces it instead of occupying a second slot.
    const same = this.pending.findIndex((n) => normalizeNote(n.text) === key)
    if (same >= 0) {
      this.pending[same] = note
      this.remember(key, rank)
      return { status: "accepted" }
    }

    if (this.pending.length < this.maxNotes) {
      this.pending.push(note)
      this.remember(key, rank)
      return { status: "accepted" }
    }

    // At capacity: displace the lowest-rank pending note if the new one outranks it.
    let lowestIdx = 0
    for (let i = 1; i < this.pending.length; i++) {
      if (SEVERITY_RANK[this.pending[i]!.severity] < SEVERITY_RANK[this.pending[lowestIdx]!.severity]) lowestIdx = i
    }
    const lowest = this.pending[lowestIdx]!
    if (SEVERITY_RANK[lowest.severity] < rank) {
      this.pending.splice(lowestIdx, 1, note)
      this.history.delete(normalizeNote(lowest.text))
      this.remember(key, rank)
      return { status: "accepted", displaced: lowest }
    }
    return { status: "budget" }
  }

  /** Non-blocker notes currently admitted for this review (after any displacement). */
  pendingNotes(): readonly Note[] {
    return this.pending
  }

  private remember(key: string, rank: number): void {
    const prev = this.history.get(key)
    this.history.delete(key) // refresh FIFO position
    this.history.set(key, Math.max(rank, prev ?? 0))
    if (this.history.size > HISTORY_CAP) {
      const oldest = this.history.keys().next().value
      if (oldest !== undefined) this.history.delete(oldest)
    }
  }
}

export function isSeverity(s: unknown): s is Severity {
  return s === "nit" || s === "concern" || s === "blocker"
}
