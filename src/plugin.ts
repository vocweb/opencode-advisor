import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { loadConfig, type AdvisorSpec } from "./config.ts"
import { Delivery, unwrap, type Logger } from "./delivery.ts"
import { ADVISE_TOOL_DESCRIPTION, buildAdvisorSystemPrompt, PRIMARY_EXPLAINER, renderAdvisories } from "./prompts.ts"
import { Registry } from "./registry.ts"
import { AdvisorRuntime } from "./runtime.ts"
import { COMMAND_DESCRIPTION, control, type CommandCtx } from "./commands.ts"
import { ensureStarterConfig } from "./setup.ts"
import { CONTROL_TEXT, SELF_MARK, SEVERITY_RANK, type Msg, type Note } from "./types.ts"
import { clip, errMessage, parseModel } from "./util.ts"

const CONTROL_AGENT = "advisor-ctl"
const CONTROL_TTL_MS = 60_000

export const agentNameFor = (spec: AdvisorSpec) => `advisor-${spec.slug}`

/** The advisor may read the project, but not the usual secret files. */
function readPermission(): Record<string, string> {
  const rules: Record<string, string> = { "*": "allow" }
  for (const g of ["*.env", "*.env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*id_rsa*", "*id_ed25519*", "*credentials*", "*.npmrc", "*.netrc", "*secrets*"]) rules[g] = "deny"
  rules["*.env.example"] = "allow"
  return rules
}

// advisor agent の権限: 既定は全拒否。advise と調査ツールだけ許可し、書き込み系は利用者の設定に従う (無ければ ask)。
// Quyền của agent advisor: mặc định từ chối hết; chỉ cho advise và tool điều tra, tool ghi theo luật của người dùng (không có thì ask).
export function advisorPermission(spec: AdvisorSpec, user?: unknown): Record<string, unknown> {
  const perm: Record<string, unknown> = { "*": "deny", advise: "allow" }
  const userRule = (tool: string): unknown => {
    if (typeof user === "string") return user
    if (user && typeof user === "object" && tool in user) return (user as Record<string, unknown>)[tool]
    return undefined
  }
  for (const t of spec.tools) {
    if (t === "read") perm[t] = readPermission()
    else if (t === "grep" || t === "glob") perm[t] = "allow"
    else perm[t] = userRule(t) ?? "ask"
  }
  return perm
}

// opencode 1.19.3 は dispose を await しない (実測)。将来 await される場合に備えた短い猶予だけ残す。
// opencode 1.19.3 không await dispose (đã đo); chỉ giữ một khoảng chờ ngắn phòng khi phiên bản sau có await.
const DISPOSE_WAIT_MS = 15_000
const EVICTED = "[output of an earlier review evicted]"
// 次のレビュー開始後は不要になる古い調査ツール出力の対象。
// Các tool điều tra có output cũ trở nên vô ích khi advisor bắt đầu review mới.
const EVICTABLE_TOOLS = ["read", "grep", "glob"]

// 過去レビューの read/grep/glob 出力をスタブに置換する。モデルへ送る写しだけ変え、保存済みは触らない。
// Thay output read/grep/glob của các review cũ bằng stub; chỉ đổi bản gửi model, không đụng bản đã lưu.
export function evictStaleResults(messages: Msg[]): void {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.info.role === "user") {
      lastUser = i
      break
    }
  }
  for (let i = 0; i < lastUser; i++) {
    const parts = messages[i]!.parts
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j]!
      if (p.type === "tool" && p.state.status === "completed" && EVICTABLE_TOOLS.includes(p.tool)) {
        parts[j] = { ...p, state: { ...p.state, output: EVICTED } }
      }
    }
  }
}

