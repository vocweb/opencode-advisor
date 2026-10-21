import { COMMAND_DESCRIPTION } from "../../commands.ts"
import { loadConfig } from "../../config.ts"
import { AdvisorCore } from "../../core.ts"
import type { Logger } from "../../host.ts"
import { agentNameFor, EVICTED, isEvictableTool } from "../../policy.ts"
import { ADVISE_TOOL_DESCRIPTION, buildAdvisorSystemPrompt, PRIMARY_EXPLAINER } from "../../prompts.ts"
import { ensureStarterConfig } from "../../setup.ts"
import { SELF_MARK } from "../../types.ts"
import { errMessage } from "../../util.ts"
import { createV2Host, type V2Ctx } from "./host.ts"
import { advisorRules, type V2Rule } from "./permission.ts"

const TESTED_WITH = "2.1"

/** True when `ctx` is the full v2 plugin context. opencode 1.x also calls `setup` and passes a partial one. */
export function isV2Context(ctx: V2Ctx | undefined): boolean {
  return !!ctx && !!ctx.location && typeof ctx.session?.hook === "function" && typeof ctx.event?.subscribe === "function" && typeof ctx.tool?.transform === "function"
}

// 隠れた session を 1 つ作るたびに log が増えないよう、info/debug は環境変数があるときだけ出す。
// Chỉ in info/debug khi có biến môi trường, để log không phình ra theo từng session ẩn.
function makeLogger(): Logger {
  const verbose = process.env.OPENCODE_ADVISOR_DEBUG === "1"
  return (level, message, extra) => {
    if ((level === "debug" || level === "info") && !verbose) return
    console.error(`[opencode-advisor] ${level}: ${message}${extra ? " " + JSON.stringify(extra) : ""}`)
  }
}

