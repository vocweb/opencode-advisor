import { control, type CommandCtx } from "./commands.ts"
import type { AdvisorConfig, AdvisorSpec } from "./config.ts"
import { Delivery } from "./delivery.ts"
import type { Host } from "./host.ts"
import { agentNameFor } from "./policy.ts"
import { renderAdvisories } from "./prompts.ts"
import { Registry } from "./registry.ts"
import { AdvisorRuntime } from "./runtime.ts"
import { SEVERITY_RANK, type Note } from "./types.ts"
import { errMessage, parseModel } from "./util.ts"

export interface CoreInit {
  host: Host
  cfg: AdvisorConfig
  directory: string
  worktree: string | undefined
}

export interface SessionSeen {
  id: string
  parentID?: string | undefined
  title?: string | undefined
}

/**
 * The advisor engine shared by every opencode version: which sessions are watched, one runtime per advisor and session,
 * delivery, the `/advisor` command. A host adapter translates its own events and hooks into calls on this class.
 */
export class AdvisorCore {
  readonly host: Host
  readonly cfg: AdvisorConfig
  readonly registry = new Registry()
  readonly delivery: Delivery
  readonly runtimes = new Map<string, AdvisorRuntime[]>()
  // advisor を止めたセッション (/advisor off)。
  // Các session người dùng đã tắt advisor (/advisor off).
  readonly disabledSessions = new Set<string>()
  // enabled:false も残す。/advisor enable を再起動なしで効かせるため。
  // Giữ cả entry enabled:false để /advisor enable có hiệu lực mà không cần restart.
  readonly specs: AdvisorSpec[]
  // エージェント定義の advisor: 指定。task.agentAdvisor が優先して上書きする。
  // Khóa advisor: trong định nghĩa agent; task.agentAdvisor ghi đè.
  readonly frontAdvisor = new Map<string, string>()
  // サブエージェント session から、それを見る spec 一覧への対応 ([] は対象外)。
  // Ánh xạ session subagent sang các spec theo dõi nó ([] nghĩa là không được theo dõi).
  private subSpecs = new Map<string, AdvisorSpec[]>()
  private setupNotice: boolean
  readonly commandCtx: CommandCtx

  constructor(private init: CoreInit) {
    this.host = init.host
    this.cfg = init.cfg
    this.specs = init.cfg.advisors
    this.delivery = new Delivery(init.host, init.cfg)
    this.setupNotice = !this.specs.some((s) => s.model)
    this.commandCtx = {
      cfg: this.cfg,
      specs: this.specs,
      host: this.host,
      registry: this.registry,
      delivery: this.delivery,
      runtimes: this.runtimes,
      disabledSessions: this.disabledSessions,
      directory: init.directory,
      worktree: init.worktree,
      env: process.env,
      runtimesFor: (id, create) => this.runtimesFor(id, create),
      disposeSession: (id) => this.disposeSession(id),
      applyEnabled: (spec) => this.applyEnabled(spec),
    }
  }

  private get log() {
    return this.host.log
  }

  // ------------------------------------------------------------------ runtimes

  private createRuntime(spec: AdvisorSpec, id: string): AdvisorRuntime {
    return new AdvisorRuntime({ host: this.host, cfg: this.cfg, spec, registry: this.registry, delivery: this.delivery, log: this.log, primaryID: id, agentName: agentNameFor(spec) })
  }

  runtimesFor(id: string, create = true): AdvisorRuntime[] {
    let list = this.runtimes.get(id)
    if (!list && create && !this.disabledSessions.has(id)) {
      list = (this.subSpecs.get(id) ?? this.specs).filter((s) => s.enabled).map((spec) => this.createRuntime(spec, id))
      this.runtimes.set(id, list)
    }
    return list ?? []
  }

  private notifyAll(id: string, final: boolean): void {
    for (const r of this.runtimesFor(id)) r.notify(final)
  }

  disposeSession(id: string): void {
    this.runtimes.get(id)?.forEach((r) => r.dispose())
    this.runtimes.delete(id)
  }

