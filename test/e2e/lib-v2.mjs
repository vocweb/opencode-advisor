// Shared helpers for the opencode 2.x E2E suite (mirrors lib.mjs makeEnv).
import fs from "node:fs"
import { startMock, startOpencodeV2, collectEventsV2, waitFor, sleep } from "./harness-v2.mjs"
import { DIST, toWatchdog, lastUserText, textOf, createRunner } from "./lib.mjs"

export { waitFor, sleep, DIST, toWatchdog, lastUserText, textOf, createRunner }

const defaultAdvisorPlan = () => ({ text: "No findings." })

function defaultMainPlan(ctx, st) {
  const all = JSON.stringify(ctx.messages)
  const m = all.match(/RUN_STEPS:(\d+)/)
  if (m) {
    const n = Number(m[1])
    const done = ctx.messages.filter((x) => x.role === "tool").length
    if (done < n) return { delayMs: st.mainDelay, toolCalls: [{ name: "shell", args: { command: `echo step${done}`, description: "echo" } }] }
    return { text: "steps finished" }
  }
  return { delayMs: st.mainDelay ? 50 : 0, text: "plain reply" }
}

export async function makeEnvV2(opts = {}) {
  const {
    advisor = { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 30000 },
    extraConfig = {},
    projectFiles = {},
    pluginFiles,
    globalFiles = {},
    withPlugin = true,
    root,
  } = opts
  const st = { mainDelay: 500, advisorPlan: defaultAdvisorPlan, afterTools: null, mainPlan: null, advisorCalls: [] }
  // The advisor is recognised by its system prompt, not by the `advise` tool: other requests (compaction, titles) may list it too.
  const isAdvisor = (ctx) => /silent, always-on reviewer/.test(ctx.system)
  const allText = (ctx) => ctx.messages.map((m) => textOf(m)).join("\n")
  const route = (ctx) => {
    // Compaction asks for a summary in a fixed template; answer with the template itself so it validates.
    if (/MUST summarize the conversation|did not fill in the required summary template/.test(allText(ctx))) {
      const t = allText(ctx).match(/<template>([\s\S]*?)<\/template>/)
      return { text: t ? t[1].trim() : "summary" }
    }
    if (isAdvisor(ctx)) {
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
  const oc = await startOpencodeV2({
    mockPort: mock.port,
    pluginFiles: pluginFiles ?? (withPlugin ? { "advisor.js": fs.readFileSync(DIST, "utf8") } : {}),
    advisorConfig: toWatchdog(advisor),
    extraConfig,
    projectFiles,
    globalFiles,
    root,
  })
  const c = oc.client
  const events = collectEventsV2(c)
  const items = async (id) => await c.session.inbox.list({ sessionID: id })
  const env = {
    st,
    mock,
    oc,
    c,
    events,
    advisorReqs: () => mock.requests.filter(isAdvisor),
    reviewStarts: () => mock.requests.filter((r) => isAdvisor(r) && r.messages.at(-1).role !== "tool"),
    mainReqs: () => mock.requests.filter((r) => !isAdvisor(r) && r.tools.length > 0),
    newSession: async (title = "t") => await c.session.create({ title }),
    /** prompt then wait for the session to go idle */
    run: async (id, text, extra = {}) => {
      await c.session.prompt({ sessionID: id, text, ...extra })
      await c.session.wait({ sessionID: id })
    },
    transcript: async (id) => await c.session.context({ sessionID: id }),
    /** sessions whose parentID is `id` (session.list with parentID filter) */
    children: async (id) => {
      const r = await c.session.list({ parentID: id })
      return r.data
    },
    /**
     * Runs `/advisor <args>` and returns the visible reply. The plugin answers with a synthetic
     * message whose `description` carries the reply. Look at: session.context() items of
     * type "synthetic" and session.inbox.list() items (type "synthetic", payload.description/text)
     * that did not exist before the command; return the newest one's description (fallback: text).
     */
    command: async (id, args = "") => {
      const key = (m) => m.id
      const before = new Set([...(await c.session.context({ sessionID: id })).filter((m) => m.type === "synthetic").map(key), ...(await items(id)).filter((m) => m.type === "synthetic").map(key)])
      await c.session.command({ sessionID: id, name: "advisor", text: args })
      const pick = async () => {
        const ctxMsgs = (await c.session.context({ sessionID: id })).filter((m) => m.type === "synthetic" && !before.has(m.id))
        const inbox = (await items(id)).filter((m) => m.type === "synthetic" && !before.has(m.id)).map((m) => ({ ...m.payload, time: m.time }))
        const all = [...ctxMsgs, ...inbox].sort((a, b) => a.time.created - b.time.created)
        const last = all.at(-1)
        return last ? (last.description ?? last.text) : undefined
      }
      const r = await waitFor(pick, { timeout: 20000, label: "advisor command reply" })
      return r
    },
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
      await events.stop()
      await oc.stop()
      await mock.close()
    },
  }
  return env
}

/** Same tiny runner as v1. */
export const createRunnerV2 = createRunner
