import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import { SEVERITIES, type Severity } from "./types.ts"
import { slugify } from "./util.ts"

export type SyncBacklog = "off" | 1 | 3 | 5 | "strict"
export type ReviewMode = "turn" | "agent-end"

export interface RetryConfig {
  enabled: boolean
  modelFallback: boolean
  fallbackOn: "any" | "usage-limit" | "except-usage-limit"
  fallbackRevertPolicy: "cooldown-expiry" | "never"
  // 失敗したモデルの冷却時間。0 以下ならリセットまで再試行しない。
  // Thời gian cooldown của model lỗi; <= 0 nghĩa là không thử lại cho tới khi reset.
  maxDelayMs: number
  // キーは advisor / provider/model / provider/*。値は順序付きの退避先。
  // Khóa là advisor | provider/model | provider/*; giá trị là danh sách model dự phòng theo thứ tự.
  fallbackChains: Record<string, string[]>
}

export interface AdvisorSpec {
  name: string
  slug: string
  enabled: boolean
  // モデル指定。inherit は主モデルを使い、未設定なら設定されるまで休眠する。
  // Chỉ định model; inherit dùng model của primary, chưa đặt thì ngủ cho tới khi được cấu hình.
  model: string | undefined
  // advise に加えて与える調査ツール (opencode 名)。
  // Các tool điều tra cấp thêm ngoài advise (tên theo opencode).
  tools: string[]
  instructions: string
  maxNotesPerUpdate: number
  reviewMode: ReviewMode
  reviewInterval: number
  syncBacklog: SyncBacklog
  // このエントリを定義した WATCHDOG.yml。enable/disable でどのファイルを書くか決めるため。
  // File WATCHDOG.yml định nghĩa entry, để enable/disable biết cần sửa file nào.
  file?: string | undefined
}

export interface AdvisorConfig {
  enabled: boolean
  maxNotesPerUpdate: number
  // steer 後の冷却ターン数。割り込みの連発を防ぐ。
  // Số lượt cooldown sau một lần steer, tránh ngắt liên tục.
  immuneTurns: number
  // プロンプトごとの割り込み上限。advisor とエージェントの往復ループを止める。
  // Trần số lần ngắt mỗi prompt, chặn vòng lặp qua lại giữa advisor và agent.
  maxSteersPerPrompt: number
  syncBacklog: SyncBacklog
  // 最終回答後はこの重大度以上だけが再起動させ、未満はカードにする。
  // Sau câu trả lời cuối chỉ note từ mức này mới đánh thức agent, thấp hơn thành card.
  continueSeverity: Severity
  // 新しいレビュー開始時に古い調査ツール出力を差し替え、advisor の文脈を軽くする。
  // Thay output tool điều tra cũ khi bắt đầu review mới để ngữ cảnh advisor nhẹ hơn.
  evictStaleResults: boolean
  fetchLimit: number
  primeMessages: number
  primeChars: number
  maxMessageChars: number
  maxToolInputChars: number
  maxToolOutputChars: number
  maxEditChars: number
  includeReasoning: boolean
  // この token 数を超えたら advisor の文脈を作り直す。
  // Vượt số token này thì dựng lại ngữ cảnh advisor.
  contextTokenBudget: number
  reviewTimeoutMs: number
  // 連続で破棄したバッチがこの数に達したら停止する。
  // Số batch bị bỏ liên tiếp đạt ngưỡng này thì advisor dừng.
  maxConsecutiveFailures: number
  toast: boolean
  // 人間が答えない権限要求を拒否するまでの時間 (ms)。レビューが無期限に止まるのを防ぐ。
  // Thời gian (ms) trước khi từ chối yêu cầu quyền không ai trả lời, tránh review kẹt vô hạn.
  permissionTimeoutMs: number
  // 主エージェントの system prompt に advisory の説明を足すか。
  // Có thêm lời giải thích về advisory vào system prompt của primary hay không.
  explainToPrimary: boolean
  // /advisor コマンドの小さな呼び出しに使うモデル。
  // Model cho lần gọi nhỏ của lệnh /advisor.
  controlModel: string | undefined
  // 個別指定のない advisor の既定モデル (modelRoles.advisor)。
  // Model mặc định cho advisor không có model riêng (modelRoles.advisor).
  defaultModel: string | undefined
  retry: RetryConfig
  // サブエージェント名から on/off/モデル指定への対応。
  // Ánh xạ tên subagent sang on/off/model selector.
  agentAdvisor: Record<string, string>
  /** Shared instructions for every advisor. */
  instructions: string
  /** Concatenated WATCHDOG.md contents (advisor-only guidance). */
  watchdog: string
  advisors: AdvisorSpec[]
  warnings: string[]
  /** Files that contributed to this configuration (for /advisor status). */
  sources: string[]
}

