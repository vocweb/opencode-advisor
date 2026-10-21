import type { AdvisorConfig, AdvisorSpec } from "./config.ts"

export interface ReloadResult {
  /** What changed and was applied right away. */
  applied: string[]
  /** What changed but only takes effect after a restart (or an agent reload on hosts that can do it). */
  restart: string[]
  warnings: string[]
}

const sameTools = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i])

/**
 * Brings `cfg` and its roster up to date with `next` without replacing any object that runtimes already hold.
 * Returns the specs that were added, removed, or whose enabled state or model changed, so the caller can fix the runtimes.
 */
export function applyConfig(
  cfg: AdvisorConfig,
  specs: AdvisorSpec[],
  next: AdvisorConfig,
): { result: ReloadResult; added: AdvisorSpec[]; toggled: AdvisorSpec[]; remodeled: AdvisorSpec[]; agentsStale: boolean } {
  const applied: string[] = []
  const restart: string[] = []
  const added: AdvisorSpec[] = []
  const toggled: AdvisorSpec[] = []
  const remodeled: AdvisorSpec[] = []
  let agentsStale = false

  // retry は ModelChain が参照を持っているので、同じオブジェクトの中身を更新する。
  // retry được ModelChain giữ theo tham chiếu nên cập nhật nội dung của chính object đó.
  const { advisors: _roster, retry, enabled: _enabled, ...scalars } = next
  const before = JSON.stringify({ ...cfg, advisors: undefined, warnings: undefined, sources: undefined })
  const promptBefore = `${cfg.watchdog}\0${cfg.instructions}`
  Object.assign(cfg, scalars)
  Object.assign(cfg.retry, retry)
  cfg.retry.fallbackChains = retry.fallbackChains
  if (before !== JSON.stringify({ ...cfg, advisors: undefined, warnings: undefined, sources: undefined })) applied.push("settings")
  // WATCHDOG.md や共通 instructions は advisor の system prompt に入る。変わったら agent 定義を作り直す必要がある。
  // WATCHDOG.md và instructions chung nằm trong system prompt của advisor; thay đổi thì phải dựng lại định nghĩa agent.
  if (promptBefore !== `${cfg.watchdog}\0${cfg.instructions}`) {
    agentsStale = true
    restart.push("shared instructions or WATCHDOG.md")
  }

  for (const n of next.advisors) {
    const cur = specs.find((s) => s.slug === n.slug)
    if (!cur) {
      specs.push(n)
      added.push(n)
      applied.push(`added ${n.name}`)
      continue
    }
    const promptChanged = !sameTools(cur.tools, n.tools) || cur.instructions !== n.instructions || cur.maxNotesPerUpdate !== n.maxNotesPerUpdate || cur.name !== n.name
    const enabledChanged = cur.enabled !== n.enabled
    const modelChanged = cur.model !== n.model
    const cadenceChanged = cur.reviewMode !== n.reviewMode || cur.reviewInterval !== n.reviewInterval || cur.syncBacklog !== n.syncBacklog
    Object.assign(cur, n)
    if (promptChanged) {
      agentsStale = true
      restart.push(`${n.name}: tools or instructions`)
    }
    if (enabledChanged) {
      toggled.push(cur)
      applied.push(`${n.name} ${n.enabled ? "enabled" : "disabled"}`)
    }
    if (modelChanged) {
      remodeled.push(cur)
      applied.push(`${n.name} model`)
    }
    if (cadenceChanged) applied.push(`${n.name} cadence`)
  }
  for (const cur of specs) {
    if (next.advisors.some((n) => n.slug === cur.slug) || !cur.enabled) continue
    // ファイルから消えた entry は止める。runtime は applyEnabled が片付ける。
    // Entry bị xóa khỏi file thì dừng lại; applyEnabled sẽ dọn runtime.
    cur.enabled = false
    toggled.push(cur)
    applied.push(`${cur.name} removed`)
  }
  return { result: { applied, restart, warnings: next.warnings }, added, toggled, remodeled, agentsStale }
}
