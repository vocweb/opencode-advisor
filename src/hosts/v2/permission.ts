import type { AdvisorSpec } from "../../config.ts"
import { SECRET_ALLOW_GLOBS, SECRET_GLOBS } from "../../policy.ts"

export interface V2Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

// 設定の tool 名 (omp/v1 由来) を v2 の tool 名に直す。1 つの名前が複数の tool に対応することがある。
// Đổi tên tool trong cấu hình (gốc omp/v1) sang tên tool của v2; một tên có thể ứng với nhiều tool.
const V2_TOOLS: Record<string, string[]> = {
  read: ["read"],
  grep: ["grep"],
  glob: ["glob"],
  edit: ["edit", "write", "patch"],
  bash: ["shell"],
  task: ["subagent"],
  lsp: ["lsp"],
}

export const v2ToolNames = (t: string): string[] => V2_TOOLS[t] ?? [t]

// v2 の規則は後勝ち。まず全拒否、次に advise と調査ツール、書き込み系は利用者の規則 (無ければ ask) を写す。
// Luật v2 theo kiểu "luật sau thắng": từ chối hết trước, rồi cho advise và tool điều tra, tool ghi thì chép luật của người dùng (không có thì ask).
export function advisorRules(spec: AdvisorSpec, user: readonly V2Rule[] = []): V2Rule[] {
  const rules: V2Rule[] = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "advise", resource: "*", effect: "allow" },
  ]
  for (const t of spec.tools) {
    for (const name of v2ToolNames(t)) {
      if (name === "read") {
        rules.push({ action: "read", resource: "*", effect: "allow" })
        for (const g of SECRET_GLOBS) rules.push({ action: "read", resource: g, effect: "deny" })
        for (const g of SECRET_ALLOW_GLOBS) rules.push({ action: "read", resource: g, effect: "allow" })
      } else if (name === "grep" || name === "glob") {
        rules.push({ action: name, resource: "*", effect: "allow" })
      } else {
        // 利用者の規則はツール個別のものも "*" のものも写す。リポジトリ側がツールを付与できないことは config.ts で保証する。
        // Chép cả luật riêng của tool lẫn luật "*" của người dùng; việc repo không được cấp tool ghi đã được đảm bảo ở config.ts.
        const own = user.filter((r) => r.action === name || r.action === "*")
        rules.push(...(own.length > 0 ? own.map((r) => ({ ...r, action: name })) : [{ action: name, resource: "*", effect: "ask" as const }]))
      }
    }
  }
  return rules
}
