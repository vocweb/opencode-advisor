
export type Severity = "nit" | "concern" | "blocker"

export const SEVERITIES: readonly Severity[] = ["nit", "concern", "blocker"] as const

export const SEVERITY_RANK: Record<Severity, number> = { nit: 1, concern: 2, blocker: 3 }

export interface ModelRef {
  providerID: string
  modelID: string
}

// opencode のバージョンに依存しない会話の型。host ごとの正規化関数がここに揃える。
// Kiểu transcript không phụ thuộc phiên bản opencode; mỗi host chuẩn hóa message của nó về đây.
export interface TokenUsage {
  input: number
  output: number
  reasoning?: number
  cache?: { read: number; write: number }
}

export interface MsgInfo {
  id: string
  role: "user" | "assistant"
  sessionID?: string
  agent?: string
  /** assistant: the agent that produced it (v1 `mode`). */
  mode?: string
  model?: ModelRef
  providerID?: string
  modelID?: string
  parentID?: string
  time: { created: number; completed?: number }
  finish?: string
  summary?: boolean
  error?: { name: string; data?: { message?: string } }
  cost?: number
  tokens?: TokenUsage
}

export interface ToolState {
  status: string
  input?: unknown
  output?: unknown
  error?: unknown
  metadata?: Record<string, unknown>
}

export interface MsgPart {
  type: string
  text?: string
  ignored?: boolean
  synthetic?: boolean
  metadata?: Record<string, unknown>
  tool?: string
  state?: ToolState
  files?: string[]
  [key: string]: unknown
}

export interface Msg {
  info: MsgInfo
  parts: MsgPart[]
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
