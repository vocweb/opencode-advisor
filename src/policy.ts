import { redact } from "./redact.ts"
import type { AdvisorSpec } from "./config.ts"
import type { Msg } from "./types.ts"

export const agentNameFor = (spec: AdvisorSpec) => `advisor-${spec.slug}`

// advisor が読んではいけない秘密ファイルの名前。host ごとの権限形式にここから変換する。
// Tên các file bí mật advisor không được đọc; mỗi host dịch danh sách này sang định dạng quyền riêng của nó.
export const SECRET_GLOBS = ["*.env", "*.env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*id_rsa*", "*id_ed25519*", "*credentials*", "*.npmrc", "*.netrc", "*secrets*"]
export const SECRET_ALLOW_GLOBS = ["*.env.example"]

const globToRegExp = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i")
const SECRET_RES = SECRET_GLOBS.map(globToRegExp)
const SECRET_ALLOW_RES = SECRET_ALLOW_GLOBS.map(globToRegExp)

// 秘密ファイルかどうか。設定の @import など、advisor の権限経路を通らない読み込みでも同じ基準を使うため。
// File có phải bí mật không; dùng cùng tiêu chí cho các đường đọc không đi qua quyền của advisor, như @import trong cấu hình.
export function isSecretPath(file: string): boolean {
  const name = file.split(/[\\/]/).pop() ?? file
  if (SECRET_ALLOW_RES.some((re) => re.test(name))) return false
  return SECRET_RES.some((re) => re.test(name) || re.test(file))
}

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

// grep/glob の権限は検索パターンに対するもので、ファイルのパスでは拒否できない。代わりにモデルへ渡す直前の出力から秘密ファイルの行を取り除く。
// Quyền grep/glob áp cho pattern tìm kiếm chứ không theo đường dẫn file nên không deny được; thay vào đó lọc các dòng của file bí mật khỏi output ngay trước khi đưa cho model.
export function scrubSecretOutput(text: string): string {
  let hiding = false
  const out: string[] = []
  for (const line of text.split("\n")) {
    const indented = /^\s/.test(line)
    if (!indented) hiding = isSecretPath(line.split(/:\d+[:-]|:$|:\s/)[0] ?? line)
    if (hiding) {
      if (out.at(-1) !== SECRET_HIDDEN) out.push(SECRET_HIDDEN)
      continue
    }
    out.push(line)
  }
  return redact(out.join("\n"))
}
export const SECRET_HIDDEN = "[matches in a secret file hidden]"

/** read/grep/glob output is passed through the same filter before it reaches the advisor model. */
export function scrubInvestigationResults(messages: Msg[]): void {
  for (const m of messages) {
    for (let j = 0; j < m.parts.length; j++) {
      const p = m.parts[j]!
      if (p.type === "tool" && p.state?.status === "completed" && isEvictableTool(p.tool) && typeof p.state.output === "string") {
        m.parts[j] = { ...p, state: { ...p.state, output: p.tool === "read" ? redact(p.state.output) : scrubSecretOutput(p.state.output) } }
      }
    }
  }
}
