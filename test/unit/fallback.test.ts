import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_RETRY, type RetryConfig } from "../../src/config.ts"
import { classifyFailure, ModelChain } from "../../src/fallback.ts"

const retry = (over: Partial<RetryConfig> = {}): RetryConfig => ({ ...DEFAULT_RETRY, fallbackChains: {}, ...over })
function chain(r: RetryConfig, primary = "p/main") {
  let now = 1_000
  const c = new ModelChain(r, () => primary, () => now)
  return { c, tick: (ms: number) => (now += ms) }
}

test("fallback: classifyFailure", () => {
  assert.equal(classifyFailure("APIError", "429 Too Many Requests"), "usage-limit")
  assert.equal(classifyFailure("", "You exceeded your current quota"), "usage-limit")
  assert.equal(classifyFailure("", "model refused the request"), "refusal")
  assert.equal(classifyFailure("", "socket hang up"), "other")
})

test("fallback: chain picks exact selector over provider/* over advisor", () => {
  const r = retry({ fallbackChains: { advisor: ["z/any"], "p/*": ["q/*"], "p/main": ["x/one", "x/two"] } })
  assert.deepEqual(chain(r).c.chain(), ["p/main", "x/one", "x/two"])
  assert.deepEqual(chain(r, "p/other").c.chain(), ["p/other", "q/other"], "provider/* keeps the model id")
  assert.deepEqual(chain(r, "k/m").c.chain(), ["k/m", "z/any"])
  assert.deepEqual(chain(r, "k/m:high").c.chain(), ["k/m:high", "z/any"], "the thinking level is ignored when matching")
})

test("fallback: usage-limit moves on, cools the model down, and returns when the cooldown ends", () => {
  const { c, tick } = chain(retry({ fallbackChains: { advisor: ["f/one"] }, maxDelayMs: 1000 }))
  assert.equal(c.onFailure("usage-limit"), "switched")
  assert.equal(c.current(), "f/one")
  assert.equal(c.isFallback(), true)
  assert.equal(c.onFailure("usage-limit"), "exhausted", "every model is cooling down")
  tick(1001)
  assert.equal(c.current(), "p/main")
  c.onReset()
  assert.equal(c.current(), "p/main")
})

test("fallback: no chain or fallback disabled -> usage-limit is exhausted, other errors just retry", () => {
  assert.equal(chain(retry()).c.onFailure("usage-limit"), "exhausted")
  assert.equal(chain(retry()).c.onFailure("other"), "stay")
  const off = chain(retry({ modelFallback: false, fallbackChains: { advisor: ["f/one"] } }))
  assert.equal(off.c.onFailure("other"), "stay")
  assert.equal(off.c.current(), "p/main")
})

test("fallback: fallbackOn gates which failures switch", () => {
  const chains = { advisor: ["f/one"] }
  assert.equal(chain(retry({ fallbackOn: "usage-limit", fallbackChains: chains })).c.onFailure("other"), "stay")
  assert.equal(chain(retry({ fallbackOn: "usage-limit", fallbackChains: chains })).c.onFailure("usage-limit"), "switched")
  assert.equal(chain(retry({ fallbackOn: "except-usage-limit", fallbackChains: chains })).c.onFailure("usage-limit"), "exhausted")
  assert.equal(chain(retry({ fallbackOn: "except-usage-limit", fallbackChains: chains })).c.onFailure("other"), "switched")
  assert.equal(chain(retry({ fallbackOn: "any", fallbackChains: chains })).c.onFailure("other"), "switched")
})

test("fallback: a refusal pins the fallback for that review only (no cooldown), unless the policy is never", () => {
  const chains = { advisor: ["f/one"] }
  const a = chain(retry({ fallbackChains: chains }))
  assert.equal(a.c.onFailure("refusal"), "switched")
  assert.equal(a.c.current(), "f/one")
  a.c.onSuccess()
  assert.equal(a.c.current(), "p/main", "the primary is tried again at the next review")
  const n = chain(retry({ fallbackChains: chains, fallbackRevertPolicy: "never", maxDelayMs: 1 }))
  assert.equal(n.c.onFailure("other"), "switched")
  n.tick(10_000)
  n.c.onSuccess()
  assert.equal(n.c.current(), "f/one", "never returns on its own, even after the cooldown")
  n.c.onReset()
  assert.equal(n.c.current(), "p/main")
})
