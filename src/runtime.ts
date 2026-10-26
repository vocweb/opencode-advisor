import type { AdvisorConfig, AdvisorSpec, SyncBacklog } from "./config.ts"
import { computeDelta, currentTurnCursor, cursorBefore, tailCursor } from "./delta.ts"
import type { Delivery } from "./delivery.ts"
import { classifyFailure, ModelChain } from "./fallback.ts"
import type { Host, Logger, PromptResult } from "./host.ts"
import { EmissionGuard, isSeverity } from "./guard.ts"
import { buildUpdatePrompt } from "./prompts.ts"
import type { Registry, ReviewCtx } from "./registry.ts"
import { isSelfMessage, renderDelta, type RenderOptions } from "./render.ts"
import { LoopGuard } from "./loopguard.ts"
import { screenNote } from "./safety.ts"
import { ADVISOR_TITLE_PREFIX, type ModelRef, type Msg, type Note, type Severity } from "./types.ts"
import { clip, errMessage, parseModelSelector, sleep } from "./util.ts"

export type RuntimeStatus = "idle" | "reviewing" | "paused" | "no_model" | "failed" | "quota_paused"

export interface RuntimeDeps {
  host: Host
  cfg: AdvisorConfig
  spec: AdvisorSpec
  registry: Registry
  delivery: Delivery
  log: Logger
  primaryID: string
  agentName: string
}

export interface RuntimeStats {
  reviews: number
  notes: Record<Severity, number>
  rejected: number
  quarantined: number
  tokensIn: number
  tokensOut: number
  cost: number
  failures: number
  /** Times the advisor session was summarized instead of rebuilt (over budget). */
  compactions: number
  // 直近レビュー後の advisor 文脈の token 数 (status 表示用)。
  // Số token trong ngữ cảnh advisor sau review gần nhất (hiển thị ở status).
  contextTokens: number
}