  // enable/disable を既存の全セッションの runtime に即反映する。
  // Áp dụng enable/disable ngay cho runtime ở mọi session đang có.
  applyEnabled(spec: AdvisorSpec): void {
    for (const [id, list] of this.runtimes) {
      const i = list.findIndex((r) => r.spec.slug === spec.slug)
      if (spec.enabled && i < 0 && !this.subSpecs.has(id)) list.push(this.createRuntime(spec, id))
      else if (!spec.enabled && i >= 0) {
        list[i]!.dispose()
        list.splice(i, 1)
      }
    }
  }

  // ------------------------------------------------------------------ which sessions are watched

  // task.agentAdvisor かエージェント定義から、サブエージェントを見る advisor を決める。
  // Xác định advisor theo dõi subagent từ task.agentAdvisor hoặc khóa advisor: của agent.
  private async specsForSubagent(id: string): Promise<AdvisorSpec[]> {
    const agent = await this.host.firstAgent(id)
    const v = agent ? (this.cfg.agentAdvisor[agent] ?? this.frontAdvisor.get(agent)) : undefined
    if (!v || v === "off") return []
    if (v === "on") return this.specs
    if (!parseModel(v.replace(/:[a-z]+$/i, ""))) {
      this.log("warn", `task.agentAdvisor.${agent} = "${v}" is not on, off or a model selector; ignored`)
      return []
    }
    return this.specs.map((s) => ({ ...s, model: v }))
  }

  // advisor が監視すべきセッションなら true。
  // Trả true nếu session cần được advisor theo dõi.
  private async eligible(id: string): Promise<boolean> {
    if (this.registry.isAdvisorSession(id)) return false
    if (!this.registry.meta.has(id)) {
      const s = await this.host.sessionInfo(id)
      this.registry.noteSession(s.id, { parentID: s.parentID, title: s.title })
    }
    if (this.registry.isAdvisorSession(id)) return false
    if (!this.registry.meta.get(id)?.parentID) return true
    if (!this.subSpecs.has(id)) this.subSpecs.set(id, await this.specsForSubagent(id))
    return this.subSpecs.get(id)!.length > 0
  }

  private whenEligible(id: string, fn: () => void): void {
    // 既知のトップレベルは問い合わせ不要の近道。
    // Đường tắt: session cấp cao đã biết thì không cần tra cứu.
    if (!this.registry.isAdvisorSession(id) && this.registry.meta.has(id) && !this.registry.meta.get(id)!.parentID) return fn()
    this.eligible(id)
      .then((ok) => {
        if (ok) fn()
      })
      .catch((e) => this.log("debug", "session lookup failed", { id, error: errMessage(e) }))
  }

  isAdvisorSession(id: string | undefined): boolean {
    return this.registry.isAdvisorSession(id)
  }

  // ------------------------------------------------------------------ events (host-neutral)

  sessionCreated(info: SessionSeen): void {
    this.registry.noteSession(info.id, { parentID: info.parentID, title: info.title })
    this.registry.fresh.add(info.id)
    if (this.setupNotice && !info.parentID && !info.title?.startsWith("[advisor]")) {
      this.setupNotice = false
      if (this.cfg.toast) this.host.toast("Advisor is installed but has no model yet. Run /advisor setup <provider/model> (e.g. anthropic/claude-haiku-4-5).", "warning")
    }
  }

  sessionUpdated(info: SessionSeen): void {
    this.registry.noteSession(info.id, { parentID: info.parentID, title: info.title })
  }

  sessionDeleted(id: string): void {
    this.disposeSession(id)
    this.delivery.forget(id)
    this.registry.meta.delete(id)
    this.registry.fresh.delete(id)
    this.registry.owners.delete(id)
    this.disabledSessions.delete(id)
    this.subSpecs.delete(id)
  }

  /** A primary session started or stopped running a turn. */
  busyChanged(id: string, busy: boolean): void {
    if (!this.registry.isAdvisorSession(id)) this.delivery.setBusy(id, busy)
  }

  /** The provider asked an advisor session to retry later (opencode retries by itself and may never give up). */
  retryStatus(id: string, status: { attempt: number; message: string; next: number }): void {
    this.registry.owners.get(id)?.onRetryStatus(status)
  }

  /** Hosts that decide retries through a hook (v2): true when the provider should stop retrying this advisor request. */
  stopRetrying(id: string, r: { attempt: number; message: string; waitMs: number }): boolean {
    return this.registry.owners.get(id)?.shouldStopRetrying(r) === true
  }

