// 同じ project を二重に読み込まないための目印。plugin の cleanup、または setup の失敗/無効化で必ず外す。
// Đánh dấu để không nạp hai lần cùng một project; luôn được gỡ khi cleanup, khi setup lỗi hoặc khi plugin bị tắt.
const LOADED = new Set<string>()

/** True when this caller now owns the directory; false when another load already holds it. */
export function claimLoad(key: string): boolean {
  if (LOADED.has(key)) return false
  LOADED.add(key)
  return true
}

export function releaseLoad(key: string): void {
  LOADED.delete(key)
}
