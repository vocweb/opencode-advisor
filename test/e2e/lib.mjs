// Shared helpers for the advisor E2E suite (real opencode binary + scripted mock LLM).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startMock, startOpencode, collectEvents, waitFor, sleep } from "./harness.mjs"

export { waitFor, sleep }

const here = path.dirname(fileURLToPath(import.meta.url))
export const DIST = path.resolve(here, "../../dist/advisor.js")

export const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""))
export const lastUserText = (ctx) => {
  for (let i = ctx.messages.length - 1; i >= 0; i--) if (ctx.messages[i].role === "user") return textOf(ctx.messages[i])
  return ""
}

/** Default scripted behaviour of the advisor model: say nothing. */
const defaultAdvisorPlan = () => ({ text: "No findings." })

/** Default primary model: RUN_STEPS:n -> n bash tool calls then a final text; anything else -> a plain reply. */
function defaultMainPlan(ctx, st) {
  const all = JSON.stringify(ctx.messages)
  const m = all.match(/RUN_STEPS:(\d+)/)
  if (m) {
    const n = Number(m[1])
    const done = ctx.messages.filter((x) => x.role === "tool").length
    if (done < n) return { delayMs: st.mainDelay, toolCalls: [{ name: "bash", args: { command: `echo step${done}`, description: "echo" } }] }
    return { text: "steps finished" }
  }
  return { delayMs: st.mainDelay ? 50 : 0, text: "plain reply" }
}

const TOP_LEVEL = ["instructions", "advisors", "retry", "task", "modelRoles", "maxNotesPerUpdate"]

/** Flat shorthand used by the scenarios -> WATCHDOG.yml layout: `model` -> modelRoles.advisor, known top-level keys stay, the rest goes under `advisor:`. */
export function toWatchdog(flat) {
  if (!flat) return flat
  const out = { advisor: {} }
  for (const [k, v] of Object.entries(flat)) {
    if (k === "model") out.modelRoles = { advisor: v }
    else if (TOP_LEVEL.includes(k)) out[k] = v
    else out.advisor[k] = v
  }
  return out
}

export async function makeEnv(opts = {}) {
  const {
    advisor = { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 30000 },
    extraConfig = {},
    projectFiles = {},
    globalFiles = {},
    withPlugin = true,
    root,
  } = opts
  const st = {
    mainDelay: 500,
    advisorPlan: defaultAdvisorPlan,
    afterTools: null,
    mainPlan: null,
    advisorCalls: [], // transcript text of each advisor update
  }
  const route = (ctx) => {
    if (ctx.tools.includes("advise")) {
      const last = ctx.messages.at(-1)
      if (last.role === "tool") return st.afterTools ? st.afterTools(ctx, st) : { text: "done" }
      const upd = lastUserText(ctx)
      st.advisorCalls.push(upd)
      return st.advisorPlan(ctx, upd, st)
    }
    if (ctx.tools.length === 0) return /title/i.test(ctx.system) ? { text: "T" } : { text: "ok" }
    return (st.mainPlan || defaultMainPlan)(ctx, st)
  }
  const mock = await startMock(route)
  const oc = await startOpencode({
    mockPort: mock.port,
    pluginFiles: withPlugin ? { "advisor.js": fs.readFileSync(DIST, "utf8") } : {},
    advisorConfig: toWatchdog(advisor),
    extraConfig,
    projectFiles,
    globalFiles,
    root,
  })
  const events = await collectEvents(oc.client)
  const c = oc.client
  const env = {
    st,
    mock,
    oc,
    c,
    events,
    /** requests that belong to advisor reviews (the model call that carries the `advise` tool) */
    advisorReqs: () => mock.requests.filter((r) => r.tools.includes("advise")),
    /** advisor review starts (requests whose last message is not a tool result) */
    reviewStarts: () => mock.requests.filter((r) => r.tools.includes("advise") && r.messages.at(-1).role !== "tool"),
    mainReqs: () => mock.requests.filter((r) => !r.tools.includes("advise") && r.tools.length > 0),
    newSession: async (title = "t") => (await c.session.create({ body: { title } })).data,
    /** run a primary prompt to completion */
    run: async (id, text, extra = {}) => {
      const r = await c.session.prompt({ path: { id }, body: { parts: [{ type: "text", text }], ...extra } })
      if (r.error) throw new Error("prompt failed: " + JSON.stringify(r.error))
      return r.data
    },
    transcript: async (id) => (await c.session.messages({ path: { id } })).data,
    command: async (id, args) => {
      const r = await c.session.command({ path: { id }, body: { command: "advisor", arguments: args } })
      if (r.error) throw new Error("command failed: " + JSON.stringify(r.error))
      const parts = r.data?.parts ?? []
      return parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
    },
    children: async (id) => (await c.session.children({ path: { id } })).data,
    /** wait until the advisor has no more work: N review starts seen and no new request for `quiet` ms */
    settle: async (quiet = 1200, timeout = 25000) => {
      const start = Date.now()
      let last = mock.requests.length
      let lastChange = Date.now()
      while (Date.now() - start < timeout) {
        await sleep(150)
        if (mock.requests.length !== last) {
          last = mock.requests.length
          lastChange = Date.now()
        } else if (Date.now() - lastChange >= quiet) return
      }
    },
    stop: async () => {
      await oc.stop()
      await mock.close()
    },
  }
  return env
}

// ---------------------------------------------------------------- tiny test runner

const results = []
export function createRunner() {
  let current = null
  return {
    async scenario(name, fn) {
      current = { name, checks: [], error: null }
      const t0 = Date.now()
      process.stdout.write(`\n▶ ${name}\n`)
      try {
        await fn((label, cond, detail) => {
          current.checks.push({ label, ok: !!cond, detail })
          console.log(`   ${cond ? "✓" : "✗"} ${label}${!cond && detail !== undefined ? "\n       → " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600) : ""}`)
        })
      } catch (e) {
        current.error = e
        console.log(`   ✗ scenario crashed: ${e?.stack || e}`)
      }
      current.ms = Date.now() - t0
      results.push(current)
    },
    summary() {
      const checks = results.flatMap((r) => r.checks)
      const failed = checks.filter((c) => !c.ok).length + results.filter((r) => r.error).length
      console.log(`\n==== ${results.length} scenarios, ${checks.length} checks, ${failed} failed ====`)
      for (const r of results) {
        const bad = r.checks.filter((c) => !c.ok).length + (r.error ? 1 : 0)
        console.log(`${bad ? "✗" : "✓"} ${r.name} (${(r.ms / 1000).toFixed(1)}s)${bad ? `  [${bad} failed]` : ""}`)
      }
      return failed
    },
  }
}