export const DEFAULT_TOOLS = ["read", "grep", "glob"]

export const DEFAULT_RETRY: RetryConfig = {
  enabled: true,
  modelFallback: true,
  fallbackOn: "any",
  fallbackRevertPolicy: "cooldown-expiry",
  maxDelayMs: 300_000,
  fallbackChains: {},
}

export const DEFAULTS = {
  enabled: true,
  maxNotesPerUpdate: 4,
  immuneTurns: 3,
  maxSteersPerPrompt: 6,
  syncBacklog: "off" as SyncBacklog,
  continueSeverity: "concern" as Severity,
  evictStaleResults: true,
  fetchLimit: 80,
  primeMessages: 40,
  primeChars: 60_000,
  maxMessageChars: 6_000,
  maxToolInputChars: 1_500,
  maxToolOutputChars: 1_500,
  maxEditChars: 6_000,
  includeReasoning: true,
  contextTokenBudget: 120_000,
  reviewTimeoutMs: 300_000,
  maxConsecutiveFailures: 3,
  toast: true,
  permissionTimeoutMs: 120_000,
  explainToPrimary: true,
}

export function globalConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
}

/** Directories from the farthest ancestor down to `directory` itself. */
export function ancestorDirs(directory: string, worktree: string | undefined, home: string = os.homedir()): string[] {
  const start = path.resolve(directory)
  const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
  let stop: string | undefined
  if (worktree && path.resolve(worktree) !== path.parse(start).root && within(start, path.resolve(worktree))) stop = path.resolve(worktree)
  else if (within(start, path.resolve(home)) && start !== path.resolve(home)) stop = path.resolve(home)
  if (!stop) return [start]
  const dirs: string[] = []
  let cur = start
  for (let i = 0; i < 32; i++) {
    if (stop === path.resolve(home) && cur === stop) break // do not read the bare home dir as a project dir
    dirs.push(cur)
    if (cur === stop) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return dirs.reverse()
}

function readText(file: string, maxBytes = 200_000): string | undefined {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > maxBytes) return undefined
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- WATCHDOG.md

const IMPORT_RE = /(^|\s)@((?:\.{1,2}\/|~\/)[^\s`]+)/g

export function expandImports(text: string, file: string, seen: Set<string> = new Set(), depth = 0, home = os.homedir()): string {
  if (depth > 5) return text
  const base = path.dirname(file)
  let fenced = false
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      // Only text outside inline `code spans` may contain imports.
      return line
        .split("`")
        .map((seg, i) =>
          i % 2 === 1
            ? seg
            : seg.replace(IMPORT_RE, (m, lead: string, p: string) => {
                const resolved = p.startsWith("~/") ? path.join(home, p.slice(2)) : path.resolve(base, p)
                if (seen.has(resolved)) return m
                const content = readText(resolved, 50_000)
                if (content === undefined) return m
                seen.add(resolved)
                const out = expandImports(content, resolved, seen, depth + 1, home).trim()
                seen.delete(resolved)
                return `${lead}${out}`
              }),
        )
        .join("`")
    })
    .join("\n")
}

