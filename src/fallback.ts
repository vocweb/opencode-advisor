import type { RetryConfig } from "./config.ts"
import { parseModelSelector } from "./util.ts"

export type FailureKind = "usage-limit" | "refusal" | "other"
export type FailureOutcome = "switched" | "stay" | "exhausted"

const USAGE_RE = /usage.?limit|quota|rate.?limit|429|insufficient/i
const REFUSAL_RE = /refus/i

export function classifyFailure(name: string, message: string): FailureKind {
  const text = `${name} ${message}`
  if (USAGE_RE.test(text)) return "usage-limit"
  if (REFUSAL_RE.test(text)) return "refusal"
  return "other"
}

// advisor 一つ分のモデル選択。失敗したモデルは冷却して飛ばし、拒否は今回のレビューだけ次へ回して主モデルを再試行する。
// Chọn model cho một advisor: model lỗi bị cooldown và bỏ qua, riêng refusal chỉ chuyển sang model kế cho lần review này rồi thử lại model chính.
export class ModelChain {
  private cooldown = new Map<string, number>()
  // この添字より前の候補は飛ばす。never 方針や拒否のあとで主モデルに戻らないようにするため。
  // Các ứng viên trước chỉ số này bị bỏ qua, để không quay lại model chính sau chính sách never hoặc sau refusal.
  private floor = 0
  private refusalFloor = false

  constructor(
    private retry: RetryConfig,
    private primary: () => string | undefined,
    private now: () => number = Date.now,
  ) {}

  private enabled(): boolean {
    return this.retry.enabled && this.retry.modelFallback
  }

  // 候補の順序付き一覧 (主モデルが先頭)。モデル未設定なら空。
  // Danh sách ứng viên theo thứ tự, model chính đứng đầu; rỗng nếu chưa cấu hình model.
  chain(): string[] {
    const primary = this.primary()
    if (!primary) return []
    if (primary === "inherit" || !this.enabled()) return [primary]
    const sel = parseModelSelector(primary)
    if (!sel) return [primary]
    const chains = this.retry.fallbackChains
    const exact = `${sel.ref.providerID}/${sel.ref.modelID}`
    const entries = chains[primary] ?? chains[exact] ?? chains[`${sel.ref.providerID}/*`] ?? chains.advisor ?? []
    // "provider/*" は同じモデル ID のまま provider だけを切り替える意味。
    // "provider/*" nghĩa là giữ nguyên model id và chỉ đổi provider.
    const mapped = entries.map((e) => (e.endsWith("/*") ? `${e.slice(0, -2)}/${sel.ref.modelID}` : e))
    const out = [primary]
    for (const m of mapped) if (!out.includes(m)) out.push(m)
    return out
  }

  // 今使うモデル。冷却中の候補を飛ばすため毎回計算する。
  // Model dùng lúc này; tính lại mỗi lần để bỏ qua ứng viên đang cooldown.
  current(): string | undefined {
    const chain = this.chain()
    if (chain.length === 0) return undefined
    const t = this.now()
    for (let i = this.floor; i < chain.length; i++) {
      const until = this.cooldown.get(chain[i]!)
      if (until === undefined || until <= t) {
        this.cooldown.delete(chain[i]!)
        return chain[i]
      }
    }
    // 全候補がクールダウン中なら主モデルを使い続ける。止まるよりまし。
    // Mọi ứng viên đang cooldown thì vẫn dùng model chính, tốt hơn là đứng im.
    return chain[0]
  }

  isFallback(): boolean {
    const c = this.current()
    return c !== undefined && c !== this.primary()
  }

  // current() で行ったレビューの失敗を報告し、切替・据置・枯渇のどれかを返す。
  // Báo một lần review thất bại với current() và trả về chuyển model, giữ nguyên hay cạn kiệt.
  onFailure(kind: FailureKind): FailureOutcome {
    const chain = this.chain()
    const failing = this.current()
    const usage = kind === "usage-limit"
    const mode = this.retry.fallbackOn
    const allowed = this.enabled() && (mode === "any" || (mode === "usage-limit" ? usage : !usage))
    if (!allowed || chain.length <= 1 || !failing) return usage ? "exhausted" : "stay"
    const idx = chain.indexOf(failing)
    if (kind === "refusal") {
      if (idx + 1 >= chain.length) return "stay"
      this.floor = idx + 1
      this.refusalFloor = true
      return "switched"
    }
    const ms = this.retry.maxDelayMs
    this.cooldown.set(failing, ms <= 0 ? Infinity : this.now() + ms)
    const next = this.current()
    const nextIdx = next ? chain.indexOf(next) : -1
    const nextCooled = next !== undefined && (this.cooldown.get(next) ?? 0) > this.now()
    if (next && next !== failing && !nextCooled) {
      if (this.retry.fallbackRevertPolicy === "never") this.floor = Math.max(this.floor, nextIdx)
      return "switched"
    }
    return usage ? "exhausted" : "stay"
  }

  // 拒否による退避はそのレビュー限りなので、成功時に解除する。
  // Refusal chỉ có hiệu lực cho đúng review đó nên gỡ khi review thành công.
  onSuccess(): void {
    if (this.refusalFloor && this.retry.fallbackRevertPolicy !== "never") {
      this.floor = 0
      this.refusalFloor = false
    }
  }

  onReset(): void {
    this.cooldown.clear()
    this.floor = 0
    this.refusalFloor = false
  }
}
