import type { Plugin } from "@opencode-ai/plugin"
import { createV1Hooks } from "./hosts/v1/plugin.ts"
import { isV2Context, setupV2 } from "./hosts/v2/plugin.ts"

// opencode 1.x と 2.x で同じ default export を使う。v1 は server()、v2 は setup() を呼ぶ (setup は v1 も部分的な ctx で呼ぶので判定する)。
// Dùng chung một default export cho opencode 1.x và 2.x: v1 gọi server(), v2 gọi setup() (v1 cũng gọi setup với ctx thiếu nên phải kiểm tra).
const server: Plugin = async (input) => createV1Hooks(input)

export default {
  id: "opencode-advisor",
  server,
  async setup(ctx: Record<string, any>) {
    if (!isV2Context(ctx)) return
    return setupV2(ctx)
  },
}
