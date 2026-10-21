import type { AdvisorSpec } from "../../config.ts"
import { SECRET_ALLOW_GLOBS, SECRET_GLOBS } from "../../policy.ts"

/** The advisor may read the project, but not the usual secret files. */
function readPermission(): Record<string, string> {
  const rules: Record<string, string> = { "*": "allow" }
  for (const g of SECRET_GLOBS) rules[g] = "deny"
  for (const g of SECRET_ALLOW_GLOBS) rules[g] = "allow"
  return rules
}

// advisor agent の権限: 既定は全拒否。advise と調査ツールだけ許可し、書き込み系はそのツール個別の利用者規則に従う (無ければ ask)。
// Quyền của agent advisor: mặc định từ chối hết; chỉ cho advise và tool điều tra, tool ghi theo luật riêng của tool đó do người dùng viết (không có thì ask).
export function advisorPermission(spec: AdvisorSpec, user?: unknown): Record<string, unknown> {
  const perm: Record<string, unknown> = { "*": "deny", advise: "allow" }
  // "*" の allow (YOLO 設定) は引き継がない。設定ファイルでツールを付与できるのはリポジトリ側なので、確認なしの書き込み・実行にならないようにするため。
  // Không thừa kế allow của "*" (chế độ YOLO): repo có thể cấp tool qua cấu hình, nên không để chúng ghi/chạy lệnh mà không hỏi.
  const userRule = (tool: string): unknown => {
    if (user && typeof user === "object") {
      const rules = user as Record<string, unknown>
      if (tool in rules) return rules[tool]
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
