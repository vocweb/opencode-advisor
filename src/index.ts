import type { Plugin } from "@opencode-ai/plugin"
import { createV1Hooks } from "./hosts/v1/plugin.ts"
import type { V2Ctx } from "./hosts/v2/host.ts"
import { looksLikeV2, missingV2Members, setupV2 } from "./hosts/v2/plugin.ts"

// opencode 1.x と 2.x で同じ default export を使う。v1 は server()、v2 は setup() を呼ぶ (setup は v1 も部分的な ctx で呼ぶので判定する)。
// Dùng chung một default export cho opencode 1.x và 2.x: v1 gọi server(), v2 gọi setup() (v1 cũng gọi setup với ctx thiếu nên phải kiểm tra).
const server: Plugin = async (input) => createV1Hooks(input)

export default {
  id: "opencode-advisor",
  server,
  async setup(ctx: Record<string, any>) {
    if (!looksLikeV2(ctx)) return
    const missing = missingV2Members(ctx)
    if (missing.length > 0) {
      // 新しい opencode が API 名を変えた場合に、無言で止まらず原因を残す。
      // Khi opencode mới đổi tên API, không được dừng im lặng mà phải để lại nguyên nhân.
      console.error(`[opencode-advisor] error: this opencode (${String(ctx.app?.version ?? "unknown")}) does not provide ${missing.join(", ")}; the advisor is disabled. Please report it.`)
      return
    }
    return setupV2(ctx as V2Ctx)
  },
}
