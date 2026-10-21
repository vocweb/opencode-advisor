import { CONTROL_TEXT, SELF_MARK, type Msg, type MsgPart } from "./types.ts"
import { redact } from "./redact.ts"
import { escapeLt, truncateMiddle } from "./util.ts"

export interface RenderOptions {
  maxMessageChars: number
  maxToolInputChars: number
  maxToolOutputChars: number
  maxEditChars: number
  includeReasoning: boolean
}

/** Tools whose input *is* the change; the advisor must see it to review it. */
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch", "applypatch", "notebookedit"])

type AnyPart = MsgPart & Record<string, any>

/** True for text we injected ourselves (advisory cards, control-command prompts). */
export function isSelfPart(p: AnyPart): boolean {
  if (p.type !== "text") return false
  if (p.metadata && (p.metadata as Record<string, unknown>)[SELF_MARK]) return true
  return typeof p.text === "string" && (p.text.trimStart().startsWith("<advisory") || p.text.startsWith(CONTROL_TEXT))
}

export function isSelfMessage(m: Msg): boolean {
  return m.info.role === "user" && m.parts.some((p) => isSelfPart(p as AnyPart))
}

/** Our own /advisor control prompt (its assistant reply is noise). Advisory cards are NOT control messages. */
export function isControlMessage(m: Msg): boolean {
  return (
    m.info.role === "user" &&
    m.parts.some((p) => p.type === "text" && ((p as AnyPart).metadata?.[SELF_MARK] === "control" || String((p as AnyPart).text ?? "").startsWith(CONTROL_TEXT)))
  )
}

function textOf(parts: MsgPart[]): string {
  return parts
    .filter((p): p is AnyPart => p.type === "text" && !(p as AnyPart).ignored)
    .map((p) => p.text as string)
    .join("\n")
    .trim()
}

function json(v: unknown, max: number): string {
  let s: string
  try {
    s = typeof v === "string" ? v : JSON.stringify(v)
  } catch {
    s = String(v)
  }
  return truncateMiddle(s ?? "", max)
}

function renderTool(p: AnyPart, o: RenderOptions): string {
  const name = String(p.tool ?? "tool")
  const st = p.state as Record<string, any> | undefined
  const isEdit = EDIT_TOOLS.has(name.toLowerCase())
  const inMax = isEdit ? o.maxEditChars : o.maxToolInputChars
  const outMax = isEdit ? o.maxToolOutputChars : o.maxToolOutputChars
  const attrs = `name="${escapeLt(name)}" status="${escapeLt(String(st?.status ?? "unknown"))}"`
  const lines: string[] = [`<tool ${attrs}>`]
  if (st?.input !== undefined) lines.push(`<input>${escapeLt(json(st.input, inMax))}</input>`)
  if (st?.status === "completed") {
    const diff = st.metadata && typeof st.metadata.diff === "string" ? st.metadata.diff : undefined
    if (isEdit && diff) lines.push(`<diff>${escapeLt(truncateMiddle(diff, o.maxEditChars))}</diff>`)
    lines.push(`<output>${escapeLt(truncateMiddle(String(st.output ?? ""), outMax))}</output>`)
  } else if (st?.status === "error") {
    lines.push(`<error>${escapeLt(truncateMiddle(String(st.error ?? ""), outMax))}</error>`)
  }
  lines.push("</tool>")
  return lines.join("\n")
}

// opencode が付ける <system-reminder> は人間の入力ではない。plan mode のものは制約として原文を残し、他は 1 行に畳む。
// <system-reminder> do opencode thêm vào không phải đầu vào của người dùng; loại plan mode thì giữ nguyên văn như ràng buộc, còn lại gấp thành một dòng.
const REMINDER_RE = /^\s*<system-reminder>/i
const PLAN_MODE_RE = /plan mode/i
const isReminder = (p: AnyPart): boolean => p.type === "text" && p.synthetic === true && typeof p.text === "string" && REMINDER_RE.test(p.text)

