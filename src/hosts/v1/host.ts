import type { PluginInput } from "@opencode-ai/plugin"
import type { AdvisorChild, DeliverMode, DeliverOptions, Host, Logger, PromptInput, PromptResult } from "../../host.ts"
import { renderAdvisories } from "../../prompts.ts"
import { isSelfMessage } from "../../render.ts"
import { ADVISOR_TITLE_PREFIX, SELF_MARK, type ModelRef, type Msg, type Note } from "../../types.ts"
import { clip, errMessage } from "../../util.ts"

export type V1Client = PluginInput["client"]

const RECHECK_MS = 1500

// SDK の戻り値は { data } か { error }。ここで一度だけ剥がす。
// Kết quả SDK là { data } hoặc { error }; bóc ra một lần duy nhất ở đây.
export function unwrap<T = any>(res: any): T {
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error(errMessage(res.error))
  if (res && typeof res === "object" && "data" in res) return res.data as T
  return res as T
}

/** The host for opencode 1.x (the `@opencode-ai/sdk` v1 client). */
export function createV1Host(client: V1Client, log: Logger): Host {
  async function transcript(id: string, limit?: number): Promise<Msg[]> {
    return unwrap<Msg[]>(await client.session.messages({ path: { id }, ...(limit ? { query: { limit } } : {}) }))
  }

  async function lastUser(id: string): Promise<{ agent?: string; model?: ModelRef } | undefined> {
    try {
      const msgs = await transcript(id, 40)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!
        if (m.info.role !== "user") continue
        // Skip our own cards and /advisor control prompts: the latter run under the tool-less advisor-ctl agent.
        if (isSelfMessage(m) || String(m.info.agent ?? "").startsWith("advisor")) continue
        return { agent: m.info.agent, model: m.info.model }
      }
    } catch (e) {
      log("debug", "lastUser lookup failed", { error: errMessage(e) })
    }
    return undefined
  }

  // 直前のユーザーメッセージの agent と model を写す。opencode は最新の user message の agent/model で次のステップを実行するため。
  // Sao chép agent và model của tin nhắn người dùng trước đó: opencode chạy bước kế theo agent/model của user message mới nhất.
  async function post(primaryID: string, notes: Note[], noReply: boolean, opts: DeliverOptions): Promise<string | undefined> {
    const last = await lastUser(primaryID)
    const res = unwrap<{ info?: { id?: string } }>(
      await client.session.prompt({
        path: { id: primaryID },
        body: {
          noReply,
          ...(last?.agent ? { agent: last.agent } : {}),
          ...(last?.model ? { model: last.model } : {}),
          parts: [{ type: "text", text: renderAdvisories(notes, { nowTurn: opts.nowTurn, guidance: opts.guidance }), metadata: { [SELF_MARK]: true } }],
        },
      }),
    )
    return res?.info?.id
  }

  return {
    log,
    transcript,

    async sessionInfo(id) {
      const s = unwrap<{ id: string; parentID?: string; title?: string }>(await client.session.get({ path: { id } }))
      return { id: s.id, parentID: s.parentID, title: s.title }
    },

    // messages の limit は末尾 N 件を返すため先頭の user が取れないことがある。assistant の mode が同じ agent 名を持つ。
    // messages({limit}) trả N tin cuối nên có thể mất user đầu tiên; mode của assistant mang cùng tên agent.
    async firstAgent(id) {
      for (const m of await transcript(id, 100)) {
        if (m.info.role === "user") return m.info.agent
        if (m.info.role === "assistant") return m.info.mode
      }
      return undefined
    },

    async activeAgent(id) {
      return (await lastUser(id))?.agent
    },

    async createAdvisorSession({ parentID, title }) {
      return unwrap<{ id: string }>(await client.session.create({ body: { parentID, title } })).id
    },

    async promptAdvisor(sessionID: string, input: PromptInput): Promise<PromptResult> {
      const data = unwrap<{ info?: any }>(
        await client.session.prompt({
          path: { id: sessionID },
          body: { agent: input.agent, model: input.model, ...(input.level ? { variant: input.level } : {}), parts: [{ type: "text", text: input.text }] },
          signal: input.signal,
        } as any),
      )
      const info = data?.info
      return {
        id: info?.id,
        cost: info?.cost,
        tokens: info?.tokens,
        ...(info?.error
          ? { error: { name: String(info.error.name ?? "Error"), message: String(info.error.data?.message ?? ""), permanent: info.error.name === "ProviderAuthError" } }
          : {}),
      }
    },

    async abort(id) {
      await client.session.abort({ path: { id } })
    },

    // 要約に失敗したら false を返し、呼び出し側が作り直す。要約はモデル呼び出しを伴うので、失敗しても例外にはしない。
    // Tóm tắt thất bại thì trả false để bên gọi dựng lại session; việc tóm tắt cần gọi model nên không ném lỗi khi thất bại.
    async compactAdvisor(id, model) {
      try {
        unwrap(await client.session.summarize({ path: { id }, body: { providerID: model.providerID, modelID: model.modelID } } as any))
        // provider の失敗は HTTP エラーにならず、要約メッセージの error として残る。最新の要約メッセージが正常に完了したかを確かめる。
        // Lỗi của provider không thành lỗi HTTP mà nằm trong error của message tóm tắt; phải kiểm tra message tóm tắt mới nhất có hoàn tất bình thường không.
        const msgs = unwrap<{ info: { role: string; summary?: boolean; error?: unknown; time?: { completed?: number } } }[]>(await client.session.messages({ path: { id }, query: { limit: 6 } } as any))
        const last = [...msgs].reverse().find((m) => m.info.role === "assistant" && m.info.summary)
        return !!last && !last.info.error && !!last.info.time?.completed
      } catch {
        return false
      }
    },

    async advisorChildren(primaryID): Promise<AdvisorChild[]> {
      const list = unwrap<{ id: string; title: string; time?: { created?: number } }[]>(await client.session.children({ path: { id: primaryID } }))
      return list
        .filter((c) => typeof c.title === "string" && c.title.startsWith(ADVISOR_TITLE_PREFIX))
        .map((c) => ({ id: c.id, title: c.title, created: c.time?.created }))
        .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
    },

    async deliver(primaryID, notes, mode: DeliverMode, opts) {
      if (mode === "wake") {
        // Starts (and awaits) a whole primary turn: the caller must not wait for it.
        // 主ターン全体を待つので、呼び出し側をブロックしない。
        // Chờ cả một lượt primary nên không được chặn caller.
        void post(primaryID, notes, false, opts).catch((e) => log("warn", "advisor wake failed", { error: errMessage(e), session: primaryID }))
        return undefined
      }
      return post(primaryID, notes, true, opts)
    },

    // 注入の直後に実行が終わっていたら、助言が読まれないままになる。少し待って確認し、必要なら起こす。
    // Nếu run kết thúc ngay sau khi chèn thì advisory chưa được đọc; đợi một chút rồi kiểm tra và đánh thức nếu cần.
    async afterInject(primaryID, postedID, state) {
      if (!postedID) return
      await new Promise((r) => setTimeout(r, RECHECK_MS))
      const s = state()
      if (s.busy || s.suppressed) return
      const msgs = await transcript(primaryID, 10)
      const idx = msgs.findIndex((m) => m.info.id === postedID)
      if (idx < 0) return
      if (msgs.slice(idx + 1).some((m) => m.info.role === "assistant")) return // already consumed
      const last = await lastUser(primaryID)
      unwrap(
        await client.session.prompt({
          path: { id: primaryID },
          body: {
            ...(last?.agent ? { agent: last.agent } : {}),
            ...(last?.model ? { model: last.model } : {}),
            parts: [{ type: "text", text: "(Advisor) The advisory above arrived as you were finishing. Address it now.", metadata: { [SELF_MARK]: true } }],
          },
        }),
      )
      log("info", "advisory re-woken after the run ended", { session: primaryID })
    },

    toast(message, variant, title = "Advisor") {
      void Promise.resolve(client.tui.showToast({ body: { title, message: clip(message, 280), variant, duration: 10_000 } })).catch(() => {})
    },
  }
}
