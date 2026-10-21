import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { COMMAND_DESCRIPTION } from "../../commands.ts"
import { loadConfig } from "../../config.ts"
import { AdvisorCore } from "../../core.ts"
import type { Logger } from "../../host.ts"
import { LOOP_REMINDER, LOOP_STOPPED } from "../../loopguard.ts"
import { agentNameFor, evictStaleResults, scrubInvestigationResults } from "../../policy.ts"
import { ADVISE_TOOL_DESCRIPTION, buildAdvisorSystemPrompt, PRIMARY_EXPLAINER } from "../../prompts.ts"
import { ensureStarterConfig } from "../../setup.ts"
import { CONTROL_TEXT, SELF_MARK } from "../../types.ts"
import { clip, errMessage, parseModel } from "../../util.ts"
import { createV1Host } from "./host.ts"
import { advisorPermission } from "./permission.ts"

const CONTROL_AGENT = "advisor-ctl"
const CONTROL_TTL_MS = 60_000
// opencode 1.19.3 は dispose を await しない (実測)。将来 await される場合に備えた短い猶予だけ残す。
// opencode 1.19.3 không await dispose (đã đo); chỉ giữ một khoảng chờ ngắn phòng khi phiên bản sau có await.
const DISPOSE_WAIT_MS = 15_000