export function discoverWatchdog(dirs: string[], globalDir: string, home = os.homedir()): { file: string; content: string }[] {
  const candidates = [path.join(globalDir, "WATCHDOG.md")]
  for (const d of dirs) candidates.push(path.join(d, "WATCHDOG.md"), path.join(d, ".opencode", "WATCHDOG.md"))
  const out: { file: string; content: string }[] = []
  const seenFiles = new Set<string>()
  for (const f of candidates) {
    const real = path.resolve(f)
    if (seenFiles.has(real)) continue
    seenFiles.add(real)
    const raw = readText(real)
    if (raw === undefined) continue
    const content = expandImports(raw, real, new Set([real]), 0, home).trim()
    if (content) out.push({ file: real, content })
  }
  return out
}

// ---------------------------------------------------------------- WATCHDOG.yml

const MAX_INTERVAL = 9007199254740991

// 存在するファイルを古い順に返す。後のファイルが勝つため。
// Trả các file tồn tại theo thứ tự cũ đến mới, vì file sau thắng.
export function discoverWatchdogYaml(dirs: string[], globalDir: string): { file: string; raw: string }[] {
  // 古い順に並べ、後のファイルが勝つ。omp と同じ探索順にするため。
  // Xếp từ cũ đến mới, file sau thắng; giữ đúng thứ tự tìm kiếm của omp.
  const candidates = [path.join(globalDir, "WATCHDOG.yml"), path.join(globalDir, "WATCHDOG.yaml")]
  for (const d of dirs) {
    for (const base of [d, path.join(d, ".opencode")]) {
      // 順序: <d>/*.yml, <d>/*.yaml, <d>/.opencode/*.yml, <d>/.opencode/*.yaml
      // Thứ tự: <d>/*.yml, <d>/*.yaml, <d>/.opencode/*.yml, <d>/.opencode/*.yaml
      candidates.push(path.join(base, "WATCHDOG.yml"), path.join(base, "WATCHDOG.yaml"))
    }
  }
  const out: { file: string; raw: string }[] = []
  const seen = new Set<string>()
  for (const f of candidates) {
    const real = path.resolve(f)
    if (seen.has(real)) continue
    seen.add(real)
    const raw = readText(real)
    if (raw !== undefined) out.push({ file: real, raw })
  }
  return out
}

// omp のツール名から opencode のツール名への対応。無いものは opencode に相当物がない。
// Ánh xạ tên tool omp sang opencode; tên không có nghĩa là opencode không có tool tương đương.
const TOOL_MAP: Record<string, string> = {
  read: "read",
  grep: "grep",
  search: "grep",
  glob: "glob",
  find: "glob",
  edit: "edit",
  write: "edit",
  ast_edit: "edit",
  bash: "bash",
  task: "task",
  lsp: "lsp",
}

export function normalizeTools(list: string[], where: string, warnings: string[]): string[] {
  if (list.length === 0) return []
  const out: string[] = []
  for (const raw of list) {
    const mapped = Object.hasOwn(TOOL_MAP, raw) ? TOOL_MAP[raw] : undefined
    if (!mapped) {
      warnings.push(`${where}: tool "${raw}" is not available in opencode; dropped`)
      continue
    }
    if (!out.includes(mapped)) out.push(mapped)
  }
  // omp も同様: 有効な名前が一つも無ければ既定ツールに戻す。
  // omp cũng vậy: không còn tên hợp lệ nào thì quay về bộ tool mặc định.
  return out.length > 0 ? out : [...DEFAULT_TOOLS]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v)

function num(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined
  return Math.min(max, Math.max(min, Math.floor(v)))
}
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)

function parseSyncBacklog(v: unknown): SyncBacklog | undefined {
  if (v === false || v === "off") return "off"
  if (v === "strict") return "strict"
  const n = typeof v === "string" ? Number(v) : v
  if (n === 1 || n === 3 || n === 5) return n
  return undefined
}

