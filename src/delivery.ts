import type { AdvisorConfig } from "./config.ts"
import { renderAdvisories } from "./prompts.ts"
import { decideRoute, type Route } from "./route.ts"
import { isSelfMessage } from "./render.ts"
import { SELF_MARK, SEVERITY_RANK, type Client, type ModelRef, type Msg, type Note } from "./types.ts"
import { clip, errMessage } from "./util.ts"

export type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

export function unwrap<T = any>(res: any): T {
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error(errMessage(res.error))
  if (res && typeof res === "object" && "data" in res) return res.data as T
  return res as T
}

interface Pending {
  note: Note
  final: boolean
}

interface SessionState {
  busy: boolean
  suppressed: boolean
  immuneLeft: number
  steers: number
  lastFinish: string | undefined
  asides: Note[]
  inbox: Note[]
  // 完了した主ターン数。ノートに刻み、古い助言だと分かるようにする。
  // Số lượt primary đã xong, đóng dấu lên note để biết advisory cũ.
  turns: number
  pending: Pending[]
  timer: NodeJS.Timeout | undefined
  // 最後に起こした時刻。busy になるまで次の wake は注入に格下げする。
  // Thời điểm wake gần nhất; tới khi primary busy thì wake kế bị hạ thành inject.
  wakeAt: number
  // 助言が起動したターン。advisor に再度見せないための印。
  // Lượt chạy do advisory khởi động; đánh dấu để không đưa ngược lại cho advisor.
  continuation: boolean
  lastGuidanceTurn: number | undefined
  abort: AbortController
}

export interface RouteContext {
  final: boolean
}

const INBOX_CAP = 50
const RECHECK_MS = 1500
// この時間内に届いたノートを 1 バッチにまとめる (wake は最大 1 回)。
// Note đến trong khoảng này được gộp thành một batch (tối đa một wake).
const BATCH_MS = 250
const WAKE_WINDOW_MS = 5000
const GUIDANCE_EVERY_TURNS = 50

/**
 * Owns everything that happens *after* a note is accepted: choosing a channel (see route.ts) and using it.
 * State is per primary session.
 */
export class Delivery {
  private states = new Map<string, SessionState>()

  constructor(
    private client: Client,
    private cfg: AdvisorConfig,
    private log: Logger,
  ) {}

  private st(id: string): SessionState {
    let s = this.states.get(id)
    if (!s) {
      s = {
        busy: false,
        suppressed: false,
        immuneLeft: 0,
        steers: 0,
        lastFinish: undefined,
        asides: [],
        inbox: [],
        turns: 0,
        pending: [],
        timer: undefined,
        wakeAt: 0,
        continuation: false,
        lastGuidanceTurn: undefined,
        abort: new AbortController(),
      }
      this.states.set(id, s)
    }
    return s
  }

  // ---- signals from events/hooks

  setBusy(id: string, busy: boolean): void {
    const s = this.st(id)
    s.busy = busy
    if (busy) s.wakeAt = 0
  }
  isBusy(id: string): boolean {
    return this.st(id).busy
  }
  onTurnComplete(id: string, finish: string | undefined): void {
    const s = this.st(id)
    s.lastFinish = finish
    s.turns++
    if (s.immuneLeft > 0) s.immuneLeft--
  }
  turnCount(id: string): number {
    return this.st(id).turns
  }
  onAbort(id: string): void {
    const s = this.st(id)
    s.suppressed = true
    s.abort.abort()
  }
  onRealUserMessage(id: string): void {
    const s = this.st(id)
    s.suppressed = false
    s.steers = 0
    s.continuation = false
    if (s.abort.signal.aborted) s.abort = new AbortController()
  }
  // ユーザーが中断したら abort され、syncBacklog の待機が即座に終わる。
  // Bị abort khi người dùng ngắt, để chờ syncBacklog kết thúc ngay.
  abortSignal(id: string): AbortSignal {
    return this.st(id).abort.signal
  }
  forget(id: string): void {
    const s = this.states.get(id)
    if (s?.timer) clearTimeout(s.timer)
    this.states.delete(id)
  }
  isSuppressed(id: string): boolean {
    return this.st(id).suppressed
  }
  steersLeft(id: string): number {
    return this.cfg.maxSteersPerPrompt - this.st(id).steers
  }
  immuneLeft(id: string): number {
    return this.st(id).immuneLeft
  }
  isAdvisorContinuation(id: string): boolean {
    return this.states.get(id)?.continuation === true
  }
  endContinuation(id: string): void {
    const s = this.states.get(id)
    if (s) s.continuation = false
  }

