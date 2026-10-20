import fs from "node:fs"
import path from "node:path"
import { globalConfigDir, type AdvisorConfig, type AdvisorSpec } from "./config.ts"
import { unwrap, type Delivery } from "./delivery.ts"
import { buildAdvisorSystemPrompt } from "./prompts.ts"
import type { Registry } from "./registry.ts"
import type { AdvisorRuntime } from "./runtime.ts"
import { globalWatchdogFile } from "./setup.ts"
import { ADVISOR_TITLE_PREFIX, type Client, type Msg } from "./types.ts"
import { clip, parseModelSelector, slugify } from "./util.ts"
import { createTemplate, resolveWatchdogFile, setAdvisorEnabled, setModelRole } from "./yamlio.ts"

// プラグイン本体なしでも /advisor を動かしテストできるよう、必要なものを一か所に集める。
// Gom mọi thứ lệnh /advisor cần để chạy và test được mà không cần host plugin.
export interface CommandCtx {
  cfg: AdvisorConfig
  // enabled:false も含む実行中の roster。enable/disable/setup で書き換える。
  // Roster đang chạy, gồm cả entry enabled:false; enable/disable/setup sẽ sửa trực tiếp.
  specs: AdvisorSpec[]
  client: Client
  registry: Registry
  delivery: Delivery
  runtimes: Map<string, AdvisorRuntime[]>
  // ユーザーが advisor を止めたセッション。オフはセッション単位だから。
  // Các session người dùng đã tắt advisor, vì bật/tắt theo từng session.
  disabledSessions: Set<string>
  directory: string
  worktree: string | undefined
  env: NodeJS.ProcessEnv
  runtimesFor(id: string, create?: boolean): AdvisorRuntime[]
  disposeSession(id: string): void
  // エントリの有効/無効が変わったので、全セッションの runtime を即座に起動/停止する。
  // Entry vừa được bật/tắt nên khởi động/dừng runtime ở mọi session ngay lập tức.
  applyEnabled(spec: AdvisorSpec): void
}

const RESTART_NOTE = "Other configuration changes (tools, instructions, cadence, retry) need an opencode restart."

export const COMMAND_DESCRIPTION =
  "Control the live advisor: (toggle) | status | on | off | pause | resume | reset | inbox | dump [raw] | configure [init [project|user]] | enable <name> | disable <name> | setup <model>"

export async function control(ctx: CommandCtx, sessionID: string, args: string): Promise<string> {
  const [sub = "", ...rest] = args.trim().split(/\s+/)
  switch (sub.toLowerCase()) {
    case "":
      return ctx.disabledSessions.has(sessionID) ? turnOn(ctx, sessionID) : turnOff(ctx, sessionID)
    case "status":
      return statusReport(ctx, sessionID)
    case "on":
      return turnOn(ctx, sessionID)
    case "off":
      return turnOff(ctx, sessionID)
    case "pause":
      ctx.runtimesFor(sessionID, false).forEach((r) => r.pause())
      return "Advisor **paused** for this session. Updates are kept; `/advisor resume` reviews them."
    case "resume":
      ctx.runtimesFor(sessionID, false).forEach((r) => r.resume())
      return "Advisor **resumed** for this session."
    case "reset":
      ctx.runtimesFor(sessionID, false).forEach((r) => r.reset())
      return "Advisor context and failure state **reset** for this session; the next review re-primes from the recent transcript."
    case "inbox":
      return inboxReport(ctx, sessionID)
    case "dump":
      return dump(ctx, sessionID, rest[0]?.toLowerCase() === "raw")
    case "configure":
      return configure(ctx, rest)
    case "enable":
      return setEnabled(ctx, rest.join(" "), true)
    case "disable":
      return setEnabled(ctx, rest.join(" "), false)
    case "setup":
      return setup(ctx, rest[0])
    default:
      return `Unknown subcommand \`${[sub, ...rest].join(" ")}\`. Use: ${COMMAND_DESCRIPTION.replace(/^[^:]*: /, "")}.`
  }
}

function turnOn(ctx: CommandCtx, sessionID: string): string {
  ctx.disabledSessions.delete(sessionID)
  ctx.registry.fresh.delete(sessionID) // a session that already has history is not replayed in full...
  ctx.registry.enabledAt = Date.now() // ...only what happens from now on is reviewed
  return "Advisor on for this session. It starts with the next completed turn (existing history is not replayed)."
}

