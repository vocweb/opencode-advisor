import type { Msg, MsgPart, TokenUsage } from "../../types.ts"

type Json = Record<string, any>

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
    : ""

function tokens(t: Json | undefined): TokenUsage | undefined {
  if (!t) return undefined
  return { input: t.input ?? 0, output: t.output ?? 0, reasoning: t.reasoning ?? 0, cache: { read: t.cache?.read ?? 0, write: t.cache?.write ?? 0 } }
}

// v2 の tool part を共通形に直す。input は実行中だけ文字列になる。
// Chuyển tool part của v2 về dạng chung; input chỉ là chuỗi khi tool đang chạy.
function toolPart(c: Json): MsgPart {
  const st: Json = c.state ?? {}
  const output = Array.isArray(st.content) ? st.content.map((x: Json) => (x?.type === "text" ? x.text : `[${x?.type ?? "content"}]`)).join("\n") : undefined
  return {
    type: "tool",
    tool: String(c.name ?? "tool"),
    state: {
      status: String(st.status ?? "unknown"),
      input: st.input,
      ...(output !== undefined ? { output } : {}),
      ...(st.error ? { error: st.error.message ?? st.error } : {}),
      ...(st.metadata ? { metadata: st.metadata } : {}),
    },
  }
}

/**
 * One message of `ctx.session.context()` -> our transcript shape.
 * Markers that carry no conversation (idle, compaction) are dropped; everything unknown is skipped rather than guessed.
 */
export function normalizeMessage(m: Json): Msg | undefined {
  const created = m.time?.created ?? 0
  switch (m.type) {
    case "user":
      return {
        info: { id: m.id, role: "user", agent: m.agent, time: { created } },
        parts: [{ type: "text", text: String(m.text ?? ""), ...(m.metadata ? { metadata: m.metadata } : {}) }],
      }
    case "synthetic":
      return {
        info: { id: m.id, role: "user", time: { created } },
        parts: [{ type: "text", text: String(m.text ?? ""), synthetic: true, ...(m.metadata ? { metadata: m.metadata } : {}) }],
      }
    case "assistant": {
      const parts: MsgPart[] = []
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === "text") parts.push({ type: "text", text: String(c.text ?? "") })
        else if (c?.type === "reasoning") parts.push({ type: "reasoning", text: String(c.text ?? "") })
        else if (c?.type === "tool") parts.push(toolPart(c))
      }
      const err = m.error
      return {
        info: {
          id: m.id,
          role: "assistant",
          agent: m.agent,
          mode: m.agent,
          ...(m.model ? { model: { providerID: m.model.providerID, modelID: m.model.id }, providerID: m.model.providerID, modelID: m.model.id } : {}),
          ...(m.model?.variant ? { variant: String(m.model.variant) } : {}),
          time: { created, ...(m.time?.completed ? { completed: m.time.completed } : {}) },
          ...(m.finish ? { finish: m.finish } : {}),
          ...(err ? { error: { name: String(err.type ?? "Error"), data: { message: String(err.message ?? "") } } } : {}),
          cost: m.cost,
          tokens: tokens(m.tokens),
        },
        parts,
      }
    }
    default:
      return undefined
  }
}

export function normalizeTranscript(list: unknown): Msg[] {
  if (!Array.isArray(list)) return []
  const out: Msg[] = []
  for (const m of list) {
    const n = normalizeMessage(m as Json)
    if (n) out.push(n)
  }
  return out
}

/** `text` of the latest assistant message and its tokens/cost/error, used to read the result of an advisor prompt. */
export function lastAssistant(list: unknown): Json | undefined {
  if (!Array.isArray(list)) return undefined
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.type === "assistant") return list[i]
  return undefined
}

export { textOf }