function parseSeverity(v: unknown): Severity | undefined {
  return (SEVERITIES as readonly unknown[]).includes(v) ? (v as Severity) : undefined
}

const keys = (...k: string[]): Record<string, true> => Object.fromEntries(k.map((x) => [x, true as const]))
const TOP_KEYS = keys("instructions", "maxNotesPerUpdate", "modelRoles", "advisor", "retry", "task", "advisors", "tier")
const ADVISOR_KEYS = keys(
  "enabled", "reviewMode", "reviewInterval", "maxNotesPerUpdate", "syncBacklog", "immuneTurns", "continueSeverity", "evictStaleResults",
  "maxSteersPerPrompt", "fetchLimit", "primeMessages", "primeChars", "maxMessageChars", "maxToolInputChars", "maxToolOutputChars",
  "maxEditChars", "includeReasoning", "contextTokenBudget", "reviewTimeoutMs", "maxConsecutiveFailures", "toast", "permissionTimeoutMs", "explainToPrimary", "controlModel",
)
const RETRY_KEYS = keys("enabled", "modelFallback", "fallbackOn", "fallbackRevertPolicy", "maxDelayMs", "fallbackChains")
const ENTRY_KEYS = keys("name", "enabled", "model", "tools", "reviewMode", "reviewInterval", "syncBacklog", "maxNotesPerUpdate", "instructions")

interface Layer {
  instructions?: string
  topMaxNotes?: number
  modelRole?: string
  advisor: Partial<typeof DEFAULTS> & { reviewMode?: ReviewMode; reviewInterval?: number; controlModel?: string }
  retry: Partial<RetryConfig>
  agentAdvisor: Record<string, string>
  advisors: (Partial<AdvisorSpec> & { name: string; slug: string })[]
}

function checkKeys(o: Obj, known: Record<string, true>, prefix: string, file: string, warnings: string[], unsupported = false): void {
  for (const k of Object.keys(o)) {
    if (Object.hasOwn(known, k)) continue
    const key = prefix ? `${prefix}.${k}` : k
    warnings.push(unsupported ? `${file}: "${key}" is not supported by opencode-advisor; ignored` : `${file}: unknown key "${key}"`)
  }
}

