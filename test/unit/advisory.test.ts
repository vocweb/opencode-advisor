import { test } from "node:test"
import assert from "node:assert/strict"
import { evictStaleResults } from "../../src/plugin.ts"
import { renderAdvisories, renderAdvisory } from "../../src/prompts.ts"
import type { Msg, Note } from "../../src/types.ts"

const tool = (name: string, output: string, status = "completed") => ({ type: "tool", tool: name, state: { status, input: {}, output } })
const msg = (role: string, ...parts: unknown[]) => ({ info: { role }, parts }) as unknown as Msg

test("evictStaleResults: only completed read/grep/glob outputs before the current review prompt are stubbed", () => {
  const messages = [
    msg("user", { type: "text", text: "update 1" }),
    msg("assistant", tool("read", "OLD FILE"), tool("grep", "OLD GREP"), tool("bash", "KEEP BASH"), tool("glob", "pending", "running"), tool("advise", "Accepted.")),
    msg("user", { type: "text", text: "update 2 (current)" }),
    msg("assistant", tool("read", "CURRENT FILE")),
  ]
  evictStaleResults(messages)
  const out = (m: number, p: number) => (messages[m]!.parts[p] as unknown as { state: { output: string } }).state.output
  assert.match(out(1, 0), /evicted/)
  assert.match(out(1, 1), /evicted/)
  assert.equal(out(1, 2), "KEEP BASH")
  assert.equal(out(1, 3), "pending", "an unfinished call is left alone")
  assert.equal(out(1, 4), "Accepted.", "advise acknowledgements stay")
  assert.equal(out(3, 0), "CURRENT FILE", "tool calls after the last prompt belong to the current review")
})

test("renderAdvisory: stale notes say how old they are; guidance only on the first advisory of a batch", () => {
  const n = (text: string, turn: number): Note => ({ id: 1, advisor: "advisor", severity: "concern", text, createdAt: 0, reviewId: 1, turn })
  const fresh = renderAdvisory(n("now", 5), { nowTurn: 5 })
  assert.doesNotMatch(fresh, /turns_ago|T-/)
  const old = renderAdvisory(n("then", 2), { nowTurn: 5 })
  assert.match(old, /turns_ago="3"/)
  assert.match(old, /\nT-3\nthen\n/)
  const batch = renderAdvisories([n("a", 5), n("b", 5)], { nowTurn: 5, guidance: true })
  assert.equal(batch.match(/guidance=/g)?.length, 1)
})