function renderReminders(parts: AnyPart[], o: RenderOptions, seen: Set<string>): string[] {
  const out: string[] = []
  for (const p of parts) {
    const text = String(p.text ?? "").trim()
    if (PLAN_MODE_RE.test(text)) {
      // 同じ制約が毎ターン繰り返されるので、同一内容は一度だけ出す。
      // Cùng một ràng buộc lặp lại mỗi lượt nên nội dung giống hệt chỉ xuất hiện một lần.
      if (seen.has(text)) continue
      seen.add(text)
      out.push(`<primary-context kind="plan-mode">${escapeLt(truncateMiddle(text, o.maxMessageChars))}</primary-context>`)
    } else {
      out.push(`<hidden>${escapeLt(truncateMiddle(text.replace(/<\/?system-reminder>/gi, "").replace(/\s+/g, " ").trim(), 120))}</hidden>`)
    }
  }
  return out
}

export function renderMessage(m: Msg, o: RenderOptions, seen: Set<string> = new Set()): string {
  const info = m.info
  if (info.role === "user") {
    const parts = m.parts as AnyPart[]
    const reminders = renderReminders(parts.filter(isReminder), o, seen)
    const t = textOf(parts.filter((p) => !isReminder(p)))
    const files = parts.filter((p) => p.type === "file").length
    if (!t && !files && reminders.length > 0) return reminders.join("\n")
    const body = (t || "(no text)") + (files ? `\n(+${files} attached file${files > 1 ? "s" : ""})` : "")
    return [...reminders, `<user id="${info.id}">\n${escapeLt(truncateMiddle(body, o.maxMessageChars))}\n</user>`].join("\n")
  }
  const a = info
  const out: string[] = []
  const attrs = [`id="${a.id}"`, `model="${escapeLt(`${a.providerID}/${a.modelID}`)}"`]
  if (a.finish) attrs.push(`finish="${escapeLt(a.finish)}"`)
  if (a.summary) attrs.push(`summary="true"`)
  if (a.error) attrs.push(`error="${escapeLt(a.error.name)}"`)
  out.push(`<assistant ${attrs.join(" ")}>`)
  for (const p of m.parts as AnyPart[]) {
    if (p.ignored) continue
    switch (p.type) {
      case "text":
        if (p.text) out.push(escapeLt(truncateMiddle(String(p.text), o.maxMessageChars)))
        break
      case "reasoning":
        if (o.includeReasoning && p.text) out.push(`<reasoning>${escapeLt(truncateMiddle(String(p.text), o.maxMessageChars))}</reasoning>`)
        break
      case "tool":
        out.push(renderTool(p, o))
        break
      case "patch":
        if (Array.isArray((p as any).files) && (p as any).files.length)
          out.push(`<patch files="${escapeLt((p as any).files.slice(0, 20).join(", "))}"/>`)
        break
      default:
        break
    }
  }
  out.push("</assistant>")
  return out.join("\n")
}

/** Render a delta; everything is passed through secret redaction as the last step. */
export function renderDelta(msgs: Msg[], o: RenderOptions): string {
  const controlUsers = new Set<string>()
  const seenReminders = new Set<string>()
  const chunks: string[] = []
  for (const m of msgs) {
    if (m.info.role === "user") {
      if (isControlMessage(m)) controlUsers.add(m.info.id)
      // Advisory cards are skipped too (the advisor wrote them), but the primary's *reaction* to one stays visible.
      if (isSelfMessage(m)) continue
    } else if ((m.info as { agent?: string }).agent === "advisor-ctl" || controlUsers.has((m.info as { parentID?: string }).parentID ?? "")) {
      continue // assistant reply to one of our own control prompts
    }
    chunks.push(renderMessage(m, o, seenReminders))
  }
  return redact(chunks.join("\n"))
}