  /** Cost and tokens of a finished advisor assistant message. */
  advisorMessage(id: string, info: Parameters<AdvisorRuntime["recordUsage"]>[0]): void {
    this.registry.owners.get(id)?.recordUsage(info)
  }

  /** The primary finished one assistant step (a tool-loop round or its final answer). */
  stepCompleted(id: string, finish: string | undefined): void {
    this.whenEligible(id, () => {
      this.delivery.onTurnComplete(id, finish)
      if (!this.delivery.isAdvisorContinuation(id)) this.notifyAll(id, false)
    })
  }

  /** The primary's run ended (nothing left to do). */
  runEnded(id: string): void {
    if (this.registry.isAdvisorSession(id)) return
    this.delivery.setBusy(id, false)
    this.whenEligible(id, () => {
      // 助言が起動したターンは advisor に戻さない。次のレビューが作業を拾う。
      // Lượt do advisory khởi động không đưa ngược cho advisor; review kế tiếp sẽ phủ phần việc đó.
      if (this.delivery.isAdvisorContinuation(id)) this.delivery.endContinuation(id)
      else this.notifyAll(id, true)
    })
  }

  userAborted(id: string): void {
    if (!this.registry.isAdvisorSession(id)) this.delivery.onAbort(id)
  }

  compacted(id: string): void {
    this.runtimes.get(id)?.forEach((r) => r.reset())
  }

  /** A message typed by the user (not one of ours). */
  realUserMessage(id: string): void {
    if (!this.registry.isAdvisorSession(id)) this.delivery.onRealUserMessage(id)
  }

  // ------------------------------------------------------------------ hooks around the primary's model calls

  /**
   * syncBacklog: hold the primary's next LLM call until its advisors have caught up (released by abort, failure, timeout).
   * The /advisor command itself is never held: reset and off are the way out when an advisor is stuck.
   */
  // advisor が追いつくまで主の次の LLM 呼び出しを待たせる。/advisor コマンドは待たせない (詰まった時の脱出口だから)。
  // Giữ lần gọi LLM kế của primary tới khi advisor theo kịp; không bắt lệnh /advisor chờ vì đó là lối thoát khi advisor kẹt.
  async beforeModelCall(id: string, opts: { isControl: boolean }): Promise<void> {
    if (this.disabledSessions.has(id) || opts.isControl) return
    const rts = this.runtimes.get(id) ?? []
    if (rts.length > 0) await Promise.all(rts.map((r) => r.waitCaughtUp(r.spec.syncBacklog, this.delivery.abortSignal(id))))
  }

  /** Non-interrupting notes waiting for the next model call, rendered as one block; undefined when there are none. */
  takeAsideText(id: string): { text: string; putBack: () => void } | undefined {
    const asides = this.delivery.takeAsides(id)
    if (asides.length === 0) return undefined
    const sorted: Note[] = [...asides].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.turn - a.turn)
    return {
      text: renderAdvisories(sorted, { nowTurn: this.delivery.turnCount(id), guidance: this.delivery.takeGuidance(id) }),
      putBack: () => this.delivery.putBackAsides(id, asides),
    }
  }

  // ------------------------------------------------------------------ the /advisor command and shutdown

  control(sessionID: string, args: string): Promise<string> {
    return control(this.commandCtx, sessionID, args)
  }

  /** Stop every runtime at once (plugin unload): nothing is waited for or delivered. */
  stop(): void {
    for (const id of [...this.runtimes.keys()]) this.disposeSession(id)
  }

  /** Let running reviews finish for a moment, deliver what is queued, then stop every runtime. */
  async shutdown(waitMs: number): Promise<void> {
    let cap: NodeJS.Timeout | undefined
    const capped = new Promise<void>((resolve) => {
      cap = setTimeout(resolve, waitMs)
    })
    try {
      await Promise.race([Promise.all([...this.runtimes.values()].flat().map((r) => r.idle())), capped])
    } finally {
      // 長いタイマーが残るとヘッドレスのプロセスが終了できない。
      // Timer dài còn treo sẽ giữ tiến trình headless không thoát được.
      clearTimeout(cap)
    }
    await this.delivery.drain()
    for (const id of [...this.runtimes.keys()]) this.disposeSession(id)
  }
}
