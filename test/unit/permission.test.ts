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

test("advisorPermission: only the tool's own rule is carried over; a blanket allow (YOLO) never lets a granted write tool run unasked", () => {
  assert.equal(advisorPermission(spec(["edit"]), "allow").edit, "ask")
  assert.equal(advisorPermission(spec(["edit"]), { "*": "allow" }).edit, "ask")
  assert.equal(advisorPermission(spec(["edit"]), { edit: "allow" }).edit, "allow", "an explicit rule for that tool is the user's own decision")
  const bash = { "*": "ask", "git *": "allow" }
  assert.deepEqual(advisorPermission(spec(["bash"]), { bash }).bash, bash)
})

test("advisorPermission: a tool's own rule beats '*', and a tool that is not granted stays denied", () => {
  const p = advisorPermission(spec(["edit"]), { "*": "allow", edit: "deny", bash: "allow" })
  assert.equal(p.edit, "deny")
  assert.equal(p.bash, undefined, "bash is not in tools, so the catch-all deny applies")
  assert.equal(p["*"], "deny")
})
