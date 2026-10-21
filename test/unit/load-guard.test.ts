import { test } from "node:test"
import assert from "node:assert/strict"
import { claimLoad, releaseLoad } from "../../src/hosts/v2/load-guard.ts"
import { setupV2 } from "../../src/hosts/v2/plugin.ts"

test("load guard: a second claim for the same directory is refused until the first is released", () => {
  assert.equal(claimLoad("/p"), true)
  assert.equal(claimLoad("/p"), false)
  assert.equal(claimLoad("/q"), true, "another directory is independent")
  releaseLoad("/p")
  assert.equal(claimLoad("/p"), true, "after release it can be claimed again")
  releaseLoad("/p")
  releaseLoad("/q")
})

test("load guard: a setup that throws does not keep the directory claimed (a later load is attempted, not refused)", async () => {
  const dir = process.cwd()
  const ctx = { location: { directory: dir }, app: { version: "2.1.0" } } as never
  // 欠けたメンバーのため setup は例外になる。2 回目も「二重読み込み」ではなく同じ例外になることが、目印が外れた証拠。
  // Vì thiếu member nên setup ném lỗi; lần hai cũng ném đúng lỗi đó (không phải bị coi là nạp đôi) chứng tỏ dấu đã được gỡ.
  await assert.rejects(setupV2(ctx))
  await assert.rejects(setupV2(ctx))
})
