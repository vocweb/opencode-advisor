// advisor が同じ調査ツールを同じ引数で繰り返すと、review が終わらず費用だけが増える。omp と同じく 3 回目で注意し、4 回目で review を打ち切る。
// Khi advisor gọi lặp cùng một tool với cùng tham số thì review không bao giờ xong mà chi phí cứ tăng; giống omp, lần 3 nhắc nhở và lần 4 hủy review.
export const LOOP_REMIND_AT = 3
export const LOOP_ABORT_AT = 4

export type LoopVerdict = "ok" | "remind" | "abort"

export const LOOP_REMINDER = `You already made this exact call ${LOOP_REMIND_AT - 1} times in this review and got the same result. Do not repeat it: use what you have, try a different query, or finish with no findings.`
export const LOOP_STOPPED = "Review stopped: the same tool call was repeated too many times. Nothing was lost; the next update starts a fresh review."

/** One instance per review; a new review starts a new guard, which is the reset. */
export class LoopGuard {
  private counts = new Map<string, number>()

  observe(tool: string, args: unknown): LoopVerdict {
    // advise の重複は guard.ts が別に扱う。調査ツールだけを数える。
    // Việc trùng lặp của advise do guard.ts xử lý riêng; ở đây chỉ đếm tool điều tra.
    if (tool === "advise") return "ok"
    let key: string
    try {
      key = `${tool}\n${JSON.stringify(args)}`
    } catch {
      return "ok"
    }
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    if (n >= LOOP_ABORT_AT) return "abort"
    if (n >= LOOP_REMIND_AT) return "remind"
    return "ok"
  }
}
