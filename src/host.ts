import type { ModelRef, Msg, Note, TokenUsage } from "./types.ts"

export type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

// advisor の応答。host ごとのエラー形式を、ここで共通の形に揃える。
// Kết quả của một lần prompt advisor; mỗi host đưa định dạng lỗi riêng của nó về dạng chung này.
export interface PromptResult {
  id?: string
  /** `name` is the provider error type (e.g. "APIError", "provider.rate-limit"); it is used to classify the failure. */
  error?: { name: string; message: string; permanent?: boolean }
  tokens?: TokenUsage
  cost?: number
}

export interface AdvisorChild {
  id: string
  title: string
  created?: number
}

export type DeliverMode = "inject" | "wake" | "card"

export interface DeliverOptions {
  nowTurn: number
  guidance: boolean
}

export interface PromptInput {
  agent: string
  model: ModelRef
  /** Thinking level of the model selector ("high", ...), when the host can pass one. */
  level?: string
  text: string
  signal: AbortSignal
}

/**
 * Everything the advisor core needs from opencode.
 * v1 and v2 each implement it; the core (runtime, delivery, commands, route, guard, config...) never touches an SDK.
 */
export interface Host {
  readonly log: Logger

  /** Transcript of any session in a normalized shape; `limit` = the last N messages (all when omitted). */
  transcript(sessionID: string, limit?: number): Promise<Msg[]>
  /** The session's parent and title (used to tell advisor sessions and subagents apart). */
  sessionInfo(sessionID: string): Promise<{ id: string; parentID?: string; title?: string; directory?: string }>
  /** The agent a (sub)session was started with: used to decide whether a subagent is advised. */
  firstAgent(sessionID: string): Promise<string | undefined>
  /** The agent of the latest real user message (our own advisories and control prompts skipped); `plan` means plan mode. */
  activeAgent(sessionID: string): Promise<string | undefined>

  createAdvisorSession(input: { parentID: string; title: string; name: string; agent: string }): Promise<string>
  /** Run one advisor prompt to completion. Never throws for provider errors: they come back in `error`. */
  promptAdvisor(sessionID: string, input: PromptInput): Promise<PromptResult>
  abort(sessionID: string): Promise<void>
  /**
   * Ask the host to summarize an advisor session so it can keep going instead of being rebuilt.
   * Returns false when the host cannot do it or it failed; the caller then re-primes. Absent on hosts without a usable summarize.
   */
  compactAdvisor?(sessionID: string, model: ModelRef): Promise<boolean>
  /** Rebuild the advisors' agent definitions (tools, instructions) after a configuration change; absent when the host cannot. */
  refreshAgents?(): Promise<void>
  /**
   * Whether the host's model catalog contains `model`; undefined when that cannot be determined.
   * Used to tell "the model does not exist (yet)" from other failures, because some hosts report it only as an opaque error.
   */
  modelAvailable?(model: ModelRef): Promise<boolean | undefined>
  /** Sessions created for the advisors of `primaryID`, oldest first (for status/dump and restarts). */
  advisorChildren(primaryID: string): Promise<AdvisorChild[]>

  /** Put advisories into the primary session. Returns the id of the posted message when the host has one. */
  deliver(primaryID: string, notes: Note[], mode: DeliverMode, opts: DeliverOptions): Promise<string | undefined>
  /**
   * After an `inject`: v1 cannot tell whether the run ended before the message was read, so it re-checks and wakes the agent.
   * `state()` returns the live busy/suppressed flags. Hosts that deliver natively (v2) omit this.
   */
  afterInject?(primaryID: string, postedID: string | undefined, state: () => { busy: boolean; suppressed: boolean }): Promise<void>

  /** `sessionID` ties a notice to a session so hosts without a toast API can still show it in that session. */
  toast(message: string, variant: "info" | "warning" | "error", title?: string, sessionID?: string): void
}