export async function createAdvisorHooks(input: PluginInput): Promise<Hooks> {
  const { client } = input
  const log: Logger = (level, message, extra) => {
    Promise.resolve(client.app.log({ body: { service: "opencode-advisor", level, message, ...(extra ? { extra } : {}) } })).catch(() => {})
  }

  const cfg = loadConfig({ directory: input.directory, worktree: input.worktree })
  for (const w of cfg.warnings) log("warn", w)
  // enabled:false も残す。/advisor enable を再起動なしで効かせるため。
  // Giữ cả entry enabled:false để /advisor enable có hiệu lực mà không cần restart.
  const specs = cfg.advisors
  if (!cfg.enabled) {
    log("info", "advisor disabled by configuration")
    return {}
  }

  // First run after installing: leave a starter config behind and tell the user once what is still missing.
  const starter = ensureStarterConfig(cfg.sources)
  if (starter.created) log("info", `created starter config ${starter.file}`)
  else if (starter.error) log("warn", `could not create starter config: ${starter.error}`)
  let setupNotice = !specs.some((s) => s.model)
  const showToast = (message: string, variant: "info" | "warning" | "error" = "info") =>
    void Promise.resolve(client.tui.showToast({ body: { title: "Advisor", message, variant, duration: 12_000 } })).catch(() => {})

  const registry = new Registry()
  const delivery = new Delivery(client, cfg, log)
  const runtimes = new Map<string, AdvisorRuntime[]>()
  const pendingControl = new Map<string, { text: string; at: number }>()
  // advisor を止めたセッション (/advisor off)。
  // Các session người dùng đã tắt advisor (/advisor off).
  const disabledSessions = new Set<string>()
  // サブエージェント session から、それを見る spec 一覧への対応 ([] は対象外)。
  // Ánh xạ session subagent sang các spec theo dõi nó ([] nghĩa là không được theo dõi).
  const subSpecs = new Map<string, AdvisorSpec[]>()
  // エージェント定義の advisor: 指定。task.agentAdvisor が優先して上書きする。
  // Khóa advisor: trong định nghĩa agent; task.agentAdvisor ghi đè.
  const frontAdvisor = new Map<string, string>()
  // 拒否される予定の権限要求 (誰も答えなければ時間切れで reject)。
  // Các yêu cầu quyền đang chờ, sẽ bị từ chối nếu không ai trả lời.
  const permissionTimers = new Map<string, NodeJS.Timeout>()

  // ------------------------------------------------------------------ runtimes

  function createRuntime(spec: AdvisorSpec, id: string): AdvisorRuntime {
    return new AdvisorRuntime({ client, cfg, spec, registry, delivery, log, primaryID: id, agentName: agentNameFor(spec) })
  }

  function runtimesFor(id: string, create = true): AdvisorRuntime[] {
    let list = runtimes.get(id)
    if (!list && create && !disabledSessions.has(id)) {
      list = (subSpecs.get(id) ?? specs).filter((s) => s.enabled).map((spec) => createRuntime(spec, id))
      runtimes.set(id, list)
    }
    return list ?? []
  }

  function notifyAll(id: string, final: boolean): void {
    for (const r of runtimesFor(id)) r.notify(final)
  }

  function disposeSession(id: string): void {
    runtimes.get(id)?.forEach((r) => r.dispose())
    runtimes.delete(id)
  }

  // enable/disable を既存の全セッションの runtime に即反映する。
  // Áp dụng enable/disable ngay cho runtime ở mọi session đang có.
  function applyEnabled(spec: AdvisorSpec): void {
    for (const [id, list] of runtimes) {
      const i = list.findIndex((r) => r.spec.slug === spec.slug)
      if (spec.enabled && i < 0 && !subSpecs.has(id)) list.push(createRuntime(spec, id))
      else if (!spec.enabled && i >= 0) {
        list[i]!.dispose()
        list.splice(i, 1)
      }
    }
  }

  // messages の limit は末尾 N 件を返すため先頭の user が取れないことがある。assistant の mode が同じ agent 名を持つ。
  // messages({limit}) trả N tin cuối nên có thể mất user đầu tiên; mode của assistant mang cùng tên agent.
  async function firstAgent(id: string): Promise<string | undefined> {
    const msgs = unwrap<Msg[]>(await client.session.messages({ path: { id }, query: { limit: 100 } }))
    for (const m of msgs) {
      if (m.info.role === "user") return m.info.agent
      if (m.info.role === "assistant") return m.info.mode
    }
    return undefined
  }

  // task.agentAdvisor かエージェント定義から、サブエージェントを見る advisor を決める。
  // Xác định advisor theo dõi subagent từ task.agentAdvisor hoặc khóa advisor: của agent.
  async function specsForSubagent(id: string): Promise<AdvisorSpec[]> {
    const agent = await firstAgent(id)
    const v = agent ? (cfg.agentAdvisor[agent] ?? frontAdvisor.get(agent)) : undefined
    if (!v || v === "off") return []
    if (v === "on") return specs
    if (!parseModel(v.replace(/:[a-z]+$/i, ""))) {
      log("warn", `task.agentAdvisor.${agent} = "${v}" is not on, off or a model selector; ignored`)
      return []
    }
    return specs.map((s) => ({ ...s, model: v }))
  }

  // advisor が監視すべきセッションなら true。
  // Trả true nếu session cần được advisor theo dõi.
  async function eligible(id: string): Promise<boolean> {
    if (registry.isAdvisorSession(id)) return false
    if (!registry.meta.has(id)) {
      const s = unwrap<{ id: string; parentID?: string; title?: string }>(await client.session.get({ path: { id } }))
      registry.noteSession(s.id, { parentID: s.parentID, title: s.title })
    }
    if (registry.isAdvisorSession(id)) return false
    if (!registry.meta.get(id)?.parentID) return true
    if (!subSpecs.has(id)) subSpecs.set(id, await specsForSubagent(id))
    return subSpecs.get(id)!.length > 0
  }

  function whenEligible(id: string, fn: () => void): void {
    // 既知のトップレベルは問い合わせ不要の近道。
    // Đường tắt: session cấp cao đã biết thì không cần tra cứu.
    if (!registry.isAdvisorSession(id) && registry.meta.has(id) && !registry.meta.get(id)!.parentID) return fn()
    eligible(id)
      .then((ok) => {
        if (ok) fn()
      })
      .catch((e) => log("debug", "session lookup failed", { id, error: errMessage(e) }))
  }

  // ------------------------------------------------------------------ events

  function dispatch(ev: any): void {
    switch (ev.type) {
      case "session.created": {
        const info = ev.properties.info
        registry.noteSession(info.id, { parentID: info.parentID, title: info.title })
        registry.fresh.add(info.id)
        if (setupNotice && !info.parentID && !info.title?.startsWith("[advisor]")) {
          setupNotice = false
          if (cfg.toast) showToast("Advisor is installed but has no model yet. Run /advisor setup <provider/model> (e.g. anthropic/claude-haiku-4-5).", "warning")
        }
        break
      }
      case "session.updated": {
        const info = ev.properties.info
        registry.noteSession(info.id, { parentID: info.parentID, title: info.title })
        break
      }
      case "session.deleted": {
        const id = ev.properties.info.id
        disposeSession(id)
        delivery.forget(id)
        registry.meta.delete(id)
        registry.fresh.delete(id)
        registry.owners.delete(id)
        disabledSessions.delete(id)
        subSpecs.delete(id)
        break
      }
      case "session.status": {
        const { sessionID, status } = ev.properties
        if (!registry.isAdvisorSession(sessionID)) delivery.setBusy(sessionID, status?.type !== "idle")
        else if (status?.type === "retry") registry.owners.get(sessionID)?.onRetryStatus(status)
        break
      }
      // 人間に聞く権限要求は無期限に待たせない。時間切れなら拒否してレビューを先へ進める。
      // Yêu cầu quyền cần người trả lời không được chờ vô hạn: hết hạn thì từ chối để review đi tiếp.
      case "permission.updated":
      case "permission.asked": {
        const p = ev.properties
        const id = String(p?.id ?? p?.requestID ?? "")
        if (!id || !registry.isAdvisorSession(p?.sessionID) || permissionTimers.has(id)) break
        const sessionID = String(p.sessionID)
        permissionTimers.set(
          id,
          setTimeout(() => {
            permissionTimers.delete(id)
            log("warn", "advisor permission request timed out; rejected", { sessionID, permission: id, title: p?.title })
            if (cfg.toast) showToast(`An advisor asked for permission (${clip(String(p?.title ?? "tool"), 80)}) and nobody answered; it was rejected.`, "warning")
            Promise.resolve(client.postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID: id }, body: { response: "reject" } })).catch(() => {})
          }, cfg.permissionTimeoutMs),
        )
        break
      }
      case "permission.replied": {
        const id = String(ev.properties?.permissionID ?? ev.properties?.requestID ?? ev.properties?.id ?? "")
        clearTimeout(permissionTimers.get(id))
        permissionTimers.delete(id)
        break
      }
      case "session.error": {
        const { sessionID, error } = ev.properties
        if (sessionID && error?.name === "MessageAbortedError" && !registry.isAdvisorSession(sessionID)) delivery.onAbort(sessionID)
        break
      }
      case "message.updated": {
        const info = ev.properties.info
        if (info.role !== "assistant") break
        if (registry.isAdvisorSession(info.sessionID)) {
          if (info.time?.completed) registry.owners.get(info.sessionID)?.recordUsage(info)
          break
        }
        if (!info.time?.completed) break
        whenEligible(info.sessionID, () => {
          delivery.onTurnComplete(info.sessionID, info.finish)
          if (!delivery.isAdvisorContinuation(info.sessionID)) notifyAll(info.sessionID, false)
        })
        break
      }
      case "session.idle": {
        const id = ev.properties.sessionID
        if (registry.isAdvisorSession(id)) break
        delivery.setBusy(id, false)
        pendingControl.delete(id)
        whenEligible(id, () => {
          // 助言が起動したターンは advisor に戻さない。次のレビューが作業を拾う。
          // Lượt do advisory khởi động không đưa ngược cho advisor; review kế tiếp sẽ phủ phần việc đó.
          if (delivery.isAdvisorContinuation(id)) delivery.endContinuation(id)
          else notifyAll(id, true)
        })
        break
      }
      case "session.compacted": {
        const id = ev.properties.sessionID
        runtimes.get(id)?.forEach((r) => r.reset())
        break
      }
    }
  }

  // ------------------------------------------------------------------ the /advisor control command

  const commandCtx: CommandCtx = {
    cfg,
    specs,
    client,
    registry,
    delivery,
    runtimes,
    disabledSessions,
    directory: input.directory,
    worktree: input.worktree,
    env: process.env,
    runtimesFor,
    disposeSession,
    applyEnabled,
  }

  // ------------------------------------------------------------------ hooks

  const hooks: Hooks = {
    config: async (c) => {
      const conf = c as any
      // `advise` exists for advisors only: deny it everywhere, then allow it per advisor agent.
      const existing = conf.permission
      conf.permission =
        typeof existing === "string"
          ? { "*": existing, advise: "deny" }
          : { ...(existing ?? {}), advise: existing?.advise ?? "deny" }
      conf.agent = { ...(conf.agent ?? {}) }
      // エージェント定義が advisor: で自分から有効化できる (task.agentAdvisor が優先)。
      // Định nghĩa agent có thể tự bật bằng advisor: (task.agentAdvisor ưu tiên hơn).
      for (const [name, def] of Object.entries<any>(conf.agent)) {
        const v = def?.advisor ?? def?.options?.advisor
        if (v === true) frontAdvisor.set(name, "on")
        else if (v === false) frontAdvisor.set(name, "off")
        else if (typeof v === "string" && v.trim()) frontAdvisor.set(name, v.trim())
      }
      // 無効でも全エントリに agent を作る。enable 時に再起動が要らなくなる。
      // Tạo agent cho mọi entry kể cả đang tắt, để enable không cần restart.
      for (const spec of specs) {
        conf.agent[agentNameFor(spec)] = {
          mode: "subagent",
          description: `Silent reviewer "${spec.name}" used by the opencode-advisor plugin. Not for manual use.`,
          prompt: buildAdvisorSystemPrompt({
            name: spec.name,
            maxNotes: spec.maxNotesPerUpdate,
            watchdog: cfg.watchdog,
            shared: cfg.instructions,
            specialization: spec.instructions,
          }),
          permission: advisorPermission(spec, existing),
          hidden: true,
        }
      }
      conf.agent[CONTROL_AGENT] = {
        mode: "subagent",
        description: "Prints advisor status for the /advisor command. Not for manual use.",
        prompt: "Reply with the single word: ok. Never call tools.",
        permission: { "*": "deny" },
        hidden: true,
      }
      conf.command = { ...(conf.command ?? {}) }
      if (!conf.command.advisor) {
        conf.command.advisor = {
          template: CONTROL_TEXT,
          description: COMMAND_DESCRIPTION,
          agent: CONTROL_AGENT,
          ...(parseModel(cfg.controlModel) ? { model: cfg.controlModel } : {}),
          subtask: false,
        }
      }
    },

    tool: {
      advise: tool({
        description: ADVISE_TOOL_DESCRIPTION,
        args: {
          note: tool.schema.string().min(1).max(2000).describe("The finding: what is wrong, where, and what to do instead."),
          severity: tool.schema.enum(["nit", "concern", "blocker"]).optional().describe("Defaults to nit."),
        },
        async execute(args, context) {
          const ctx = registry.reviews.get(context.sessionID)
          if (!ctx) return "advise is only available to an advisor while it is reviewing an update."
          return ctx.handleAdvise({ note: args.note, ...(args.severity ? { severity: args.severity } : {}) })
        },
      }),
    },

    event: async ({ event }) => {
      try {
        dispatch(event)
      } catch (e) {
        log("warn", "advisor event handler failed", { type: (event as any)?.type, error: errMessage(e) })
      }
    },

    "chat.message": async (i, o) => {
      if (o.parts.some((p) => (p as any).metadata?.[SELF_MARK] || String((p as any).text ?? "").startsWith(CONTROL_TEXT))) return // our own advisory / control prompt
      if (registry.isAdvisorSession(i.sessionID)) return
      delivery.onRealUserMessage(i.sessionID)
    },

    "command.execute.before": async (i, o) => {
      if (i.command !== "advisor") return
      let text: string
      try {
        text = await control(commandCtx, i.sessionID, i.arguments ?? "")
      } catch (e) {
        text = `Advisor command failed: ${errMessage(e)}`
      }
      pendingControl.set(i.sessionID, { text, at: Date.now() })
      // The command still runs one (tiny) model call; the reply text is replaced in experimental.text.complete.
    },

    "experimental.text.complete": async (i, o) => {
      const p = pendingControl.get(i.sessionID)
      if (!p) return
      pendingControl.delete(i.sessionID)
      if (Date.now() - p.at > CONTROL_TTL_MS) return
      o.text = p.text
    },

    "experimental.chat.messages.transform": async (_i, o) => {
      const sid = o.messages.at(-1)?.info.sessionID
      if (!sid) return
      if (registry.isAdvisorSession(sid)) {
        if (cfg.evictStaleResults) evictStaleResults(o.messages)
        return
      }
      if (disabledSessions.has(sid)) return
      // advisor が追いつくまで主の次の LLM 呼び出しを待たせる (abort・失敗・タイムアウトで解放)。
      // Giữ lần gọi LLM kế của primary tới khi advisor theo kịp (thả khi abort, lỗi, timeout).
      // /advisor コマンド自身は待たせない。reset/off は advisor が詰まった時の脱出口だから。
      // Không bắt lệnh /advisor chờ, vì reset/off là lối thoát khi advisor bị kẹt.
      const lastUser = [...o.messages].reverse().find((m) => m.info.role === "user")
      const isControl = lastUser?.parts.some((p) => p.type === "text" && p.text.startsWith(CONTROL_TEXT)) === true
      const rts = isControl ? [] : (runtimes.get(sid) ?? [])
      if (rts.length > 0) await Promise.all(rts.map((r) => r.waitCaughtUp(r.spec.syncBacklog, delivery.abortSignal(sid))))
      const asides = delivery.takeAsides(sid)
      if (asides.length === 0) return
      let target: (typeof o.messages)[number] | undefined
      for (let k = o.messages.length - 1; k >= 0; k--) {
        if (o.messages[k]!.info.role === "user") {
          target = o.messages[k]
          break
        }
      }
      if (!target) {
        delivery.putBackAsides(sid, asides)
        return
      }
      const sorted: Note[] = [...asides].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.turn - a.turn)
      target.parts.push({
        id: `prt_advisor_${Date.now().toString(36)}`,
        sessionID: sid,
        messageID: target.info.id,
        type: "text",
        text: renderAdvisories(sorted, { nowTurn: delivery.turnCount(sid), guidance: delivery.takeGuidance(sid) }),
        synthetic: true,
        metadata: { [SELF_MARK]: true },
      } as any)
    },

    "experimental.chat.system.transform": async (i, o) => {
      if (!cfg.explainToPrimary || !i.sessionID || disabledSessions.has(i.sessionID) || registry.isAdvisorSession(i.sessionID)) return
      o.system.push(PRIMARY_EXPLAINER)
    },

    dispose: async () => {
      // 最後のレビューは最終回答の後に終わるので、今切るとヘッドレス実行で失われる。
      // Review cuối thường xong sau câu trả lời cuối nên cắt ngay sẽ mất ở chế độ headless.
      let cap: NodeJS.Timeout | undefined
      const capped = new Promise<void>((resolve) => {
        cap = setTimeout(resolve, DISPOSE_WAIT_MS)
      })
      try {
        await Promise.race([Promise.all([...runtimes.values()].flat().map((r) => r.idle())), capped])
      } finally {
        // 10 分のタイマーが残るとヘッドレスのプロセスが終了できない。
        // Timer 10 phút còn treo sẽ giữ tiến trình headless không thoát được.
        clearTimeout(cap)
      }
      await delivery.drain()
      for (const id of [...runtimes.keys()]) disposeSession(id)
    },
  }

  log("info", "advisor ready", { advisors: specs.map((s) => ({ name: s.name, enabled: s.enabled, model: s.model ?? null, tools: s.tools, mode: s.reviewMode })) })
  return hooks
}
