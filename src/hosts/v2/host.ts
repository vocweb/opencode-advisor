import type { AdvisorChild, DeliverMode, DeliverOptions, Host, Logger, PromptInput, PromptResult } from "../../host.ts"
import { renderAdvisories } from "../../prompts.ts"
import { ADVISOR_TITLE_PREFIX, SELF_MARK, type Msg, type Note } from "../../types.ts"
import { lastAssistant, normalizeTranscript } from "./normalize.ts"

// プラグイン文脈 (ctx) は実行時に型なしで受け取る。使うメンバーだけを緩く書き、足りなければ呼び出し側が検出する。
// ctx của plugin v2 nhận lúc chạy không có kiểu; chỉ mô tả lỏng các thành viên cần dùng, thiếu thì nơi gọi phát hiện.
export type V2Ctx = Record<string, any>

// host に提供される toast API は無い。TUI プラグインが入るまでは log だけにする。
// Server plugin v2 không có API toast; tới khi có plugin TUI thì chỉ ghi log.
export function createV2Host(ctx: V2Ctx, log: Logger): Host {
  const session = ctx.session
  // advisor session ごとに、最後に設定した agent と model を覚えて無駄な切替を避ける。
  // Nhớ agent và model đã đặt cho từng session advisor để khỏi chuyển lại vô ích.
  const applied = new Map<string, { agent?: string; model?: string }>()

  async function transcript(sessionID: string, limit?: number): Promise<Msg[]> {
    const all = normalizeTranscript(await session.context({ sessionID }))
    return limit ? all.slice(-limit) : all
  }

  async function info(sessionID: string): Promise<Record<string, any>> {
    return (await session.get({ sessionID })) as Record<string, any>
  }

  return {
    kind: "v2",
    log,
    transcript,

    async sessionInfo(id) {
      const s = await info(id)
      return { id: String(s.id ?? id), parentID: s.parentID, title: s.title, directory: s.location?.directory }
    },

    async firstAgent(id) {
      const s = await info(id)
      if (s.agent) return String(s.agent)
      for (const m of await transcript(id, 100)) if (m.info.role === "assistant") return m.info.agent
      return undefined
    },

    // 今の agent。session に agent が無ければ最後の assistant の agent を使う。
    // Agent hiện tại: nếu session chưa đặt agent thì dùng agent của tin assistant cuối.
    async activeAgent(id) {
      const s = await info(id)
      if (s.agent) return String(s.agent)
      const msgs = await transcript(id, 20)
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.info.role === "assistant") return msgs[i]!.info.agent
      return undefined
    },

    async createAdvisorSession({ parentID, title, name, agent }) {
      const created = (await session.create({ parentID, title, agent, metadata: { advisorFor: parentID, advisor: name } })) as { id: string }
      applied.set(created.id, { agent })
      return created.id
    },

    async promptAdvisor(sessionID: string, input: PromptInput): Promise<PromptResult> {
      const state = applied.get(sessionID) ?? {}
      if (state.agent !== input.agent) {
        await session.switchAgent({ sessionID, agent: input.agent })
        state.agent = input.agent
      }
      const modelKey = `${input.model.providerID}/${input.model.modelID}:${input.level ?? ""}`
      if (state.model !== modelKey) {
        await session.switchModel({ sessionID, model: { providerID: input.model.providerID, id: input.model.modelID, ...(input.level ? { variant: input.level } : {}) } })
        state.model = modelKey
      }
      applied.set(sessionID, state)

      await session.prompt({ sessionID, text: input.text })
      await session.wait({ sessionID }, { signal: input.signal })

      const list = (await session.context({ sessionID })) as Record<string, any>[]
      const a = lastAssistant(list)
      const tail = list.at(-1)
      if (a?.error) {
        const type = String(a.error.type ?? "Error")
        return {
          id: a.id,
          cost: a.cost,
          tokens: a.tokens,
          error: { name: type === "aborted" ? "MessageAbortedError" : type, message: String(a.error.message ?? ""), permanent: /auth|credential/i.test(type) },
        }
      }
      // 中断された実行は error なしで idle(interrupted) だけが残ることがある。
      // Lượt bị ngắt có thể chỉ để lại idle(interrupted) mà không có error.
      if (tail?.type === "idle" && tail.outcome && tail.outcome !== "succeeded") {
        return { id: a?.id, error: { name: tail.outcome === "interrupted" ? "MessageAbortedError" : "ExecutionFailed", message: String(tail.outcome) } }
      }
      return { id: a?.id, cost: a?.cost, tokens: a?.tokens }
    },

    async abort(id) {
      await session.interrupt({ sessionID: id, continue: false })
    },

    async advisorChildren(primaryID): Promise<AdvisorChild[]> {
      const page = (await session.list({ parentID: primaryID })) as { data?: Record<string, any>[] }
      return (page.data ?? [])
        .filter((c) => typeof c.title === "string" && c.title.startsWith(ADVISOR_TITLE_PREFIX))
        .map((c) => ({ id: String(c.id), title: String(c.title), created: c.time?.created }))
        .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
    },

    // 助言は synthetic メッセージとして入れる。resume:true なら実行中は次のステップに、待機中ならその場で agent を起こす。
    // card は resume:false で入れ、description をユーザーに見せる。
    // Advisory đi vào dưới dạng synthetic: resume:true thì chèn ở bước kế khi đang chạy, hoặc đánh thức agent khi rảnh; card dùng resume:false và description hiển thị cho người dùng.
    async deliver(primaryID, notes: Note[], mode: DeliverMode, opts: DeliverOptions) {
      const text = renderAdvisories(notes, { nowTurn: opts.nowTurn, guidance: opts.guidance })
      const sent = (await session.synthetic({
        sessionID: primaryID,
        text,
        ...(mode === "card" ? { description: text } : {}),
        resume: mode !== "card",
        delivery: "steer",
        metadata: { [SELF_MARK]: true },
      })) as { id?: string } | undefined
      return sent?.id
    },

    toast(message, variant) {
      log(variant === "error" ? "error" : "info", `toast: ${message}`)
    },
  }
}