function parseLayer(root: Obj, file: string, warnings: string[], home: string): Layer {
  const layer: Layer = { advisor: {}, retry: {}, agentAdvisor: {}, advisors: [] }
  const imports = (text: string) => expandImports(text, file, new Set([file]), 0, home).trim()
  checkKeys(root, TOP_KEYS, "", file, warnings)

  const ins = str(root.instructions)
  if (ins) layer.instructions = imports(ins)
  layer.topMaxNotes = num(root.maxNotesPerUpdate, 1, 32)

  if (isObj(root.modelRoles)) layer.modelRole = str(root.modelRoles.advisor)
  else if (root.modelRoles !== undefined) warnings.push(`${file}: "modelRoles" must be a mapping; ignored`)

  if (isObj(root.tier)) {
    for (const k of Object.keys(root.tier)) warnings.push(`${file}: "tier.${k}" is not supported by opencode-advisor; ignored`)
  }

  if (root.advisor !== undefined) {
    if (!isObj(root.advisor)) warnings.push(`${file}: "advisor" must be a mapping; ignored`)
    else {
      const o = root.advisor
      checkKeys(o, ADVISOR_KEYS, "advisor", file, warnings)
      const a = layer.advisor as Record<string, unknown>
      const set = (k: string, v: unknown) => {
        if (v !== undefined) a[k] = v
      }
      set("enabled", bool(o.enabled))
      if (o.reviewMode !== undefined) {
        if (o.reviewMode === "turn" || o.reviewMode === "agent-end") a.reviewMode = o.reviewMode
        else warnings.push(`${file}: advisor.reviewMode must be "turn" or "agent-end"; ignored`)
      }
      if (o.reviewInterval !== undefined) {
        const n = typeof o.reviewInterval === "number" && Number.isInteger(o.reviewInterval) && o.reviewInterval >= 1 && o.reviewInterval <= MAX_INTERVAL ? o.reviewInterval : undefined
        if (n === undefined) warnings.push(`${file}: advisor.reviewInterval must be a positive integer; ignored`)
        else a.reviewInterval = n
      }
      set("maxNotesPerUpdate", num(o.maxNotesPerUpdate, 1, 32))
      if (o.syncBacklog !== undefined) {
        const s = parseSyncBacklog(o.syncBacklog)
        if (s === undefined) warnings.push(`${file}: advisor.syncBacklog must be off, 1, 3, 5 or strict; ignored`)
        else a.syncBacklog = s
      }
      set("immuneTurns", num(o.immuneTurns, 0, 100))
      if (o.continueSeverity !== undefined) {
        const s = parseSeverity(o.continueSeverity)
        if (!s) warnings.push(`${file}: advisor.continueSeverity must be nit, concern or blocker; ignored`)
        else a.continueSeverity = s
      }
      set("evictStaleResults", bool(o.evictStaleResults))
      set("maxSteersPerPrompt", num(o.maxSteersPerPrompt, 1, 100))
      set("fetchLimit", num(o.fetchLimit, 4, 500))
      set("primeMessages", num(o.primeMessages, 1, 500))
      set("primeChars", num(o.primeChars, 1_000, 1_000_000))
      set("maxMessageChars", num(o.maxMessageChars, 200, 100_000))
      set("maxToolInputChars", num(o.maxToolInputChars, 100, 100_000))
      set("maxToolOutputChars", num(o.maxToolOutputChars, 100, 100_000))
      set("maxEditChars", num(o.maxEditChars, 200, 100_000))
      set("includeReasoning", bool(o.includeReasoning))
      set("contextTokenBudget", num(o.contextTokenBudget, 10_000, 10_000_000))
      set("reviewTimeoutMs", num(o.reviewTimeoutMs, 5_000, 3_600_000))
      set("maxConsecutiveFailures", num(o.maxConsecutiveFailures, 1, 20))
      set("toast", bool(o.toast))
      set("permissionTimeoutMs", num(o.permissionTimeoutMs, 1_000, 3_600_000))
      set("explainToPrimary", bool(o.explainToPrimary))
      set("controlModel", str(o.controlModel))
    }
  }

  if (root.retry !== undefined) {
    if (!isObj(root.retry)) warnings.push(`${file}: "retry" must be a mapping; ignored`)
    else {
      const o = root.retry
      checkKeys(o, RETRY_KEYS, "retry", file, warnings, true)
      const r = layer.retry
      const en = bool(o.enabled)
      if (en !== undefined) r.enabled = en
      const mf = bool(o.modelFallback)
      if (mf !== undefined) r.modelFallback = mf
      if (o.fallbackOn !== undefined) {
        if (o.fallbackOn === "any" || o.fallbackOn === "usage-limit" || o.fallbackOn === "except-usage-limit") r.fallbackOn = o.fallbackOn
        else warnings.push(`${file}: retry.fallbackOn must be any, usage-limit or except-usage-limit; ignored`)
      }
      if (o.fallbackRevertPolicy !== undefined) {
        if (o.fallbackRevertPolicy === "cooldown-expiry" || o.fallbackRevertPolicy === "never") r.fallbackRevertPolicy = o.fallbackRevertPolicy
        else warnings.push(`${file}: retry.fallbackRevertPolicy must be cooldown-expiry or never; ignored`)
      }
      if (typeof o.maxDelayMs === "number" && Number.isFinite(o.maxDelayMs)) r.maxDelayMs = Math.floor(o.maxDelayMs)
      if (o.fallbackChains !== undefined) {
        if (!isObj(o.fallbackChains)) warnings.push(`${file}: retry.fallbackChains must be a mapping; ignored`)
        else {
          r.fallbackChains = {}
          for (const [k, v] of Object.entries(o.fallbackChains)) {
            const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
            if (list.length) r.fallbackChains[k] = list
            else warnings.push(`${file}: retry.fallbackChains["${k}"] must list model selectors; ignored`)
          }
        }
      }
    }
  }

  if (root.task !== undefined) {
    if (!isObj(root.task)) warnings.push(`${file}: "task" must be a mapping; ignored`)
    else if (root.task.agentAdvisor !== undefined) {
      if (!isObj(root.task.agentAdvisor)) warnings.push(`${file}: task.agentAdvisor must be a mapping; ignored`)
      else {
        for (const [k, v] of Object.entries(root.task.agentAdvisor)) {
          const val = v === true ? "on" : v === false ? "off" : str(v)
          if (val) layer.agentAdvisor[k] = val
          else warnings.push(`${file}: task.agentAdvisor.${k} must be on, off or a model selector; ignored`)
        }
      }
    }
  }

  if (root.advisors !== undefined) {
    if (!Array.isArray(root.advisors)) warnings.push(`${file}: "advisors" must be a list; ignored`)
    else {
      root.advisors.forEach((e, i) => {
        if (!isObj(e)) {
          warnings.push(`${file}: advisors[${i}] is not a mapping; skipped`)
          return
        }
        const name = str(e.name)
        if (!name) {
          warnings.push(`${file}: advisors[${i}] has no "name"; skipped`)
          return
        }
        const where = `${file}: advisors[${name}]`
        for (const k of Object.keys(e)) if (!Object.hasOwn(ENTRY_KEYS, k)) warnings.push(`${where}: unknown key "${k}"`)
        const spec: Partial<AdvisorSpec> & { name: string; slug: string } = { name, slug: slugify(name), file }
        const en = bool(e.enabled)
        if (en !== undefined) spec.enabled = en
        else if (e.enabled !== undefined) warnings.push(`${where}.enabled must be true or false; ignored`)
        const model = str(e.model)
        if (model) spec.model = model
        if (e.tools !== undefined) {
          if (!Array.isArray(e.tools)) warnings.push(`${where}.tools must be a list; ignored`)
          else {
            const names = e.tools.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase())
            spec.tools = normalizeTools(names, where, warnings)
          }
        }
        if (e.reviewMode !== undefined) {
          if (e.reviewMode === "turn" || e.reviewMode === "agent-end") spec.reviewMode = e.reviewMode
          else warnings.push(`${where}.reviewMode must be "turn" or "agent-end"; ignored`)
        }
        if (e.reviewInterval !== undefined) {
          const n = e.reviewInterval
          if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_INTERVAL) spec.reviewInterval = n
          else warnings.push(`${where}.reviewInterval must be a positive integer; ignored`)
        }
        if (e.syncBacklog !== undefined) {
          const s = parseSyncBacklog(e.syncBacklog)
          if (s === undefined) warnings.push(`${where}.syncBacklog must be off, 1, 3, 5 or strict; ignored`)
          else spec.syncBacklog = s
        }
        if (e.maxNotesPerUpdate !== undefined) {
          const n = num(e.maxNotesPerUpdate, 1, 32)
          if (n === undefined) warnings.push(`${where}.maxNotesPerUpdate must be a number; ignored`)
          else spec.maxNotesPerUpdate = n
        }
        const si = str(e.instructions)
        if (si) spec.instructions = imports(si)
        layer.advisors.push(spec)
      })
    }
  }
  return layer
}