/** The plugin for opencode 1.x: hooks, events and the hidden agents, all driven by the shared AdvisorCore. */
export async function createV1Hooks(input: PluginInput): Promise<Hooks> {
  // v1 の host にだけ存在するパッケージなので、v1 の経路に入ったときに読み込む。v2 には無くても壊れない。
  // Gói này chỉ có ở host v1 nên nạp khi đi vào đường v1; v2 không có cũng không sao.
  const { tool } = await import("@opencode-ai/plugin")
  const { client } = input
  const log: Logger = (level, message, extra) => {
    Promise.resolve(client.app.log({ body: { service: "opencode-advisor", level, message, ...(extra ? { extra } : {}) } })).catch(() => {})
  }
  const host = createV1Host(client, log)

  const cfg = loadConfig({ directory: input.directory, worktree: input.worktree })
  for (const w of cfg.warnings) log("warn", w)
  if (!cfg.enabled) {
    log("info", "advisor disabled by configuration")
    return {}
  }

  // First run after installing: leave a starter config behind and tell the user once what is still missing.
  const starter = ensureStarterConfig(cfg.sources)
  if (starter.created) log("info", `created starter config ${starter.file}`)
  else if (starter.error) log("warn", `could not create starter config: ${starter.error}`)

  const core = new AdvisorCore({ host, cfg, directory: input.directory, worktree: input.worktree })
  const { registry, specs } = core
  const pendingControl = new Map<string, { text: string; at: number }>()
  const countedSteps = new Set<string>()
  // 拒否される予定の権限要求 (誰も答えなければ時間切れで reject)。
  // Các yêu cầu quyền đang chờ, sẽ bị từ chối nếu không ai trả lời.
  const permissionTimers = new Map<string, { timer: NodeJS.Timeout; sessionID: string }>()
  function dropPermissionTimers(sessionID?: string): void {
    for (const [id, e] of permissionTimers) {
      if (sessionID !== undefined && e.sessionID !== sessionID) continue
      clearTimeout(e.timer)
      permissionTimers.delete(id)
    }
  }

  // ------------------------------------------------------------------ events

  function dispatch(ev: any): void {
    switch (ev.type) {
      case "session.created":
        core.sessionCreated(ev.properties.info)
        // fork は元の履歴のコピーから始まる。全履歴を再生せず、これからの出来事だけを見る (omp の branch/fork と同じ)。
        // Fork bắt đầu từ bản sao lịch sử của session khác; không phát lại cả lịch sử mà chỉ xem những gì xảy ra từ giờ (giống branch/fork của omp).
        if (/\(fork #\d+\)\s*$/.test(String(ev.properties.info.title ?? ""))) core.sessionForked(ev.properties.info.id, ev.properties.info.time?.created)
        break
      case "session.updated":
        core.sessionUpdated(ev.properties.info)
        break
      case "session.deleted":
        dropPermissionTimers(ev.properties.info.id)
        core.sessionDeleted(ev.properties.info.id)
        break
      case "session.status": {
        const { sessionID, status } = ev.properties
        if (!core.isAdvisorSession(sessionID)) core.busyChanged(sessionID, status?.type !== "idle")
        else if (status?.type === "retry") core.retryStatus(sessionID, status)
        break
      }
      // 人間に聞く権限要求は無期限に待たせない。時間切れなら拒否してレビューを先へ進める。
      // Yêu cầu quyền cần người trả lời không được chờ vô hạn: hết hạn thì từ chối để review đi tiếp.
      case "permission.updated":
      case "permission.asked": {
        const p = ev.properties
        const id = String(p?.id ?? p?.requestID ?? "")
        if (!id || !core.isAdvisorSession(p?.sessionID) || permissionTimers.has(id)) break
        const sessionID = String(p.sessionID)
        permissionTimers.set(id, {
          sessionID,
          timer: setTimeout(() => {
            permissionTimers.delete(id)
            const what = `${String(p?.permission ?? "tool")} ${String(p?.patterns?.[0] ?? p?.title ?? "")}`.trim()
            log("warn", "advisor permission request timed out; rejected", { sessionID, permission: id, what })
            if (cfg.toast) host.toast(`An advisor asked for permission (${clip(what, 80)}) and nobody answered; it was rejected.`, "warning")
            Promise.resolve(client.postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID: id }, body: { response: "reject" } })).catch(() => {})
          }, cfg.permissionTimeoutMs),
        })
        break
      }
      case "permission.replied": {
        const id = String(ev.properties?.requestID ?? ev.properties?.permissionID ?? ev.properties?.id ?? "")
        clearTimeout(permissionTimers.get(id)?.timer)
        permissionTimers.delete(id)
        break
      }
      case "session.error": {
        const { sessionID, error } = ev.properties
        if (sessionID && error?.name === "MessageAbortedError") core.userAborted(sessionID)
        break
      }
      case "message.updated": {
        const info = ev.properties.info
        if (info.role !== "assistant") break
        if (core.isAdvisorSession(info.sessionID)) {
          if (info.time?.completed) core.advisorMessage(info.sessionID, info)
          break
        }
        if (!info.time?.completed) break
        // fork 直後に再送される、コピーされた過去の message は新しい作業ではないので数えない。
        // Message cũ được sao chép gửi lại ngay sau khi fork không phải việc mới nên không đếm.
        if (core.isCopiedMessage(info.sessionID, info.time?.created)) break
        // opencode は完了後の assistant message に対しても message.updated を再送しうる。id ごとに 1 回だけ数える。
        // opencode có thể gửi lại message.updated cho assistant đã hoàn tất; chỉ đếm mỗi id một lần.
        if (countedSteps.has(info.id)) break
        countedSteps.add(info.id)
        if (countedSteps.size > 2000) countedSteps.delete(countedSteps.values().next().value as string)
        core.stepCompleted(info.sessionID, info.finish)
        break
      }
      case "session.idle": {
        const id = ev.properties.sessionID
        pendingControl.delete(id)
        core.runEnded(id)
        break
      }
      case "session.compacted":
        core.compacted(ev.properties.sessionID)
        break
      // revert で履歴が書き換わると cursor が存在しない履歴を指す。compaction と同じく advisor を作り直す。
      // Revert làm lịch sử bị viết lại nên cursor trỏ vào chỗ không còn; giống compaction, dựng lại advisor.
      case "message.removed":
        core.historyRewritten(ev.properties.sessionID)
        break
    }
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
        if (v === true) core.frontAdvisor.set(name, "on")
        else if (v === false) core.frontAdvisor.set(name, "off")
        else if (typeof v === "string" && v.trim()) core.frontAdvisor.set(name, v.trim())
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
      core.realUserMessage(i.sessionID)
    },

    "command.execute.before": async (i) => {
      if (i.command !== "advisor") return
      let text: string
      try {
        text = await core.control(i.sessionID, i.arguments ?? "")
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

    // advisor が同じ調査ツールを同じ引数で繰り返したら注意し、さらに繰り返せば review を打ち切る。throw した内容はモデルにツールエラーとして見える。
    // Khi advisor lặp lại cùng tool và tham số thì nhắc, lặp nữa thì dừng review; nội dung ném ra hiện cho model như lỗi của tool.
    // service tier を付ける。advisor の request には設定どおり、primary の request からは現在の tier を控えておく ("inherit" 用)。
    // Gắn service tier: request của advisor theo cấu hình; với request của primary thì ghi nhớ tier hiện tại (dùng cho "inherit").
    "chat.params": async (i, o) => {
      if (core.isAdvisorSession(i.sessionID)) {
        const tier = core.advisorServiceTier(i.sessionID, String(i.model.providerID))
        if (tier) o.options.serviceTier = tier
      } else core.noteServiceTier(i.sessionID, o.options.serviceTier)
    },

    "tool.execute.before": async (i, o) => {
      if (!core.isAdvisorSession(i.sessionID)) return
      const verdict = core.advisorToolCall(i.sessionID, i.tool, o.args)
      if (verdict === "remind") throw new Error(LOOP_REMINDER)
      if (verdict === "abort") throw new Error(LOOP_STOPPED)
    },

    "experimental.chat.messages.transform": async (_i, o) => {
      const sid = o.messages.at(-1)?.info.sessionID
      if (!sid) return
      if (core.isAdvisorSession(sid)) {
        scrubInvestigationResults(o.messages as any)
        if (cfg.evictStaleResults) evictStaleResults(o.messages as any)
        return
      }
      const lastUser = [...o.messages].reverse().find((m) => m.info.role === "user")
      const isControl = lastUser?.parts.some((p) => p.type === "text" && p.text.startsWith(CONTROL_TEXT)) === true
      await core.beforeModelCall(sid, { isControl })
      if (core.disabledSessions.has(sid)) return
      const aside = core.takeAsideText(sid)
      if (!aside) return
      let target: (typeof o.messages)[number] | undefined
      for (let k = o.messages.length - 1; k >= 0; k--) {
        if (o.messages[k]!.info.role === "user") {
          target = o.messages[k]
          break
        }
      }
      if (!target) {
        aside.putBack()
        return
      }
      target.parts.push({
        id: `prt_advisor_${Date.now().toString(36)}`,
        sessionID: sid,
        messageID: target.info.id,
        type: "text",
        text: aside.text,
        synthetic: true,
        metadata: { [SELF_MARK]: true },
      } as any)
    },

    "experimental.chat.system.transform": async (i, o) => {
      if (!cfg.explainToPrimary || !i.sessionID || core.disabledSessions.has(i.sessionID) || core.isAdvisorSession(i.sessionID)) return
      o.system.push(PRIMARY_EXPLAINER)
    },

    dispose: async () => {
      dropPermissionTimers()
      await core.shutdown(DISPOSE_WAIT_MS)
    },
  }

  log("info", "advisor ready", { advisors: specs.map((s) => ({ name: s.name, enabled: s.enabled, model: s.model ?? null, tools: s.tools, mode: s.reviewMode })) })
  return hooks
}
