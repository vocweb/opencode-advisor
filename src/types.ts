import type { PluginInput } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"

export type Client = PluginInput["client"]

export type Severity = "nit" | "concern" | "blocker"

export const SEVERITIES: readonly Severity[] = ["nit", "concern", "blocker"] as const

export const SEVERITY_RANK: Record<Severity, number> = { nit: 1, concern: 2, blocker: 3 }

export interface ModelRef {
  providerID: string
  modelID: string
}

/** One message of a session transcript as returned by `client.session.messages`. */
export interface Msg {
  info: Message
  parts: Part[]
}

export interface Note {
  id: number
  advisor: string
  severity: Severity
  text: string
  createdAt: number
  reviewId: number
  // ノート作成時の主エージェントのターン数。古い助言だと主側が分かるようにするため。
  // Số lượt của primary lúc tạo note, để primary biết advisory đã cũ bao nhiêu lượt.
  turn: number
}

/** Marker stored in `metadata` of every text part this plugin injects, so we never review/echo our own output. */
export const SELF_MARK = "opencodeAdvisor"

/** Prefix of the title of every advisor child session. */
export const ADVISOR_TITLE_PREFIX = "[advisor]"

/** The /advisor command template. opencode rebuilds command messages from it (plugin metadata is dropped), so we recognise our own control prompts by this text. */
export const CONTROL_TEXT = "[opencode-advisor control] Reply with the single word: ok"