function turnOff(ctx: CommandCtx, sessionID: string): string {
  ctx.disabledSessions.add(sessionID)
  ctx.disposeSession(sessionID)
  return "Advisor off for this session. In-flight reviews were aborted."
}

// ---------------------------------------------------------------- status

interface Usage {
  cost: number
  tokensIn: number
  tokensOut: number
  contextTokens: number
}

const advisorName = (title: string) => title.slice(ADVISOR_TITLE_PREFIX.length).trim().replace(/ #\d+$/, "")

interface ChildSession {
  id: string
  title: string
  time?: { created?: number }
}

async function advisorChildren(ctx: CommandCtx, primaryID: string): Promise<ChildSession[]> {
  const list = unwrap<ChildSession[]>(await ctx.client.session.children({ path: { id: primaryID } }))
  return list.filter((c) => typeof c.title === "string" && c.title.startsWith(ADVISOR_TITLE_PREFIX)).sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
}

// 子セッション全体から集計すれば、リセットや再起動をまたいでも合計が正しい。
// Cộng dồn từ mọi session con của advisor để tổng không mất khi reset hoặc khởi động lại plugin.
async function usageFromChildren(ctx: CommandCtx, primaryID: string): Promise<Map<string, Usage> | undefined> {
  try {
    const out = new Map<string, Usage>()
    for (const child of await advisorChildren(ctx, primaryID)) {
      const name = advisorName(child.title)
      const u = out.get(name) ?? { cost: 0, tokensIn: 0, tokensOut: 0, contextTokens: 0 }
      const msgs = unwrap<Msg[]>(await ctx.client.session.messages({ path: { id: child.id } }))
      for (const m of msgs) {
        if (m.info.role !== "assistant") continue
        const t = m.info.tokens
        const inTok = (t?.input ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0)
        const outTok = (t?.output ?? 0) + (t?.reasoning ?? 0)
        u.cost += m.info.cost ?? 0
        u.tokensIn += inTok
        u.tokensOut += outTok
        if (m.info.time?.completed) u.contextTokens = inTok + (t?.output ?? 0)
      }
      out.set(name, u)
    }
    return out
  } catch {
    return undefined
  }
}

function stateOf(spec: AdvisorSpec, r: AdvisorRuntime | undefined): string {
  if (!spec.enabled) return "paused"
  if (!r) return spec.model ? "idle" : "inactive/no_model"
  switch (r.status) {
    case "failed":
      return "halted"
    case "no_model":
      return "inactive/no_model"
    default:
      return r.status
  }
}

export async function statusReport(ctx: CommandCtx, sessionID: string): Promise<string> {
  const { cfg, specs } = ctx
  const on = !ctx.disabledSessions.has(sessionID)
  const lines: string[] = []
  lines.push(`**Advisor** is **${on ? "on" : "off"}** for this session · immune turns ${cfg.immuneTurns} · continue severity \`${cfg.continueSeverity}\` · syncBacklog \`${cfg.syncBacklog}\``)
  const list = ctx.runtimes.get(sessionID) ?? []
  const usage = await usageFromChildren(ctx, sessionID)
  lines.push(
    "",
    "| advisor | state | model | mode | sync | reviews | notes n/c/b | filtered | context | tokens in/out | cost | deferred |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  )
  for (const spec of specs) {
    const r = list.find((x) => x.spec.slug === spec.slug)
    const s = r?.stats
    const u = usage?.get(spec.name)
    const model = r ? `${r.chain.current() ?? r.spec.model ?? "-"}${r.chain.isFallback() ? " (fallback)" : ""}` : (spec.model ?? "-")
    const cost = u?.cost ?? s?.cost ?? 0
    lines.push(
      `| ${spec.name} | ${stateOf(spec, r)} | ${model} | ${spec.reviewMode}/${spec.reviewInterval} | ${spec.syncBacklog} | ${s?.reviews ?? 0} | ${s ? `${s.notes.nit}/${s.notes.concern}/${s.notes.blocker}` : "0/0/0"} | ${s ? s.rejected + s.quarantined : 0} | ${u?.contextTokens ?? s?.contextTokens ?? 0} | ${u?.tokensIn ?? s?.tokensIn ?? 0}/${u?.tokensOut ?? s?.tokensOut ?? 0} | $${cost.toFixed(4)} | ${r?.pendingDeferred ?? 0} |`,
    )
  }
  for (const r of list) if (r.lastError) lines.push("", `- ${r.spec.name} last error: ${clip(r.lastError, 300)}`)
  if (list.length === 0 && on) lines.push("", "No review has run in this session yet.")
  if (!specs.some((sp) => sp.model)) lines.push("", "⚠ No advisor model is set. Run `/advisor setup <provider/model>`.")
  const flags = [`asides queued: ${ctx.delivery.pendingAsides(sessionID)}`]
  if (ctx.delivery.isSuppressed(sessionID)) flags.push("auto-resume suppressed (you interrupted; send a message to re-arm)")
  if (ctx.delivery.steersLeft(sessionID) <= 0) flags.push("steering cap reached for this prompt (notes become cards)")
  if (ctx.delivery.immuneLeft(sessionID) > 0) flags.push(`cooldown: ${ctx.delivery.immuneLeft(sessionID)} turn(s)`)
  lines.push("", flags.join(" · "))
  if (cfg.sources.length) lines.push("", "Config: " + cfg.sources.map((f) => `\`${f}\``).join(", "))
  for (const w of cfg.warnings) lines.push(`- ⚠ ${w}`)
  return lines.join("\n")
}

export function inboxReport(ctx: CommandCtx, sessionID: string): string {
  const items = ctx.delivery.inbox(sessionID)
  if (items.length === 0) return "No advisor notes have been delivered in this session."
  return ["**Advisor inbox** (most recent last)", "", ...items.slice(-15).map((n) => `- **${n.severity}** · ${n.advisor}: ${clip(n.text.replace(/\s+/g, " "), 400)}`)].join("\n")
}

// ---------------------------------------------------------------- dump

function renderDumpMessage(m: Msg, raw: boolean): string[] {
  const out: string[] = []
  for (const p of m.parts) {
    if (p.type === "text") {
      if (p.text.trim()) out.push(m.info.role === "user" ? `[update]\n${p.text.trim()}` : p.text.trim())
    } else if (p.type === "reasoning") {
      if (raw && p.text.trim()) out.push(`[reasoning]\n${p.text.trim()}`)
    } else if (p.type === "tool") {
      const st = p.state
      const input = "input" in st ? (st.input as Record<string, unknown>) : {}
      const output = st.status === "completed" ? st.output : st.status === "error" ? st.error : ""
      if (p.tool === "advise") {
        out.push(`[advise ${String(input.severity ?? "nit")}] ${String(input.note ?? "")}`)
        if (output) out.push(`  -> ${String(output)}`)
      } else if (raw) {
        out.push(`[tool ${p.tool}] ${JSON.stringify(input)}`)
        if (output) out.push(`  -> ${String(output)}`)
      }
    }
  }
  return out
}

async function dump(ctx: CommandCtx, sessionID: string, raw: boolean): Promise<string> {
  let children: ChildSession[]
  try {
    children = await advisorChildren(ctx, sessionID)
  } catch (e) {
    return `Could not list advisor sessions: ${e instanceof Error ? e.message : String(e)}`
  }
  const blocks: string[] = []
  for (const spec of ctx.specs) {
    const own = children.filter((c) => advisorName(c.title) === spec.name)
    const latest = own.at(-1)
    if (!latest) continue
    const msgs = unwrap<Msg[]>(await ctx.client.session.messages({ path: { id: latest.id } }))
    const body: string[] = []
    if (raw) {
      body.push(
        `[system prompt]\n${buildAdvisorSystemPrompt({ name: spec.name, maxNotes: spec.maxNotesPerUpdate, watchdog: ctx.cfg.watchdog, shared: ctx.cfg.instructions, specialization: spec.instructions })}`,
        `[tools] advise${spec.tools.length ? ", " + spec.tools.join(", ") : ""}`,
      )
    }
    for (const m of msgs) body.push(...renderDumpMessage(m, raw))
    blocks.push(`### ${spec.name}\n\n${body.join("\n\n")}`)
  }
  if (blocks.length === 0) return "No advisor session exists for this session yet."
  return blocks.join("\n\n")
}

// ---------------------------------------------------------------- configure / enable / setup

function projectFile(ctx: CommandCtx): string {
  // 非 git のプロジェクトでは worktree が "/" になる。そこに設定を作ってはいけない。
  // Project không phải git thì worktree là "/"; không được tạo cấu hình ở đó.
  const wt = ctx.worktree
  const root = wt && wt !== path.parse(wt).root && ctx.directory.startsWith(wt) ? wt : ctx.directory
  const inDot = resolveWatchdogFile(path.join(root, ".opencode"))
  return fs.existsSync(inDot) ? inDot : resolveWatchdogFile(root)
}

function configure(ctx: CommandCtx, rest: string[]): string {
  const project = projectFile(ctx)
  const user = path.join(globalConfigDir(ctx.env), "WATCHDOG.yml")
  const userFile = fs.existsSync(user) ? user : resolveWatchdogFile(path.dirname(user))
  if (rest[0]?.toLowerCase() === "init") {
    const scope = (rest[1] ?? "project").toLowerCase()
    if (scope !== "project" && scope !== "user") return "Usage: `/advisor configure init [project|user]`."
    const file = scope === "user" ? userFile : project
    const r = createTemplate(file)
    return r.ok ? `Created \`${r.file}\`. Edit it, then restart opencode. Use \`/advisor enable|disable <name>\` and \`/advisor setup <model>\` for live changes.` : r.error
  }
  const lines = [
    "**Advisor configuration**",
    "",
    `- Project: \`${project}\` (${fs.existsSync(project) ? "exists" : "missing"})`,
    `- User: \`${userFile}\` (${fs.existsSync(userFile) ? "exists" : "missing"})`,
    "- Create a sample with `/advisor configure init [project|user]`.",
    "",
    "Advisors:",
    ...ctx.specs.map((s) => `- ${s.name}: ${s.enabled ? "enabled" : "disabled"} · ${s.model ?? "no model"} · ${s.reviewMode}/${s.reviewInterval}${s.file ? ` · \`${s.file}\`` : ""}`),
  ]
  if (ctx.cfg.warnings.length) lines.push("", "Warnings:", ...ctx.cfg.warnings.map((w) => `- ⚠ ${w}`))
  lines.push("", RESTART_NOTE)
  return lines.join("\n")
}

function setEnabled(ctx: CommandCtx, name: string, enabled: boolean): string {
  const verb = enabled ? "enable" : "disable"
  if (!name.trim()) return `Usage: \`/advisor ${verb} <name>\`.`
  const slug = slugify(name)
  const spec = ctx.specs.find((s) => s.slug === slug)
  if (!spec) return `No advisor named "${name}". Known: ${ctx.specs.map((s) => s.name).join(", ")}.`
  if (!spec.file) return `"${spec.name}" is the built-in default advisor and is not listed in any WATCHDOG.yml; there is no entry to ${verb}.`
  const r = setAdvisorEnabled(spec.file, spec.name, enabled)
  if (!r.ok) return r.error
  spec.enabled = enabled
  ctx.applyEnabled(spec)
  return `Advisor "${spec.name}" **${enabled ? "enabled" : "disabled"}** (saved in \`${r.file}\`) and applied now. ${RESTART_NOTE}`
}

function setup(ctx: CommandCtx, model: string | undefined): string {
  if (!model) return "Usage: `/advisor setup <provider/model[:level]>` (or `inherit` to use the primary's model). Example: `/advisor setup anthropic/claude-haiku-4-5`."
  if (model !== "inherit" && !parseModelSelector(model)) return `Setup failed: "${model}" is not "provider/model" (or "inherit").`
  const w = setModelRole(globalWatchdogFile(ctx.env), model)
  if (!w.ok) return `Setup failed: ${w.error}`
  // 旧既定モデルを継承していたエントリだけ新モデルに追従し、個別指定は保つ。
  // Chỉ entry kế thừa model mặc định cũ mới đổi theo; entry có model riêng giữ nguyên.
  for (const sp of ctx.specs) if (!sp.model || sp.model === ctx.cfg.defaultModel) sp.model = model
  ctx.cfg.defaultModel = model
  for (const list of ctx.runtimes.values()) list.forEach((r) => r.reset())
  return `Advisor model set to \`${model}\` (saved in \`${w.file}\`) and active now. A project-level WATCHDOG.yml with its own \`modelRoles.advisor\` or per-advisor \`model\` still takes precedence after a restart.`
}
