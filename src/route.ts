import { SEVERITY_RANK, type Severity } from "./types.ts"

// 受理したノートの配送先 (oh-my-pi の規則に準拠): aside/defer/steer-inject/steer-wake/card。
// Kênh giao note đã nhận (theo quy tắc oh-my-pi): aside/defer/steer-inject/steer-wake/card.
export type Route = "aside" | "defer" | "steer-inject" | "steer-wake" | "card"

export interface RouteInput {
  severity: Severity
  // レビューが最終境界を含むか (主エージェントが idle になった)。
  // Review có bao gồm ranh giới cuối không (primary đã idle).
  final: boolean
  // 主セッションがターン実行中か。実行中なら注入、idle なら wake を選ぶため。
  // Primary đang chạy một lượt không; chạy thì inject, idle thì wake.
  busy: boolean
  // ユーザーが中断した、または steer 上限に達した。再起動させないため。
  // Người dùng đã ngắt hoặc chạm trần steer, nên không được khởi động lại agent.
  suppressed: boolean
  // steer 後の冷却で残っているターン数。
  // Số lượt còn lại của cooldown sau steer.
  immuneLeft: number
  // 主の直近ターンが終端のテキスト回答で終わったか (待機中の作業なし)。
  // Lượt gần nhất của primary kết thúc bằng câu trả lời cuối (không còn việc xếp hàng).
  terminalAnswer: boolean
  // 終端回答後、この重大度以上だけが主を起こし、未満はカードにする。
  // Sau câu trả lời cuối, note từ mức này trở lên đánh thức primary, thấp hơn thành card.
  continueSeverity: Severity
  // プランモードでは割り込まず、代わりにカードを見せる。
  // Ở plan mode không ngắt agent mà hiện card.
  planMode: boolean
}

export function decideRoute(i: RouteInput): Route {
  const r = baseRoute(i)
  // プランモードでは割り込みを避け、カードだけ見せる。
  // Ở plan mode không ngắt agent, chỉ hiện card.
  return i.planMode && (r === "steer-inject" || r === "steer-wake") ? "card" : r
}

function baseRoute(i: RouteInput): Route {
  // 中断済み・上限到達なら nit 以外はカードにして、エージェントを再起動しない。
  // Đã bị ngắt hoặc chạm trần steer thì chỉ hiện card (trừ nit), không khởi động lại agent.
  if (i.suppressed && i.severity !== "nit") return "card"
  const continues = SEVERITY_RANK[i.severity] >= SEVERITY_RANK[i.continueSeverity]
  if (i.severity === "nit") {
    if (i.final && !i.busy && i.terminalAnswer) return continues ? "steer-wake" : "card"
    return "aside"
  }
  // クールダウンはブロッカーを免除する。ブロッカーは常に割り込むべきだから。
  // Cooldown không áp dụng cho blocker, vì blocker luôn phải ngắt được.
  if (i.severity === "concern" && i.immuneLeft > 0) return "aside"
  if (!i.final && i.severity !== "blocker") return "defer"
  if (i.busy) return "steer-inject"
  if (i.severity === "blocker") return "steer-wake"
  return i.terminalAnswer ? (continues ? "steer-wake" : "card") : "steer-wake"
}