  // guidance を付ける番か。付けたら記録して頻度を抑える。
  // Đến lượt gắn guidance chưa; gắn rồi thì ghi nhận để hạn chế tần suất.
  takeGuidance(id: string): boolean {
    const s = this.st(id)
    if (s.lastGuidanceTurn !== undefined && s.turns - s.lastGuidanceTurn < GUIDANCE_EVERY_TURNS) return false
    s.lastGuidanceTurn = s.turns
    return true
  }

  /** Notes waiting to ride along with the next primary LLM call. Drains the queue. */
  takeAsides(id: string): Note[] {
    const s = this.states.get(id)
    if (!s || s.asides.length === 0) return []
    const out = s.asides
    s.asides = []
    return out
  }
  putBackAsides(id: string, notes: Note[]): void {
    this.st(id).asides.unshift(...notes)
  }
  pendingAsides(id: string): number {
    return this.states.get(id)?.asides.length ?? 0
  }
  inbox(id: string): readonly Note[] {
    return this.states.get(id)?.inbox ?? []
  }

  // ---- routing

  /** Decide a channel for `note` without delivering it (exposed for tests). */
  plan(primaryID: string, note: Note, ctx: RouteContext, planMode = false): Route {
    const s = this.st(primaryID)
    return decideRoute({
      severity: note.severity,
      final: ctx.final,
      busy: s.busy,
      suppressed: s.suppressed || s.steers >= this.cfg.maxSteersPerPrompt,
      immuneLeft: s.immuneLeft,
      terminalAnswer: s.lastFinish === "stop",
      continueSeverity: this.cfg.continueSeverity,
      planMode,
    })
  }

  // 待機が必要なノートは返し、残りは他の advisor と BATCH_MS だけまとめて配送する。
  // Note phải chờ final được trả lại cho caller; phần còn lại gộp trong BATCH_MS cùng note của advisor khác.
  submit(primaryID: string, notes: Note[], ctx: RouteContext): Note[] {
    const s = this.st(primaryID)
    const deferred: Note[] = []
    for (const note of notes) {
      if (this.plan(primaryID, note, ctx) === "defer") deferred.push(note)
      else s.pending.push({ note, final: ctx.final })
    }
    if (s.pending.length > 0 && !s.timer) {
      s.timer = setTimeout(() => {
        s.timer = undefined
        void this.flush(primaryID).catch((e) => this.log("warn", "advisory delivery failed", { error: errMessage(e), session: primaryID }))
      }, BATCH_MS)
    }
    return deferred
  }

  // 終了時やテストで、キューを今すぐ配送する。
  // Giao ngay mọi thứ đang xếp hàng (khi tắt hoặc trong test).
  async drain(): Promise<void> {
    for (const [id, s] of this.states) {
      if (s.timer) clearTimeout(s.timer)
      s.timer = undefined
      await this.flush(id).catch((e) => this.log("warn", "advisory delivery failed", { error: errMessage(e), session: id }))
    }
  }

  private async flush(primaryID: string): Promise<void> {
    const s = this.st(primaryID)
    const items = s.pending.splice(0)
    if (items.length === 0) return
    const last = await this.lastUser(primaryID)
    const planMode = last?.agent === "plan"
    // 新しいターン、重大度、作成順で並べる。
    // Sắp xếp theo lượt mới nhất, rồi mức nghiêm trọng, rồi thứ tự tạo.
    items.sort((a, b) => b.note.turn - a.note.turn || SEVERITY_RANK[b.note.severity] - SEVERITY_RANK[a.note.severity] || a.note.id - b.note.id)
    const routed = items.map((i) => ({ note: i.note, route: this.plan(primaryID, i.note, { final: i.final }, planMode) }))

    const cards: Note[] = []
    const steer: { note: Note; route: Route }[] = []
    for (const r of routed) {
      s.inbox.push(r.note)
      if (s.inbox.length > INBOX_CAP) s.inbox.shift()
      if (r.route === "card") cards.push(r.note)
      else if (r.route === "steer-inject" || r.route === "steer-wake") steer.push(r)
      else s.asides.push(r.note) // aside, or a defer that raced with a state change
    }

    // カードを先に置けば、後で起こした wake の transcript に含まれる。
    // Đặt card trước để lượt wake sau đó thấy nó trong transcript.
    if (cards.length > 0) {
      await this.post(primaryID, cards, { noReply: true }, last)
      for (const n of cards) this.toast(n)
      this.log("info", "advisory delivered via card", { session: primaryID, count: cards.length })
    }
    if (steer.length === 0) return

    const top = steer.reduce((a, b) => (SEVERITY_RANK[b.note.severity] > SEVERITY_RANK[a.note.severity] ? b : a))
    // バッチごとに wake は 1 回。起動中の wake があれば追記だけにする。
    // Mỗi batch một wake; trong lúc wake đang khởi động thì chỉ nối thêm vào transcript.
    const wakeActive = s.wakeAt > 0 && Date.now() - s.wakeAt < WAKE_WINDOW_MS
    const route: Route = top.route === "steer-wake" && wakeActive ? "steer-inject" : top.route
    const notes = steer.map((x) => x.note)
    s.steers++
    s.immuneLeft = this.cfg.immuneTurns
    for (const n of notes) this.toast(n)
    if (route === "steer-inject") {
      const posted = await this.post(primaryID, notes, { noReply: true }, last)
      // The run may have ended between the routing decision and the post; make sure the advice is not left unread.
      void this.ensureRead(primaryID, posted).catch((e) => this.log("debug", "ensureRead failed", { error: errMessage(e) }))
    } else {
      s.wakeAt = Date.now()
      s.continuation = true
      // 主ターン全体を待つので、呼び出し側をブロックしない。
      // Chờ cả một lượt primary nên không được chặn caller.
      void this.post(primaryID, notes, { noReply: false }, last).catch((e) => {
        s.continuation = false
        this.log("warn", "advisor wake failed", { error: errMessage(e), session: primaryID })
      })
    }
    this.log("info", `advisory delivered via ${route}`, { session: primaryID, severity: top.note.severity, count: notes.length })
  }

