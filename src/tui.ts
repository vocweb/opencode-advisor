import type { Plugin } from "@opencode/plugin/tui"
import { setupTui, type TuiLike } from "./tui-logic.ts"

const SELF_MARK = "opencodeAdvisor"

interface Item {
  id?: string
  type?: string
  description?: string
  text?: string
  metadata?: Record<string, unknown>
}

// /advisor は server 側のコマンドとして実行され、返答は description 付きの synthetic として session に残る。新しく増えた制御用の 1 件を探して返す。
// /advisor chạy ở phía server và câu trả lời để lại trong session dưới dạng synthetic có description; tìm cái điều khiển mới xuất hiện rồi trả về.
async function runAdvisorCommand(client: Plugin.Context["client"], sessionID: string, text: string): Promise<string> {
  const read = async (): Promise<Item[]> => (await client.session.context({ sessionID })) as unknown as Item[]
  const seen = new Set((await read()).map((m) => m.id))
  await client.session.command({ sessionID, name: "advisor", text })
  for (let i = 0; i < 100; i++) {
    const fresh = (await read()).filter((m) => m.type === "synthetic" && m.metadata?.[SELF_MARK] === "control" && !seen.has(m.id))
    const last = fresh.at(-1)
    if (last) return String(last.description ?? last.text ?? "")
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("The advisor did not answer. Is the advisor plugin loaded on the server?")
}

export default {
  id: "opencode-advisor.tui",
  setup(ctx: Plugin.Context) {
    const like: TuiLike = {
      options: ctx.options,
      ui: ctx.ui,
      keymap: ctx.keymap,
      // 型を絞った購読だけを渡す。item の形は tui-logic が防御的に読む。
      // Chỉ đưa ra phần đăng ký đã thu hẹp kiểu; hình dạng của item được tui-logic đọc theo kiểu phòng thủ.
      data: { on: (type, handler) => ctx.data.on(type, (e) => handler({ data: { sessionID: String(e.data.sessionID), item: e.data.item as unknown as never } })) },
      command: (sessionID, text) => runAdvisorCommand(ctx.client, sessionID, text),
    }
    return setupTui(like)
  },
} satisfies Plugin.Definition