export interface LoadOptions {
  directory: string
  worktree?: string
  env?: NodeJS.ProcessEnv
  home?: string
}

export function loadConfig(opts: LoadOptions): AdvisorConfig {
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const warnings: string[] = []
  const sources: string[] = []
  const gdir = globalConfigDir(env, home)
  const dirs = ancestorDirs(opts.directory, opts.worktree, home)

  const layers: Layer[] = []
  for (const { file, raw } of discoverWatchdogYaml(dirs, gdir)) {
    let doc: unknown
    try {
      doc = parseYaml(raw)
    } catch (e) {
      warnings.push(`${file}: invalid YAML (${(e as Error).message.split("\n")[0]}); skipped`)
      continue
    }
    // 空ファイルは設定なしとして扱う。
    // File rỗng được coi là không có cấu hình.
    if (doc === null || doc === undefined) {
      sources.push(file)
      continue
    }
    if (!isObj(doc)) {
      warnings.push(`${file}: expected a mapping; skipped`)
      continue
    }
    layers.push(parseLayer(doc, file, warnings, home))
    sources.push(file)
  }

  // 近い層がスカラーを上書きし、instructions は読み順に連結、advisors は slug で統合する。
  // Lớp gần hơn ghi đè giá trị đơn, instructions nối theo thứ tự đọc, advisors gộp theo slug.
  const adv: Layer["advisor"] = {}
  const retry: RetryConfig = { ...DEFAULT_RETRY, fallbackChains: {} }
  const agentAdvisor: Record<string, string> = {}
  const instructions: string[] = []
  const roster = new Map<string, Partial<AdvisorSpec> & { name: string; slug: string }>()
  let topMaxNotes: number | undefined
  let modelRole: string | undefined
  for (const l of layers) {
    Object.assign(adv, l.advisor)
    const { fallbackChains, ...rest } = l.retry
    Object.assign(retry, rest)
    if (fallbackChains) Object.assign(retry.fallbackChains, fallbackChains)
    Object.assign(agentAdvisor, l.agentAdvisor)
    if (l.instructions) instructions.push(l.instructions)
    if (l.topMaxNotes !== undefined) topMaxNotes = l.topMaxNotes
    if (l.modelRole) modelRole = l.modelRole
    for (const a of l.advisors) roster.set(a.slug, { ...(roster.get(a.slug) ?? {}), ...a })
  }

  const { reviewMode, reviewInterval, controlModel, ...scalars } = adv
  const s = { ...DEFAULTS, ...scalars }
  // OPENCODE_ADVISOR は YAML より優先する (omp の --advisor 相当)。
  // OPENCODE_ADVISOR được ưu tiên hơn YAML (tương đương --advisor của omp).
  if (env.OPENCODE_ADVISOR === "0" || env.OPENCODE_ADVISOR === "off") s.enabled = false
  else if (env.OPENCODE_ADVISOR === "1" || env.OPENCODE_ADVISOR === "on") s.enabled = true

  if (roster.size === 0) {
    roster.set("advisor", { name: "advisor", slug: "advisor", reviewMode: reviewMode ?? "turn", reviewInterval: reviewInterval ?? 1, tools: DEFAULT_TOOLS })
  }
  const notesDefault = topMaxNotes ?? s.maxNotesPerUpdate
  const specs: AdvisorSpec[] = []
  for (const a of roster.values()) {
    specs.push({
      name: a.name,
      slug: a.slug,
      enabled: a.enabled ?? true,
      model: a.model ?? modelRole,
      tools: a.tools ?? [...DEFAULT_TOOLS],
      instructions: a.instructions ?? "",
      maxNotesPerUpdate: a.maxNotesPerUpdate ?? notesDefault,
      reviewMode: a.reviewMode ?? "turn",
      reviewInterval: a.reviewInterval ?? 1,
      syncBacklog: a.syncBacklog ?? s.syncBacklog,
      file: a.file,
    })
  }

  const wd = discoverWatchdog(dirs, gdir, home)
  for (const w of wd) sources.push(w.file)

  return {
    ...s,
    maxNotesPerUpdate: notesDefault,
    controlModel: controlModel ?? specs.find((x) => x.enabled && x.model && x.model !== "inherit")?.model,
    defaultModel: modelRole,
    retry,
    agentAdvisor,
    instructions: instructions.join("\n\n"),
    watchdog: wd.map((w) => w.content).join("\n\n"),
    advisors: specs,
    warnings,
    sources,
  }
}
