import { test } from "node:test"
import assert from "node:assert/strict"
import { advisorPermission } from "../../src/hosts/v1/permission.ts"
import type { AdvisorSpec } from "../../src/config.ts"

const spec = (tools: string[]) => ({ tools }) as unknown as AdvisorSpec

test("advisorPermission: investigative tools never ask, writes follow the user's rule and ask when there is none", () => {
  const p = advisorPermission(spec(["read", "grep", "glob", "edit", "bash"]))
  assert.equal(p["*"], "deny")
  assert.equal(p.grep, "allow")
  assert.equal(p.glob, "allow")
  assert.equal(p.edit, "ask")
  assert.equal(p.bash, "ask")
  assert.equal((p.read as Record<string, string>)["*.env"], "deny", "secret files stay denied")
})

test("advisorPermission: a plain string rule, a '*' rule and a pattern map are carried over as the user wrote them (repo files cannot grant write tools, see config.ts)", () => {
  assert.equal(advisorPermission(spec(["edit"]), "allow").edit, "allow")
  assert.equal(advisorPermission(spec(["edit"]), { "*": "allow" }).edit, "allow")
  const bash = { "*": "ask", "git *": "allow" }
  assert.deepEqual(advisorPermission(spec(["bash"]), { bash }).bash, bash)
})

test("advisorPermission: a tool's own rule beats '*', and a tool that is not granted stays denied", () => {
  const p = advisorPermission(spec(["edit"]), { "*": "allow", edit: "deny", bash: "allow" })
  assert.equal(p.edit, "deny")
  assert.equal(p.bash, undefined, "bash is not in tools, so the catch-all deny applies")
  assert.equal(p["*"], "deny")
})
