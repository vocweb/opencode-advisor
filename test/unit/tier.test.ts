import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveServiceTier } from "../../src/tier.ts"

test("service tier: none sends nothing; a concrete tier is sent only to a provider family that supports it", () => {
  assert.equal(resolveServiceTier("none", "openai", "flex"), undefined)
  assert.equal(resolveServiceTier("flex", "openai", undefined), "flex")
  assert.equal(resolveServiceTier("flex", "anthropic", undefined), undefined, "unsupported family: nothing is sent")
  assert.equal(resolveServiceTier("ultrafast", "openai", undefined), undefined, "a tier the family does not know is not sent")
})

test("service tier: inherit follows the primary's live tier, and sends nothing when the primary has none", () => {
  assert.equal(resolveServiceTier("inherit", "openai", "priority"), "priority")
  assert.equal(resolveServiceTier("inherit", "openai", undefined), undefined)
  assert.equal(resolveServiceTier("inherit", "anthropic", "priority"), undefined)
})
