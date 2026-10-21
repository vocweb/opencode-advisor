import { test } from "node:test"
import assert from "node:assert/strict"
import { LoopGuard } from "../../src/loopguard.ts"

test("loop guard: the third identical call is reminded, the fourth aborts; different arguments or tools do not count together", () => {
  const g = new LoopGuard()
  const grep = { pattern: "x", path: "." }
  assert.deepEqual([1, 2, 3, 4].map(() => g.observe("grep", grep)), ["ok", "ok", "remind", "abort"])
  assert.equal(g.observe("grep", { pattern: "y" }), "ok")
  assert.equal(g.observe("read", grep), "ok")
})

test("loop guard: advise is never counted, and a new guard (a new review) starts from zero", () => {
  const g = new LoopGuard()
  for (let i = 0; i < 6; i++) assert.equal(g.observe("advise", { note: "same" }), "ok")
  for (let i = 0; i < 4; i++) g.observe("glob", { pattern: "*" })
  assert.equal(new LoopGuard().observe("glob", { pattern: "*" }), "ok")
})
