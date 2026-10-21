import { test } from "node:test"
import assert from "node:assert/strict"
import { looksLikeV2, missingV2Members } from "../../src/hosts/v2/plugin.ts"

const fn = () => {}
const full = () => ({
  location: { directory: "/p" },
  session: { hook: fn, context: fn, create: fn, prompt: fn, synthetic: fn },
  event: { subscribe: fn },
  tool: { transform: fn },
  agent: { transform: fn },
})

test("v2 detection: a complete context has nothing missing", () => {
  assert.deepEqual(missingV2Members(full()), [])
  assert.equal(looksLikeV2(full()), true)
})

test("v2 detection: a renamed member is named, not silently ignored; a 1.x partial context is not mistaken for 2.x", () => {
  const drift: Record<string, any> = full()
  delete drift.tool
  drift.tools = { transform: fn }
  assert.deepEqual(missingV2Members(drift), ["tool.transform"])
  assert.equal(looksLikeV2(drift), true, "it still looks like 2.x, so the caller reports the missing member")
  assert.equal(looksLikeV2({ app: { version: "1.19.3" } }), false)
  assert.equal(looksLikeV2({}), false)
  assert.equal(looksLikeV2({ app: { version: "2.4.0" } }), true, "a 2.x host with a renamed location is still reported")
})
