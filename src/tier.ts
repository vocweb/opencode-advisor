// service tier を受け付ける provider の系統と、その系統で有効な値。ここに無い組み合わせでは何も付けない (provider に未知の値を送って失敗させないため)。
// Họ provider nhận service tier và các giá trị hợp lệ của họ đó; tổ hợp không có ở đây thì không gắn gì (tránh gửi giá trị lạ làm provider báo lỗi).
const FAMILIES: { match: RegExp; tiers: Record<string, true> }[] = [{ match: /openai/i, tiers: { auto: true, default: true, flex: true, scale: true, priority: true } }]

/** The tier to put on an advisor request, or undefined when none applies. `primaryTier` is what the primary last sent (for "inherit"). */
export function resolveServiceTier(setting: string, providerID: string, primaryTier: string | undefined): string | undefined {
  if (setting === "none") return undefined
  const family = FAMILIES.find((f) => f.match.test(providerID))
  if (!family) return undefined
  const tier = setting === "inherit" ? primaryTier : setting
  return tier !== undefined && Object.hasOwn(family.tiers, tier) ? tier : undefined
}
