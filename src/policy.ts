import type { AdvisorSpec } from "./config.ts"
import type { Msg } from "./types.ts"

export const agentNameFor = (spec: AdvisorSpec) => `advisor-${spec.slug}`

// advisor が読んではいけない秘密ファイルの名前。host ごとの権限形式にここから変換する。
// Tên các file bí mật advisor không được đọc; mỗi host dịch danh sách này sang định dạng quyền riêng của nó.
export const SECRET_GLOBS = ["*.env", "*.env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*id_rsa*", "*id_ed25519*", "*credentials*", "*.npmrc", "*.netrc", "*secrets*"]
export const SECRET_ALLOW_GLOBS = ["*.env.example"]

export const EVICTED = "[output of an earlier review evicted]"
/** Investigative tools whose old outputs are dead weight once the advisor starts its next review. */
const EVICTABLE_TOOLS = ["read", "grep", "glob"]
export const isEvictableTool = (name: string | undefined): boolean => name !== undefined && EVICTABLE_TOOLS.includes(name)

// 過去レビューの read/grep/glob の出力をスタブに置換する。モデルへ送る写しだけ変え、保存済みは触らない。
// Thay output read/grep/glob của các review cũ bằng stub; chỉ đổi bản gửi model, không đụng bản đã lưu.
export function evictStaleResults(messages: Msg[]): void {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.info.role === "user") {
      lastUser = i
      break
    }
  }
  for (let i = 0; i < lastUser; i++) {
    const parts = messages[i]!.parts
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j]!
      if (p.type === "tool" && p.state?.status === "completed" && isEvictableTool(p.tool)) {
        parts[j] = { ...p, state: { ...p.state, output: EVICTED } }
      }
    }
  }
}