  // ---- channels

  private async lastUser(id: string): Promise<{ agent?: string; model?: ModelRef } | undefined> {
    try {
      const msgs = unwrap<Msg[]>(await this.client.session.messages({ path: { id }, query: { limit: 40 } }))
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!
        if (m.info.role !== "user") continue
        // Skip our own cards and /advisor control prompts: the latter run under the tool-less advisor-ctl agent.
        if (isSelfMessage(m) || String(m.info.agent ?? "").startsWith("advisor")) continue
        return { agent: m.info.agent, model: m.info.model }
      }
    } catch (e) {
      this.log("debug", "lastUser lookup failed", { error: errMessage(e) })
    }
    return undefined
  }

  /**
   * Insert an <advisory> user message into the primary session.
   * The agent and model of the user's previous message are copied: opencode runs the next step with the
   * *latest user message's* agent/model, so omitting them would silently switch the primary to the defaults.
   */
  private async post(primaryID: string, notes: Note[], opts: { noReply: boolean }, last: { agent?: string; model?: ModelRef } | undefined): Promise<string | undefined> {
    const text = renderAdvisories(notes, { nowTurn: this.st(primaryID).turns, guidance: this.takeGuidance(primaryID) })
    const res = unwrap<{ info?: { id?: string } }>(
      await this.client.session.prompt({
        path: { id: primaryID },
        body: {
          noReply: opts.noReply,
          ...(last?.agent ? { agent: last.agent } : {}),
          ...(last?.model ? { model: last.model } : {}),
          parts: [{ type: "text", text, metadata: { [SELF_MARK]: true } }],
        },
      }),
    )
    return res?.info?.id
  }

  /**
   * After a mid-run injection: if the primary went idle without ever answering after the injected message
   * (the run finished in the gap), start a turn so the advice is acted on. Skipped when the user interrupted.
   */
  private async ensureRead(primaryID: string, messageID: string | undefined): Promise<void> {
    if (!messageID) return
    await new Promise((r) => setTimeout(r, RECHECK_MS))
    const s = this.st(primaryID)
    if (s.busy || s.suppressed) return
    const msgs = unwrap<Msg[]>(await this.client.session.messages({ path: { id: primaryID }, query: { limit: 10 } }))
    const idx = msgs.findIndex((m) => m.info.id === messageID)
    if (idx < 0) return
    if (msgs.slice(idx + 1).some((m) => m.info.role === "assistant")) return // already consumed
    const last = await this.lastUser(primaryID)
    unwrap(
      await this.client.session.prompt({
        path: { id: primaryID },
        body: {
          ...(last?.agent ? { agent: last.agent } : {}),
          ...(last?.model ? { model: last.model } : {}),
          parts: [{ type: "text", text: "(Advisor) The advisory above arrived as you were finishing. Address it now.", metadata: { [SELF_MARK]: true } }],
        },
      }),
    )
    this.log("info", "advisory re-woken after the run ended", { session: primaryID })
  }

  private toast(note: Note): void {
    if (!this.cfg.toast) return
    const title = `Advisor (${note.severity})`
    this.client.tui
      .showToast({ body: { title, message: clip(note.text, 280), variant: note.severity === "blocker" ? "error" : "warning", duration: 10_000 } })
      .catch(() => {})
  }
}
