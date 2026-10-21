import type { LoopVerdict } from "./loopguard.ts"
import { ADVISOR_TITLE_PREFIX, type Note } from "./types.ts"

/** One in-flight advisor review; the `advise` tool finds it through the advisor's own session id. */
export interface ReviewCtx {
  advisorSessionID: string
  reviewId: number
  final: boolean
  /** The transcript text the advisor was shown (used by the safety screen's quoting exemption). */
  input: string
  /** Notes accepted so far in this review (after any displacement). */
  notes: Note[]
  quarantined: number
  handleAdvise(args: { note: string; severity?: string }): string
  /** Called before each investigative tool call of the advisor; says whether it is a harmless call, a repeat to warn about, or one that ends the review. */
  onToolCall(tool: string, args: unknown): LoopVerdict
}

export interface UsageSink {
  recordUsage(info: { id: string; cost?: number; tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } } }): void
  onRetryStatus(status: { attempt: number; message: string; next: number }): void
  shouldStopRetrying(r: { attempt: number; message: string; waitMs: number }): boolean
}

export interface SessionMeta {
  parentID?: string | undefined
  title?: string | undefined
}

/** Process-wide bookkeeping shared by the runtimes, the `advise` tool and the event dispatcher. */
export class Registry {
  /** advisor session id -> its active review (only while a review is running) */
  readonly reviews = new Map<string, ReviewCtx>()
  /** every session id known to be one of our advisor sessions */
  readonly advisorSessions = new Set<string>()
  /** advisor session id -> the runtime that owns it (cost accounting) */
  readonly owners = new Map<string, UsageSink>()
  readonly meta = new Map<string, SessionMeta>()
  /** set by `/advisor on`: anything created before this instant is never replayed to a new runtime */
  enabledAt: number | undefined
  /** sessions created while this process was running: their whole history is ours to review */
  readonly fresh = new Set<string>()

  isAdvisorSession(id: string | undefined): boolean {
    if (!id) return false
    if (this.advisorSessions.has(id)) return true
    return this.meta.get(id)?.title?.startsWith(ADVISOR_TITLE_PREFIX) === true
  }

  noteSession(id: string, info: SessionMeta): void {
    this.meta.set(id, { parentID: info.parentID, title: info.title })
    if (info.title?.startsWith(ADVISOR_TITLE_PREFIX)) this.advisorSessions.add(id)
  }
}
