import type { AdvisorSpec } from "../../config.ts"
import { SECRET_ALLOW_GLOBS, SECRET_GLOBS } from "../../policy.ts"

/** The advisor may read the project, but not the usual secret files. */
function readPermission(): Record<string, string> {
  const rules: Record<string, string> = { "*": "allow" }
  for (const g of SECRET_GLOBS) rules[g] = "deny"
  for (const g of SECRET_ALLOW_GLOBS) rules[g] = "allow"
  return rules
}

// advisor agent の権限: 既定は全拒否。advise と調査ツールだけ許可し、書き込み系は利用者の設定に従う (無ければ ask)。
// Quyền của agent advisor: mặc định từ chối hết; chỉ cho advise và tool điều tra, tool ghi theo luật của người dùng (không có thì ask).
export function advisorPermission(spec: AdvisorSpec, user?: unknown): Record<string, unknown> {
  const perm: Record<string, unknown> = { "*": "deny", advise: "allow" }
  // 利用者の規則は ツール個別 → "*" の順に探す。リポジトリ側がツールを付与できないことは設定の読み込み側 (config.ts) で保証する。
  // Tra luật của người dùng theo tool riêng rồi tới "*"; việc repo không được cấp tool ghi đã được đảm bảo ở phía đọc cấu hình (config.ts).
  const userRule = (tool: string): unknown => {
    if (typeof user === "string") return user
    if (user && typeof user === "object") {
      const rules = user as Record<string, unknown>
      if (tool in rules) return rules[tool]
      if ("*" in rules) return rules["*"]
    }
    return undefined
  }
  for (const t of spec.tools) {
    if (t === "read") perm[t] = readPermission()
    else if (t === "grep" || t === "glob") perm[t] = "allow"
    else perm[t] = userRule(t) ?? "ask"
  }
  return perm
}