/** The plugin for opencode 2.x. Everything outside this module is shared with 1.x through AdvisorCore. */
export async function setupV2(ctx: V2Ctx): Promise<(() => void) | void> {
  const log = makeLogger()
  const directory = String(ctx.location.directory)
  const cfg = loadConfig({ directory, worktree: ctx.location.project?.directory ? String(ctx.location.project.directory) : undefined })
  for (const w of cfg.warnings) log("warn", w)
  if (!cfg.enabled) {
    log("info", "advisor disabled by configuration")
    return
  }
  const version = String(ctx.app?.version ?? "unknown")
  if (!version.startsWith(`${TESTED_WITH}.`)) log("warn", `opencode ${version} was not tested with this plugin (tested with ${TESTED_WITH}.x); if something breaks, please report it`)

  const starter = ensureStarterConfig(cfg.sources)
  if (starter.created) log("info", `created starter config ${starter.file}`)
  else if (starter.error) log("warn", `could not create starter config: ${starter.error}`)

  const host = createV2Host(ctx, log)
  const core = new AdvisorCore({ host, cfg, directory, worktree: undefined })
  const { registry, specs } = core
  const stop = new AbortController()

  // ------------------------------------------------------------------ which sessions belong to this project
  // イベントは全 project 共通で、location を持たないものも多い。session id から自分の project か調べて覚える。
  // Sự kiện là toàn cục và nhiều cái không có location; tra session id để biết có thuộc project này không rồi nhớ lại.
  const mine = new Map<string, boolean>()
  async function isMine(id: string, hint?: string): Promise<boolean> {
    if (registry.isAdvisorSession(id)) return true
    const known = mine.get(id)
    if (known !== undefined) return known
    let dir = hint
    try {
      // 初めて見る session は、作成イベントを取り逃していることがある (plugin は project を最初に使った時に読み込まれる)。ここで登録する。
      // Session lần đầu thấy có thể đã lỡ sự kiện tạo (plugin chỉ nạp khi project được dùng lần đầu); đăng ký luôn tại đây.
      const info = await host.sessionInfo(id)
      dir = dir ?? info.directory
      if (dir === directory) core.sessionUpdated({ id, parentID: info.parentID, title: info.title })
    } catch {
      if (dir === undefined) return false
    }
    const ok = dir === directory
    mine.set(id, ok)
    return ok
  }

  // ------------------------------------------------------------------ tool, agents, command
  const userRules: V2Rule[] = []
  try {
    const build = (await ctx.agent.get({ agentID: "build" })) as { permissions?: V2Rule[] } | undefined
    userRules.push(...(build?.permissions ?? []))
  } catch (e) {
    log("debug", "could not read the default agent's permissions", { error: errMessage(e) })
  }

  await ctx.tool.transform((editor: any) => {
    editor.add({
      name: "advise",
      description: ADVISE_TOOL_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          note: { type: "string", minLength: 1, maxLength: 2000, description: "The finding: what is wrong, where, and what to do instead." },
          severity: { type: "string", enum: ["nit", "concern", "blocker"], description: "Defaults to nit." },
        },
        required: ["note"],
        additionalProperties: false,
      },
      // 直接呼び出せる tool として登録する。省略すると code-mode の中にしか現れず、モデルが呼べない。
      // Đăng ký là tool gọi trực tiếp; nếu bỏ thì nó chỉ nằm trong code-mode và model không gọi được.
      options: { codemode: false },
      execute: async (input: { note: string; severity?: string }, context: { sessionID: string }) => {
        const review = registry.reviews.get(context.sessionID)
        if (!review) return { content: "advise is only available to an advisor while it is reviewing an update." }
        return { content: review.handleAdvise({ note: input.note, ...(input.severity ? { severity: input.severity } : {}) }) }
      },
    })
  })

  await ctx.agent.transform((editor: any) => {
    for (const spec of specs) {
      editor.update(agentNameFor(spec), (agent: any) => {
        agent.hidden = true
        agent.mode = "subagent"
        agent.description = `Silent reviewer "${spec.name}" used by the opencode-advisor plugin. Not for manual use.`
        agent.system = buildAdvisorSystemPrompt({ name: spec.name, maxNotes: spec.maxNotesPerUpdate, watchdog: cfg.watchdog, shared: cfg.instructions, specialization: spec.instructions })
        agent.permissions = advisorRules(spec, userRules)
      })
    }
  })

  // /advisor は補助機能。command の API が変わっても review 本体は動かし続ける。
  // /advisor là phần phụ; nếu API command đổi thì phần review chính vẫn phải chạy.
  try {
  await ctx.command.transform((editor: any) => {
    editor.add({
      name: "advisor",
      description: COMMAND_DESCRIPTION,
      // 返信は synthetic の description として出す。モデルを呼ばず、TUI にそのまま表示される。
      // Trả lời bằng description của synthetic: không gọi model và TUI hiển thị ngay.
      execute: async (inv: { sessionID: string; prompt?: { text?: string } }) => {
        let reply: string
        try {
          reply = await core.control(inv.sessionID, String(inv.prompt?.text ?? ""))
        } catch (e) {
          reply = `Advisor command failed: ${errMessage(e)}`
        }
        await ctx.session.synthetic({
          sessionID: inv.sessionID,
          text: "[opencode-advisor] The /advisor reply is shown to the user.",
          description: reply,
          resume: false,
          delivery: "steer",
          metadata: { [SELF_MARK]: "control" },
        })
      },
    })
  })
  } catch (e) {
    log("warn", "could not register the /advisor command", { error: errMessage(e) })
  }

  // ------------------------------------------------------------------ hooks around the model call
  // step の終了は、イベントと次のモデル呼び出しの hook のどちらが先に届くか分からない。assistant の id で重複を除いて 1 回だけ通知する。
  // Không biết sự kiện kết thúc step hay hook của lần gọi model kế tiếp đến trước; khử trùng theo id assistant để chỉ báo một lần.
  const notifiedSteps = new Set<string>()
  function stepEnded(sid: string, assistantID: string | undefined, finish: string | undefined): void {
    if (assistantID) {
      if (notifiedSteps.has(assistantID)) return
      notifiedSteps.add(assistantID)
      if (notifiedSteps.size > 2000) notifiedSteps.delete(notifiedSteps.values().next().value as string)
    }
    core.stepCompleted(sid, finish)
  }
  const hooks: Promise<unknown>[] = []
  hooks.push(
    ctx.session.hook("context", async (ev: any) => {
      const sid = String(ev.sessionID)
      if (core.isAdvisorSession(sid)) {
        // 古い調査ツールの出力はスタブにする。モデルへ送る写しだけを変える。
        // Output cũ của tool điều tra được thay bằng stub; chỉ đổi bản gửi model.
        if (cfg.evictStaleResults) evictV2(ev.messages)
        return
      }
      // advise は advisor 専用。他の agent には見せない。
      // advise chỉ dành cho advisor; các agent khác không được thấy.
      if (!String(ev.agent ?? "").startsWith("advisor-")) delete ev.tools?.advise
      if (!(await isMine(sid))) return
      // 直前の step が終わっていれば、イベントより先にここで通知して syncBacklog の待ちに間に合わせる。
      // Nếu step trước đã xong thì báo ngay tại đây, trước cả sự kiện, để syncBacklog kịp chờ.
      const lastAssistant = [...ev.messages].reverse().find((m: any) => m.role === "assistant")
      if (lastAssistant?.id) stepEnded(sid, String(lastAssistant.id), lastAssistant.content?.some((c: any) => c?.type === "tool-call") ? "tool-calls" : "stop")
      await core.beforeModelCall(sid, { isControl: false })
      if (core.disabledSessions.has(sid)) return
      if (cfg.explainToPrimary) ev.system.push({ type: "text", text: PRIMARY_EXPLAINER })
      const aside = core.takeAsideText(sid)
      if (!aside) return
      const target = [...ev.messages].reverse().find((m: any) => m.role === "user")
      if (!target) return aside.putBack()
      target.content.push({ type: "text", text: aside.text })
    }),
  )
  // 要約やタイトル生成などの補助リクエストにも advise を見せない。
  // Không để các request phụ (tóm tắt, tạo tiêu đề) thấy tool advise.
  for (const kind of ["compaction", "generate"]) {
    hooks.push(
      ctx.session.hook(kind, (ev: any) => {
        if (!String(ev.agent ?? "").startsWith("advisor-")) delete ev.tools?.advise
      }),
    )
  }
  hooks.push(
    ctx.session.hook("retry", (ev: any) => {
      const sid = String(ev.sessionID)
      if (!core.isAdvisorSession(sid)) return
      const proposed = ev.decision?.retry ? Number(ev.decision.delay ?? 0) : 0
      if (core.stopRetrying(sid, { attempt: Number(ev.attempt ?? 1), message: `${ev.error?.type ?? ""} ${ev.error?.message ?? ""}`, waitMs: proposed })) ev.decision = { retry: false }
    }),
  )
  // 一部のフックが将来の版で変わっても、他の機能は動かし続ける。
  // Nếu một hook đổi ở phiên bản sau thì các chức năng còn lại vẫn chạy.
  for (const r of await Promise.allSettled(hooks)) if (r.status === "rejected") log("warn", "could not register a session hook", { error: errMessage(r.reason) })

  // ------------------------------------------------------------------ permission requests raised by an advisor session
  // 人間に聞く権限要求は無期限に待たせない。時間切れなら拒否してレビューを先へ進める。
  // Yêu cầu quyền cần người trả lời không được chờ vô hạn: hết hạn thì từ chối để review đi tiếp.
  const permissionTimers = new Map<string, { timer: NodeJS.Timeout; sessionID: string }>()
  function dropPermissionTimers(sessionID?: string): void {
    for (const [id, e] of permissionTimers) {
      if (sessionID !== undefined && e.sessionID !== sessionID) continue
      clearTimeout(e.timer)
      permissionTimers.delete(id)
    }
  }
  function watchPermission(d: any): void {
    const id = String(d.id ?? d.requestID ?? "")
    const sessionID = String(d.sessionID ?? "")
    if (!id || !core.isAdvisorSession(sessionID) || permissionTimers.has(id)) return
    permissionTimers.set(id, {
      sessionID,
      timer: setTimeout(() => {
        permissionTimers.delete(id)
        const what = `${String(d.action ?? "tool")} ${String(d.resources?.[0] ?? "")}`.trim()
        log("warn", "advisor permission request timed out; rejected", { sessionID, permission: id, what })
        // 2.1.0 の実装は `decision`、ドキュメントは `reply`。どちらの版でも通るよう両方を送る。
        // Bản 2.1.0 dùng `decision` còn tài liệu ghi `reply`; gửi cả hai để chạy được ở cả hai phiên bản.
        Promise.resolve(ctx.permission.reply({ sessionID, requestID: id, decision: "reject", reply: "reject" })).catch((e) => log("warn", "could not reject an advisor permission request", { error: errMessage(e) }))
      }, cfg.permissionTimeoutMs),
    })
  }

  // ------------------------------------------------------------------ the event stream
  async function onEvent(ev: any): Promise<void> {
    const d = ev?.data ?? {}
    const id: string | undefined = d.sessionID
    const dir: string | undefined = ev.location?.directory
    if (ev.type === "permission.asked") return watchPermission(d)
    if (ev.type === "permission.replied") {
      const rid = String(d.requestID ?? d.id ?? "")
      clearTimeout(permissionTimers.get(rid)?.timer)
      permissionTimers.delete(rid)
      return
    }
    switch (ev.type) {
      case "session.created": {
        if (!id || dir !== directory) return
        mine.set(id, true)
        core.sessionCreated({ id, parentID: d.parentID, title: d.title })
        return
      }
      case "session.deleted":
        if (id) {
          dropPermissionTimers(id)
          mine.delete(id)
          core.sessionDeleted(id)
        }
        return
      default:
        break
    }
    if (!id || !(await isMine(id, dir))) return
    switch (ev.type) {
      case "session.updated":
        core.sessionUpdated({ id, parentID: d.parentID, title: d.title })
        return
      case "session.execution.started":
        core.busyChanged(id, true)
        return
      case "session.step.ended":
        if (core.isAdvisorSession(id)) core.advisorMessage(String(id), { id: String(d.assistantMessageID ?? ""), cost: d.cost, tokens: d.tokens })
        else stepEnded(id, d.assistantMessageID ? String(d.assistantMessageID) : undefined, d.finish)
        return
      case "session.execution.interrupted":
        // サーバー終了による中断はユーザー操作ではない。
        // Ngắt do server tắt không phải do người dùng.
        if (d.reason !== "shutdown") core.userAborted(id)
        core.runEnded(id)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
        core.runEnded(id)
        return
      case "session.compaction.ended":
        core.compacted(id)
        return
      case "session.inbox.enqueued":
        if (d.item?.type === "user") core.realUserMessage(id)
        return
      default:
        return
    }
  }

  void (async () => {
    // 1 件ずつ順に処理する。イベントの順序が意味を持つため。
    // Xử lý tuần tự từng sự kiện vì thứ tự sự kiện có ý nghĩa.
    try {
      for await (const ev of ctx.event.subscribe({ signal: stop.signal })) {
        try {
          await onEvent(ev)
        } catch (e) {
          log("warn", "advisor event handler failed", { type: ev?.type, error: errMessage(e) })
        }
      }
    } catch (e) {
      if (!stop.signal.aborted) log("warn", "advisor event stream ended", { error: errMessage(e) })
    }
  })()

  log("info", "advisor ready", { host: "v2", version, advisors: specs.map((s) => ({ name: s.name, enabled: s.enabled, model: s.model ?? null, tools: s.tools })) })
  return () => {
    stop.abort()
    dropPermissionTimers()
    core.stop()
  }
}

// モデルに送る写しの中で、過去レビューの調査ツール結果をスタブに置き換える。
// Trong bản gửi model, thay kết quả tool điều tra của các review cũ bằng stub.
function evictV2(messages: any[]): void {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i
      break
    }
  }
  for (let i = 0; i < lastUser; i++) {
    const m = messages[i]
    if (m?.role !== "tool" || !Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (part?.type === "tool-result" && isEvictableTool(part.name) && part.result?.type === "text") part.result = { ...part.result, value: EVICTED }
    }
  }
}