// バッチを破棄するまでの試行回数 (バックオフ付き)。
// Số lần thử mỗi batch trước khi bỏ batch (có backoff).
// "[advisor] Name #2" から advisor 名を取り出す。
// Lấy tên advisor từ "[advisor] Name #2".
const advisorTitleName = (title: string): string => title.slice(ADVISOR_TITLE_PREFIX.length).trim().replace(/ #\d+$/, "")

const MAX_ATTEMPTS = 3
// モデルが見つからないときの再試行間隔。カタログに後から現れる場合に備え、頻繁に叩かない。
// Khoảng chờ trước khi thử lại khi chưa thấy model; phòng khi nó xuất hiện muộn trong danh mục nhưng cũng không gọi dồn dập.
const NO_MODEL_RETRY_MS = 30_000
const SYNC_WAIT_CAP_MS = 30_000
// プロバイダのエラー名を保持し、利用上限や拒否を分類できるようにする。
// Giữ tên lỗi của provider để phân loại (usage limit, refusal, ...).
/** The review was stopped by the loop guard: not a failure, so it neither counts toward halting nor triggers a fallback. */
class LoopStopped extends Error {}

class ReviewError extends Error {
  constructor(
    message: string,
    readonly errName: string,
    readonly permanent: boolean,
  ) {
    super(message)
  }
}


/**
 * One advisor watching one primary session.
 *
 * It owns a persistent, append-only advisor session (a child of the primary) so the reviewer accumulates
 * context turn after turn. Updates are coalesced: while a review is running, further updates only mark the
 * runtime dirty and the next review covers everything since the cursor.
 */
export class AdvisorRuntime {
  lastError: string | undefined
  advisorSessionID: string | undefined
  readonly stats: RuntimeStats = {
    reviews: 0,
    notes: { nit: 0, concern: 0, blocker: 0 },
    rejected: 0,
    quarantined: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    failures: 0,
    compactions: 0,
    contextTokens: 0,
  }
  readonly chain: ModelChain

  private _status: RuntimeStatus = "idle"
  private cursor: string | undefined
  // 失敗でバッチを破棄するとき、ここまで進めて次回に重複させないため。
  // Con trỏ mà batch hiện tại sẽ tiến tới, dùng khi bỏ batch sau nhiều lần lỗi.
  private batchCursor: string | undefined
  private seeded = false
  private needsReprime = false
  private reprimed = false
  private dirty = false
  private pendingFinal = false
  private seen = 0
  private finalSeen = 0
  // 予約済みだがまだレビューが終わっていない更新数。syncBacklog の待機条件に使う。
  // Số update đã lên lịch mà chưa review xong, dùng làm điều kiện chờ của syncBacklog.
  private backlog = 0
  private waiters = new Set<() => void>()
  private holding = 0
  private holdingSince: number | undefined
  private running: Promise<void> | undefined
  private paused = false
  private disposed = false
  private reviewSeq = 0
  private generation = 0
  private noteSeq = 0
  private droppedCycles = 0
  private quarantineStreak = 0
  private warnedNoModel = false
  private sessionReviews = 0
  /** No usable model configured: nothing to do until the configuration changes (needs a restart). */
  private dormant = false
  private deferred: Note[] = []
  private usageSeen = new Set<string>()
  private abort: AbortController | undefined
  private retryAbort: string | undefined
  private loopStopped = false
  private overBudget = false
  /** After a model-not-found failure: do not try again before this time (the model may show up in the catalog later). */
  private noModelRetryAt = 0
  private warnedModelMissing = false
  private readonly guard: EmissionGuard

  constructor(private deps: RuntimeDeps) {
    this.guard = new EmissionGuard(deps.spec.maxNotesPerUpdate)
    this.chain = new ModelChain(deps.cfg.retry, () => this.deps.spec.model ?? "inherit")
  }

  get status(): RuntimeStatus {
    return this._status
  }
  set status(v: RuntimeStatus) {
    this._status = v
    this.wake()
  }

  get spec(): AdvisorSpec {
    return this.deps.spec
  }
  get primaryID(): string {
    return this.deps.primaryID
  }
  get pendingDeferred(): number {
    return this.deferred.length
  }
  get isRunning(): boolean {
    return this.running !== undefined
  }

  // ------------------------------------------------------------------ control

  /** A primary update is available. `final` marks an end-of-run boundary. */
  notify(final: boolean): void {
    if (this.disposed || this.dormant || this.status === "failed" || this.status === "quota_paused") return
    const { reviewMode, reviewInterval } = this.deps.spec
    let due: boolean
    if (reviewMode === "agent-end") {
      if (!final) return
      due = ++this.finalSeen % reviewInterval === 0
    } else {
      due = ++this.seen % reviewInterval === 0
    }
    if (!due) {
      // 間引かれた境界でも、保留中のノートは最終境界で配信する。レビューは走らせない。
      // Ranh giới bị bỏ qua vẫn phải xả các note đang hoãn ở final; chỉ không chạy review.
      // delta はカーソルに残るので、次のレビューがまとめて扱う。
      // Delta vẫn nằm sau con trỏ nên review kế tiếp sẽ xử lý.
      if (final) this.deliverNotes([], true)
      return
    }
    this.pendingFinal = this.pendingFinal || final
    this.dirty = true
    this.backlog++
    this.kick()
  }

  pause(): void {
    this.paused = true
    if (this.status === "idle") this.status = "paused"
  }

  resume(): void {
    this.paused = false
    if (this.status === "paused") this.status = "idle"
    if (this.status === "failed" || this.status === "quota_paused") return
    if (this.dirty) this.kick()
  }

  /** Forget the advisor's context and failure state; the next review re-primes from the recent transcript. */
  reset(): void {
    this.needsReprime = true
    this.retryAbort = undefined
    this.droppedCycles = 0
    this.quarantineStreak = 0
    this.lastError = undefined
    this.deferred = []
    this.backlog = 0
    this.chain.onReset()
    if (this.status === "failed" || this.status === "no_model" || this.status === "quota_paused") this.status = this.paused ? "paused" : "idle"
    this.warnedNoModel = false
    this.warnedModelMissing = false
    this.noModelRetryAt = 0
    this.dormant = false
    this.wake()
    // クォータ枯渇中に保持したバッチをここで再試行する。
    // Batch được giữ lại lúc hết quota sẽ được thử lại ngay bây giờ.
    if (this.dirty && !this.paused) this.kick()
  }

  dispose(): void {
    this.disposed = true
    this.retryAbort = undefined
    this.abort?.abort()
    this.wake()
    const id = this.advisorSessionID
    if (id) this.deps.host.abort(id).catch(() => {})
  }

  private wake(): void {
    for (const w of [...this.waiters]) w()
  }

  // 主エージェントの次の LLM 呼び出しを待たせる。abort・停止状態・reset/dispose で即解放し、strict 以外は 30 秒で諦める。
  // Giữ lần gọi LLM kế của primary chờ advisor; thả ngay khi abort, trạng thái dừng, reset/dispose, và bỏ chờ sau 30 s trừ strict.
  async waitCaughtUp(policy: SyncBacklog, signal: AbortSignal): Promise<void> {
    if (policy === "off") return
    const threshold = policy === "strict" ? 1 : policy
    const deadline = policy === "strict" ? Infinity : Date.now() + SYNC_WAIT_CAP_MS
    const stuck = () => this.disposed || this.dormant || this.paused || this.status === "failed" || this.status === "quota_paused" || this.status === "no_model" || this.status === "paused"
    // /advisor status が「primary はこの advisor を待っている」と言えるよう、待ち始めの時刻を持つ。
    // Giữ thời điểm bắt đầu chờ để /advisor status báo được primary đang chờ advisor này.
    this.holding++
    this.holdingSince ??= Date.now()
    try {
      while (this.backlog >= threshold && !stuck() && !signal.aborted) {
        const left = deadline - Date.now()
        if (left <= 0) return
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            this.waiters.delete(done)
            signal.removeEventListener("abort", done)
            resolve()
          }
          const timer = setTimeout(done, Math.min(left, 2 ** 30))
          this.waiters.add(done)
          signal.addEventListener("abort", done, { once: true })
        })
      }
    } finally {
      if (--this.holding === 0) this.holdingSince = undefined
    }
  }

  /** Milliseconds the primary has been held back by this advisor, or undefined when it is not waiting. */
  heldForMs(): number | undefined {
    return this.holdingSince === undefined ? undefined : Date.now() - this.holdingSince
  }

  // opencode は 429/5xx を自分で再試行し続け、prompt が戻らない。待つ価値がなければここで中断して fallback に回す。
  // opencode tự retry 429/5xx mãi nên prompt không trả về; nếu chờ không đáng thì ngắt ở đây để chuyển sang fallback.
  onRetryStatus(status: { attempt: number; message: string; next: number }): void {
    if (!this.abort || this.retryAbort !== undefined || !this.advisorSessionID) return
    if (!this.shouldStopRetrying({ attempt: status.attempt, message: status.message, waitMs: status.next - Date.now() })) return
    this.retryAbort = status.message
    this.deps.host.abort(this.advisorSessionID).catch(() => {})
  }

  // provider の再試行を打ち切るべきか。fallback に移れる、待ち時間が長すぎる、試行回数が多すぎる、のどれか。
  // Có nên dừng việc provider retry không: khi chuyển được sang fallback, chờ quá lâu, hoặc đã thử quá nhiều lần.
  shouldStopRetrying(r: { attempt: number; message: string; waitMs: number }): boolean {
    const maxDelay = this.deps.cfg.retry.maxDelayMs
    const tooLong = maxDelay > 0 && r.waitMs > maxDelay
    return this.chain.wouldSwitch(classifyFailure("", r.message)) || tooLong || r.attempt > MAX_ATTEMPTS
  }

  /** Account cost/tokens of an advisor assistant message (called from the event stream). */
  recordUsage(info: { id: string; cost?: number; tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } } }): void {
    if (this.usageSeen.has(info.id)) return
    this.usageSeen.add(info.id)
    this.stats.cost += info.cost ?? 0
    this.stats.tokensIn += (info.tokens?.input ?? 0) + (info.tokens?.cache?.read ?? 0) + (info.tokens?.cache?.write ?? 0)
    this.stats.tokensOut += (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
  }

  // ------------------------------------------------------------------ the advise tool

  /** Called by the `advise` tool while a review is running. Returns the acknowledgement the advisor sees. */
  handleAdvise(ctx: ReviewCtx, args: { note: string; severity?: string }): string {
    const text = String(args.note ?? "").trim()
    const severity: Severity = isSeverity(args.severity) ? args.severity : "nit"
    if (!text) return "Rejected: the note is empty."

    const verdict = screenNote(text, ctx.input)
    if (!verdict.ok) {
      ctx.quarantined++
      this.stats.quarantined++
      return `Rejected by the safety filter (${verdict.reasons.join(", ")}). Do not rephrase and resend it.`
    }

    const note: Note = {
      id: ++this.noteSeq,
      advisor: this.spec.name,
      severity,
      text,
      createdAt: Date.now(),
      reviewId: ctx.reviewId,
      turn: this.deps.delivery.turnCount(this.deps.primaryID),
    }
    const r = this.guard.admit(note)
    switch (r.status) {
      case "noise":
        this.stats.rejected++
        return "Suppressed: content-free note. Only send concrete findings."
      case "duplicate":
        this.stats.rejected++
        return "Duplicate: you already raised this at the same or a higher severity."
      case "budget":
        this.stats.rejected++
        return `Over budget: at most ${this.spec.maxNotesPerUpdate} non-blocker notes per update, and this one does not outrank the pending ones. Blockers are still accepted.`
      case "accepted":
        break
    }
    if (r.displaced) {
      const i = ctx.notes.findIndex((n) => n.id === r.displaced!.id)
      if (i >= 0) ctx.notes.splice(i, 1)
      this.stats.notes[r.displaced.severity]--
    }
    ctx.notes.push(note)
    this.stats.notes[severity]++
    if (severity === "concern" && !ctx.final) {
      return "Accepted, held until the primary's run reaches a final boundary (a higher-severity note from this review may displace it)."
    }
    return "Accepted."
  }

  // ------------------------------------------------------------------ scheduling

  private kick(): void {
    if (this.running || this.paused || this.disposed) return
    if (this.status === "no_model" && Date.now() < this.noModelRetryAt) return
    this.running = this.drain().finally(() => {
      this.running = undefined
      // A notify() may have raced with the end of the loop.
      if (this.dirty && !this.paused && !this.disposed && this.status !== "failed" && this.status !== "quota_paused") this.kick()
    })
  }

  /** Resolves when no review is running (used by tests and /advisor reset). */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  private halted(): boolean {
    return this.status === "failed" || this.status === "quota_paused"
  }

  private async drain(): Promise<void> {
    // モデルが見つからない間は次の再試行時刻まで回さない。回すと失敗するレビューを即座に繰り返してしまう。
    // Khi chưa thấy model thì không chạy lại cho tới giờ thử lại kế tiếp; nếu không sẽ lặp ngay một review đang thất bại.
    while (this.dirty && !this.disposed && !this.paused && !this.halted() && Date.now() >= this.noModelRetryAt) {
      this.dirty = false
      const final = this.pendingFinal
      this.pendingFinal = false
      this.status = "reviewing"
      const covered = this.backlog
      await this.runBatch(final, covered)
    }
    if (this.status === "reviewing") this.status = this.paused ? "paused" : "idle"
  }

  // 1 バッチをレビューする。モデル切替は即再試行し、試行回数に数えない。
  // Review một batch; chuyển model thì thử lại ngay và không tính vào số lần thử.
  private async runBatch(final: boolean, covered: number): Promise<void> {
    // 切替の連続回数に上限を設ける。想定外の状態でも API を叩き続けないための保険。
    // Giới hạn số lần chuyển model liên tiếp; phòng khi trạng thái bất ngờ khiến ta gọi API mãi.
    let switches = 0
    for (let attempt = 1; ; attempt++) {
      try {
        this.batchCursor = undefined
        await this.review(final)
        this.backlog = Math.max(0, this.backlog - covered)
        if (this.status === "reviewing") this.status = this.paused ? "paused" : "idle"
        this.wake()
        return
      } catch (e) {
        if (this.disposed) return
        if (e instanceof LoopStopped) {
          // 失敗として数えず、fallback にも回さない。この batch は諦めて次の update から新しい review を始める。
          // Không tính là lỗi và không chuyển fallback; bỏ batch này và để update kế tiếp bắt đầu review mới.
          this.deps.log("warn", "advisor review stopped by the loop guard", { advisor: this.spec.name })
          this.needsReprime = true
          this.dropBatch(covered)
          if (this.status === "reviewing") this.status = this.paused ? "paused" : "idle"
          return
        }
        const { cfg, log } = this.deps
        this.stats.failures++
        this.lastError = errMessage(e)
        this.needsReprime = true // we cannot know what the advisor session absorbed
        const permanent = e instanceof ReviewError && e.permanent
        let kind = classifyFailure(e instanceof ReviewError ? e.errName : "", this.lastError)
        // opencode v1 はモデル不明を「Unexpected server error」としか返さない。カタログを直接見て、無ければ no-model として扱う。
        // opencode v1 chỉ trả "Unexpected server error" khi model không tồn tại; tra thẳng danh mục và nếu không có thì coi là no-model.
        if (kind === "other") {
          const cur = parseModelSelector(this.chain.current())
          if (cur && (await this.deps.host.modelAvailable?.(cur.ref)) === false) kind = "no-model"
        }
        const outcome = this.chain.onFailure(kind)
        log("warn", "advisor review failed", { advisor: this.spec.name, error: this.lastError, attempt, kind, outcome, model: this.chain.current() })
        if (kind === "no-model" && outcome !== "switched") {
          // モデルがまだ見つからない。halted にはせず、バッチを保持して一定時間後の次の境界で再試行する。
          // Chưa tìm thấy model: không halt, giữ batch và thử lại ở ranh giới kế tiếp sau một khoảng thời gian.
          this.dirty = true
          this.pendingFinal = this.pendingFinal || final
          this.status = "no_model"
          this.noModelRetryAt = Date.now() + NO_MODEL_RETRY_MS
          if (!this.warnedModelMissing) {
            this.warnedModelMissing = true
            this.toast(`Advisor "${this.spec.name}": model ${this.chain.current() ?? "?"} was not found. It will be tried again at a later boundary, or run /advisor setup <provider/model>.`, "warning")
          }
          return
        }
        if (outcome === "exhausted") {
          // 使用量上限: バッチは捨てずに保持し、/advisor reset まで止める。
          // Hết quota: giữ nguyên batch, dừng đến khi /advisor reset.
          this.dirty = true
          this.pendingFinal = this.pendingFinal || final
          this.status = "quota_paused"
          this.toast(`Advisor "${this.spec.name}" paused: usage limit reached on every configured model. Use /advisor reset once it recovers.`, "warning")
          return
        }
        if (outcome === "switched" && ++switches <= this.chain.chain().length) {
          attempt--
          continue
        }
        if (permanent || attempt >= MAX_ATTEMPTS) {
          this.dropBatch(covered)
          this.droppedCycles++
          if (permanent || this.droppedCycles >= cfg.maxConsecutiveFailures) {
            this.status = "failed"
            log("error", "advisor halted after repeated failures; /advisor reset to retry", { advisor: this.spec.name, error: this.lastError })
            this.toast(`Advisor "${this.spec.name}" halted: ${clip(this.lastError ?? "", 160)}. Use /advisor reset to retry.`, "error")
          } else this.status = "idle"
          return
        }
        await sleep(Math.min(30_000, 1_500 * 2 ** (attempt - 1)))
        if (this.disposed) return
      }
    }
  }

  // 現在のバッチを諦め、次のレビューはその後から始める。
  // Bỏ batch hiện tại; review kế tiếp bắt đầu sau nó.
  private dropBatch(covered: number): void {
    if (this.batchCursor !== undefined) this.cursor = this.batchCursor
    this.backlog = Math.max(0, this.backlog - covered)
    this.wake()
  }

  // ------------------------------------------------------------------ the review itself

  private ropts(): RenderOptions {
    const c = this.deps.cfg
    return {
      maxMessageChars: c.maxMessageChars,
      maxToolInputChars: c.maxToolInputChars,
      maxToolOutputChars: c.maxToolOutputChars,
      maxEditChars: c.maxEditChars,
      includeReasoning: c.includeReasoning,
    }
  }

  private resolveModel(msgs: Msg[]): { ref: ModelRef; level?: string } | undefined {
    const m = this.chain.current()
    if (!m) return undefined
    if (m === "inherit") {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const x = msgs[i]!
        if (x.info.role === "user" && !isSelfMessage(x)) return x.info.model ? { ref: x.info.model } : undefined
      }
      return undefined
    }
    const sel = parseModelSelector(m)
    // ":auto" は primary が直近に使っていた思考レベルに合わせる。分からなければ指定なし (モデルの既定) にする。
    // ":auto" theo mức suy luận primary vừa dùng; nếu không biết thì không chỉ định (dùng mặc định của model).
    if (sel?.level === "auto") {
      const { level: _auto, ...rest } = sel
      for (let i = msgs.length - 1; i >= 0; i--) {
        const v = msgs[i]!.info.variant
        if (v) return { ...rest, level: v }
      }
      return rest
    }
    return sel
  }

  private async fetchMessages(): Promise<Msg[]> {
    const { host, cfg, primaryID } = this.deps
    return host.transcript(primaryID, cfg.fetchLimit)
  }

  private async ensureSession(): Promise<string> {
    if (this.advisorSessionID) return this.advisorSessionID
    const { host, registry, primaryID } = this.deps
    // 再起動後に同じ primary を引き継いだときは、前回の advisor session を使い続ける。新しく作ると同名の子 session が増え、文脈と費用の記録も途切れる。
    // Khi tiếp quản cùng một primary sau khi khởi động lại thì dùng tiếp session advisor cũ; tạo mới sẽ làm số session con trùng tên tăng lên và đứt mạch ngữ cảnh lẫn chi phí.
    if (this.generation === 0 && !registry.fresh.has(primaryID)) {
      const kids = await host.advisorChildren(primaryID).catch(() => [])
      const last = kids.filter((k) => advisorTitleName(k.title) === this.spec.name).at(-1)
      if (last) {
        this.generation = Number(/ #(\d+)$/.exec(last.title)?.[1] ?? 1)
        registry.advisorSessions.add(last.id)
        registry.owners.set(last.id, this)
        registry.meta.set(last.id, { parentID: primaryID, title: last.title })
        this.advisorSessionID = last.id
        this.sessionReviews = 1 // 履歴の長さは分からないので、予算超過の判定は次の review から
        this.deps.log("info", "continuing the advisor session from before the restart", { advisor: this.spec.name, session: last.id })
        return last.id
      }
    }
    this.generation++
    const title = `${ADVISOR_TITLE_PREFIX} ${this.spec.name}${this.generation > 1 ? ` #${this.generation}` : ""}`
    const id = await host.createAdvisorSession({ parentID: primaryID, title, name: this.spec.name, agent: this.deps.agentName })
    registry.advisorSessions.add(id)
    registry.owners.set(id, this)
    registry.meta.set(id, { parentID: primaryID, title })
    this.advisorSessionID = id
    return id
  }

  private async review(final: boolean): Promise<void> {
    const { host, cfg, registry, log, primaryID } = this.deps
    // 前回の中断フラグが残らないように、毎回の review の先頭で消す。
    // Xóa cờ ngắt của lần trước ở đầu mỗi review để nó không bị sót sang lần này.
    this.retryAbort = undefined
    const msgs = await this.fetchMessages()

    const model = this.resolveModel(msgs)
    if (!model) {
      this.status = "no_model"
      // model 未設定は inherit と同じ扱い。primary の最初のメッセージが来るまでの一時的な no_model なので休眠させない。
      // Chưa đặt model được coi như inherit; chỉ là no_model tạm thời tới khi có message đầu của primary nên không cho ngủ.
      if (this.spec.model && this.spec.model !== "inherit") this.dormant = true
      if (this.dormant && !this.warnedNoModel) {
        this.warnedNoModel = true
        const why = `cannot parse model "${this.spec.model}" (expected "provider/model")`
        log("warn", `advisor "${this.spec.name}" is dormant: ${why}`)
        this.toast(`Advisor "${this.spec.name}" is dormant: ${why}. Run /advisor setup <provider/model>, or set "modelRoles.advisor" in WATCHDOG.yml.`, "warning")
      }
      return
    }
    // 予算超過だけが原因なら、まず今の session を要約して続ける (omp と同じ順序)。失敗したら作り直す。他の原因 (失敗後) は常に作り直す。
    // Nếu chỉ vì vượt ngân sách thì thử tóm tắt chính session hiện tại trước (đúng thứ tự của omp); thất bại mới dựng lại. Nguyên nhân khác (sau lỗi) luôn dựng lại.
    if (this.needsReprime && this.overBudget && this.advisorSessionID && host.compactAdvisor) {
      this.overBudget = false
      if (await host.compactAdvisor(this.advisorSessionID, model.ref)) {
        this.needsReprime = false
        this.sessionReviews = 0
        this.stats.compactions++
        log("info", "advisor session summarized instead of rebuilt", { advisor: this.spec.name })
      }
    }
    this.overBudget = false
    if (this.needsReprime) {
      this.needsReprime = false
      this.sessionReviews = 0
      this.advisorSessionID = undefined // a fresh child session; the old one stays for inspection
      this.guard.reset()
      this.cursor = tailCursor(msgs, cfg.primeMessages)
      this.seeded = true
      this.reprimed = true
    } else if (!this.seeded) {
      this.seeded = true
      if (this.cursor === undefined && !registry.fresh.has(primaryID)) {
        // Resumed session: review the turn in progress. After `/advisor on`: review only what happened since.
        this.cursor = registry.enabledAt !== undefined ? cursorBefore(msgs, registry.enabledAt) : currentTurnCursor(msgs)
      }
    }

    const delta = computeDelta(msgs, this.cursor, cfg.fetchLimit)
    this.batchCursor = delta.cursor
    let transcript = renderDelta(delta.items, this.ropts())
    if (!transcript.trim()) {
      // Nothing reviewable (only our own messages, or nothing new): still honour a final boundary.
      this.cursor = delta.cursor ?? this.cursor
      if (final) this.deliverNotes([], true)
      return
    }
    if (transcript.length > cfg.primeChars) transcript = `…[earlier part of this update omitted]…\n${transcript.slice(-cfg.primeChars)}`

    const advisorSession = await this.ensureSession()
    const reviewId = ++this.reviewSeq
    this.guard.beginReview()
    const loop = new LoopGuard()
    this.loopStopped = false
    const ctx: ReviewCtx = {
      advisorSessionID: advisorSession,
      reviewId,
      final,
      input: transcript,
      notes: [],
      quarantined: 0,
      handleAdvise: (args) => this.handleAdvise(ctx, args),
      onToolCall: (tool, args) => {
        const verdict = loop.observe(tool, args)
        if (verdict === "abort" && !this.loopStopped) {
          this.loopStopped = true
          host.abort(advisorSession).catch(() => {})
        }
        return verdict
      },
    }
    registry.reviews.set(advisorSession, ctx)

    const text = buildUpdatePrompt({ reviewId, final, transcript, gap: delta.gap, reprimed: this.reprimed })
    const ac = new AbortController()
    this.abort = ac
    const timer = setTimeout(() => {
      ac.abort()
      host.abort(advisorSession).catch(() => {})
    }, cfg.reviewTimeoutMs)

    let result: PromptResult
    try {
      result = await host.promptAdvisor(advisorSession, { agent: this.deps.agentName, model: model.ref, ...(model.level ? { level: model.level } : {}), text, signal: ac.signal })
    } finally {
      clearTimeout(timer)
      this.abort = undefined
      registry.reviews.delete(advisorSession)
    }
    const retryWhy = this.retryAbort
    this.retryAbort = undefined
    if (this.disposed) return
    // ループ検知で止めた review は失敗ではない。中断された prompt の error は無視して、専用の例外で runBatch に伝える。
    // Review bị loop guard dừng không phải thất bại; bỏ qua error của prompt bị ngắt và báo cho runBatch bằng một ngoại lệ riêng.
    if (this.loopStopped) {
      this.loopStopped = false
      throw new LoopStopped()
    }
    // 中断した prompt は error なしで戻ることがある。成功と取り違えないよう先に失敗として扱う。
    // prompt bị ngắt có thể trả về mà không có error; phải coi là thất bại trước, kẻo nhầm với thành công.
    if (retryWhy !== undefined) throw new ReviewError(`provider kept failing and was not worth waiting for: ${retryWhy}`, "ProviderRetry", false)
    if (result.error) {
      const { name, message, permanent } = result.error
      if (name === "MessageAbortedError") throw new Error(`advisor review timed out after ${cfg.reviewTimeoutMs}ms or was aborted`)
      throw new ReviewError(`${name}: ${message}`.trim(), name, permanent === true)
    }

    // Success: the advisor has absorbed this delta.
    this.cursor = delta.cursor ?? this.cursor
    this.reprimed = false
    this.droppedCycles = 0
    this.lastError = undefined
    this.stats.reviews++
    this.recordUsage({ id: result.id ?? `r${reviewId}`, cost: result.cost, tokens: result.tokens })

    this.quarantineStreak = ctx.quarantined > 0 ? this.quarantineStreak + 1 : 0
    if (this.quarantineStreak >= 2) {
      this.quarantineStreak = 0
      this.needsReprime = true
      log("warn", "advisor output quarantined twice in a row; resetting its context", { advisor: this.spec.name })
      this.toast(`Advisor "${this.spec.name}" produced unsafe output twice; its context was reset and the batch dropped.`, "warning")
      return
    }

    // Keep the advisor's own context bounded: re-prime on the next review once it grows too large.
    const t = result.tokens
    const ctxTokens = (t?.input ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0) + (t?.output ?? 0)
    this.stats.contextTokens = ctxTokens
    this.sessionReviews++
    // A session whose very first review already exceeds the budget would just be re-created forever; only re-prime sessions that grew.
    if (ctxTokens > cfg.contextTokenBudget && this.sessionReviews >= 2) {
      this.needsReprime = true
      this.overBudget = true
      log("info", "advisor context over budget; will summarize or re-prime", { advisor: this.spec.name, tokens: ctxTokens })
    }

    this.deliverNotes(ctx.notes, final)
  }

  /** Route the notes of a finished review (plus anything deferred earlier when this is a final boundary). */
  private deliverNotes(fresh: Note[], final: boolean): void {
    const { delivery, log, primaryID } = this.deps
    const batch = final ? [...this.deferred, ...fresh] : fresh
    if (final) this.deferred = []
    if (batch.length === 0) return
    try {
      this.deferred.push(...delivery.submit(primaryID, batch, { final }))
    } catch (e) {
      log("warn", "advisory delivery failed", { advisor: this.spec.name, error: errMessage(e) })
    }
  }

  private toast(message: string, variant: "info" | "warning" | "error"): void {
    if (!this.deps.cfg.toast) return
    this.deps.host.toast(message, variant, undefined, this.deps.primaryID)
  }
}
