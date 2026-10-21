import type { RetryConfig } from "./config.ts"
import { parseModelSelector } from "./util.ts"

export type FailureKind = "usage-limit" | "refusal" | "no-model" | "other"
export type FailureOutcome = "switched" | "stay" | "exhausted"

const USAGE_RE = /usage.?limit|quota|rate.?limit|too many requests|429|insufficient/i
const REFUSAL_RE = /refus/i
// モデルがカタログにまだ無い (後から現れるかもしれない) 場合。他の失敗と違い、待てば直る可能性がある。
// Model chưa có trong danh mục (có thể xuất hiện muộn); khác các lỗi khác, chờ có thể tự hết.
const NO_MODEL_RE = /ModelNotFound|no-route|Model unavailable|model\b.{0,40}\bnot found|unknown model|no such model|model\b.{0,40}\bnot available/i

export function classifyFailure(name: string, message: string): FailureKind {
  const text = `${name} ${message}`
  if (NO_MODEL_RE.test(text)) return "no-model"
  if (USAGE_RE.test(text)) return "usage-limit"
  if (REFUSAL_RE.test(text)) return "refusal"
  return "other"
}

// advisor 一つ分のモデル選択。失敗したモデルは冷却して飛ばし、主モデルの拒否は fallback に固定する。
// Chọn model cho một advisor: model lỗi bị cooldown và bỏ qua, riêng primary bị từ chối thì ghim sang fallback.
export class ModelChain {
  private cooldown = new Map<string, number>()
  // この添字より前の候補は飛ばす。never 方針や拒否のあとで主モデルに戻らないようにするため。
  // Các ứng viên trước chỉ số này bị bỏ qua, để không quay lại model chính sau chính sách never hoặc sau refusal.
  private floor = 0

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
    // 主モデルの拒否は内容への判断であってモデルの故障ではない。冷却せず fallback に固定する。
    // fallback 側の拒否は通常の失敗と同じく冷却し、固定しない。
    // Primary từ chối là phán đoán về nội dung, không phải lỗi model: không cooldown, ghim sang fallback.
    // Fallback từ chối thì cooldown như lỗi thường và không ghim.
    if (kind === "refusal" && idx === 0 && this.floor < 1) {
      this.floor = 1
      return "switched"
    }
    const ms = this.retry.maxDelayMs
    this.cooldown.set(failing, ms <= 0 ? Infinity : this.now() + ms)
    const next = this.current()
    const nextIdx = next ? chain.indexOf(next) : -1
    const nextCooled = next !== undefined && (this.cooldown.get(next) ?? 0) > this.now()
    // floor より下 (主モデル) へ戻る切替は行わない。両方が拒否すると互いに切り替えて無限ループになるため。
    // Không chuyển ngược về model dưới floor (model chính); nếu cả hai cùng từ chối thì sẽ đổi qua lại vô hạn.
    if (next && next !== failing && !nextCooled && nextIdx >= this.floor) {
      if (this.retry.fallbackRevertPolicy === "never") this.floor = Math.max(this.floor, nextIdx)
      return "switched"
    }
    return usage ? "exhausted" : "stay"
  }

  // 切替が起きるか (状態は変えない)。provider の再試行待ちを中断してよいかの判断に使う。
  // Lần lỗi này có chuyển được sang model khác không (không đổi trạng thái); dùng để quyết định có ngắt khoảng chờ retry của provider hay không.
  wouldSwitch(kind: FailureKind): boolean {
    const chain = this.chain()
    const failing = this.current()
    const usage = kind === "usage-limit"
    const mode = this.retry.fallbackOn
    const allowed = this.enabled() && (mode === "any" || (mode === "usage-limit" ? usage : !usage))
    if (!allowed || chain.length <= 1 || !failing) return false
    const t = this.now()
    return chain.slice(chain.indexOf(failing) + 1).some((m) => (this.cooldown.get(m) ?? 0) <= t)
  }

  // 拒否の固定は compaction や新しい会話で内容が変わるまで続く。reset でのみ解除する。
  // Pin do refusal kéo dài tới khi compaction hoặc hội thoại mới thay nội dung; chỉ reset mới gỡ.
  onReset(): void {
    this.cooldown.clear()
    this.floor = 0
  }
}
