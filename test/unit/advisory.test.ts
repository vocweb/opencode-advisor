import { test } from "node:test"
import assert from "node:assert/strict"
import { evictStaleResults, scrubInvestigationResults, scrubSecretOutput, SECRET_HIDDEN } from "../../src/policy.ts"
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

test("scrubSecretOutput: matches from secret files are hidden in grep/glob output, other files and redactable tokens are handled", () => {
  const grep = ["Found 3 matches", "/p/.env:", "  Line 1: DB=hunter2hunter2", "/p/src/a.ts:", "  Line 9: const x = 1", "/p/config/secrets.yml:12:password: x1"].join("\n")
  const out = scrubSecretOutput(grep)
  assert.ok(!out.includes("hunter2hunter2") && !out.includes("password: x1"), out)
  assert.ok(out.includes("const x = 1") && out.includes("Found 3 matches"))
  assert.ok(out.includes(SECRET_HIDDEN))
  assert.equal(scrubSecretOutput("/p/.env\n/p/src/a.ts"), `${SECRET_HIDDEN}\n/p/src/a.ts`, "glob output lists one path per line")
  assert.equal(scrubSecretOutput("/p/src/a.ts:3:const apiKey = \"abc12345678xyz\"").includes("abc12345678xyz"), false, "redaction still applies to other files")
})

test("scrubInvestigationResults: rewrites read/grep/glob tool parts and leaves other tools alone", () => {
  const msgs = [msg("assistant", tool("grep", "/p/.env:\n  Line 1: K=v1v1v1v1v1"), tool("bash", "/p/.env:\n  Line 1: K=keep"))]
  scrubInvestigationResults(msgs)
  const [g, b] = msgs[0]!.parts as unknown as { state: { output: string } }[]
  assert.equal(g!.state.output, SECRET_HIDDEN)
  assert.ok(b!.state.output.includes("K=keep"))
})
