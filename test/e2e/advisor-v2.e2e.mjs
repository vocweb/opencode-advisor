// End-to-end suite for opencode 2.x: the built plugin (dist/advisor.js) in a real `opencode serve` 2.x, against the scripted mock LLM.
import fs from "node:fs"
import { createRunnerV2, DIST, makeEnvV2, sleep, toWatchdog, waitFor } from "./lib-v2.mjs"

const only = process.argv.slice(2)
const R = createRunnerV2()
const want = (name) => only.length === 0 || only.some((f) => name.toLowerCase().includes(f.toLowerCase()))
const scenario = (name, fn) => (want(name) ? R.scenario(name, fn) : Promise.resolve())

const adviseCall = (note, severity) => ({ name: "advise", args: { note, severity } })
const synthetics = (tr) => tr.filter((m) => m.type === "synthetic")
const advisoryText = (m) => String(m.text ?? "")
const advisories = (tr) => synthetics(tr).filter((m) => /<advisory/.test(advisoryText(m)))

await scenario("wiring: advise is hidden from the primary, granted only to the advisor agent; the advisor is a child session", async (check) => {
  const env = await makeEnvV2()
  try {
    const s = await env.newSession("wiring")
    await env.run(s.id, "hello")
    await env.settle()
    check("the advisor reviewed the turn", env.reviewStarts().length >= 1, env.reviewStarts().length)
    check("the primary never sees `advise`", env.mainReqs().every((r) => !r.tools.includes("advise")), env.mainReqs().map((r) => r.tools))
    const adv = env.reviewStarts()[0]
    check("the advisor sees `advise` and only read-only investigative tools", adv && adv.tools.includes("advise") && adv.tools.every((t) => ["advise", "read", "grep", "glob"].includes(t)), adv?.tools)
    const kids = await env.children(s.id)
    check("the advisor lives in a child session titled [advisor]", kids.some((k) => String(k.title).startsWith("[advisor]")), kids.map((k) => k.title))
  } finally {
    await env.stop()
  }
})

await scenario("delta: the advisor gets the user prompt, and later reviews only what is new", async (check) => {
  const env = await makeEnvV2()
  try {
    const s = await env.newSession("delta")
    await env.run(s.id, "FIRST_PROMPT please")
    await env.settle()
    await env.run(s.id, "SECOND_PROMPT please")
    await env.settle()
    check("the first update has the user prompt", /FIRST_PROMPT/.test(env.st.advisorCalls[0] ?? ""), env.st.advisorCalls[0])
    const later = env.st.advisorCalls.slice(1).join("\n")
    check("a later update contains the second prompt", /SECOND_PROMPT/.test(later))
    check("and does not repeat the first one", !/FIRST_PROMPT/.test(later))
  } finally {
    await env.stop()
  }
})

await scenario("steer: a blocker found mid-run is injected into the running turn", async (check) => {
  const env = await makeEnvV2()
  try {
    env.st.mainDelay = 700
    let sent = false
    env.st.advisorPlan = (ctx, upd) => {
      if (!sent && /STEER_ME/.test(upd)) {
        sent = true
        return { toolCalls: [adviseCall("BLOCKER_NOTE: the migration drops the table.", "blocker")] }
      }
      return { text: "No findings." }
    }
    const s = await env.newSession("steer")
    await env.run(s.id, "RUN_STEPS:4 STEER_ME")
    await env.settle()
    const carrying = env.mainReqs().filter((r) => JSON.stringify(r.messages).includes("BLOCKER_NOTE"))
    check("a later primary request carries the advisory", carrying.length >= 1, env.mainReqs().length)
    check("requests before the injection did not have it", env.mainReqs()[0] && !JSON.stringify(env.mainReqs()[0].messages).includes("BLOCKER_NOTE"))
    check("the advisory is a blocker advisory element", /<advisory[^>]*severity=\\?"blocker/.test(JSON.stringify(carrying[0]?.messages ?? "")))
    check("the advisor never saw its own advisory fed back", !env.st.advisorCalls.some((u) => /<advisory/.test(u)), env.st.advisorCalls.filter((u) => /<advisory/.test(u)).length)
    check("exactly one advisory message exists in the transcript", advisories(await env.transcript(s.id)).length === 1)
  } finally {
    await env.stop()
  }
})

await scenario("routing: a blocker raised after the agent went idle wakes it", async (check) => {
  const env = await makeEnvV2()
  try {
    let sent = false
    env.st.advisorPlan = (ctx, upd) => {
      if (!sent && /WAKE_ME/.test(upd)) {
        sent = true
        // slow enough that the primary has finished its run when the note arrives
        return { delayMs: 1500, toolCalls: [adviseCall("WAKE_NOTE: tests were never run.", "blocker")] }
      }
      return { text: "No findings." }
    }
    const s = await env.newSession("wake")
    await env.run(s.id, "WAKE_ME hello")
    const before = env.mainReqs().length
    await waitFor(() => env.mainReqs().length > before, { timeout: 25000, label: "the wake turn" }).catch(() => {})
    await env.settle(2500)
    check("exactly one extra primary turn was started", env.mainReqs().length === before + 1, [before, env.mainReqs().length])
    check("the wake request carries the blocker", /WAKE_NOTE/.test(JSON.stringify(env.mainReqs().at(-1).messages)))
  } finally {
    await env.stop()
  }
})

await scenario("routing: a concern after the final answer becomes a visible card when continueSeverity is blocker", async (check) => {
  const env = await makeEnvV2({ advisor: { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 30000, continueSeverity: "blocker" } })
  try {
    let sent = false
    env.st.advisorPlan = (ctx, upd) => {
      if (!sent && /CARD_ME/.test(upd)) {
        sent = true
        return { delayMs: 1500, toolCalls: [adviseCall("CARD_NOTE: the rollback path is untested.", "concern")] }
      }
      return { text: "No findings." }
    }
    const s = await env.newSession("card")
    await env.run(s.id, "CARD_ME hello")
    const before = env.mainReqs().length
    await env.settle(3000)
    check("the agent was not woken", env.mainReqs().length === before, [before, env.mainReqs().length])
    const inbox = await env.c.session.inbox.list({ sessionID: s.id })
    const card = inbox.find((m) => m.type === "synthetic" && /CARD_NOTE/.test(JSON.stringify(m.payload)))
    check("the card waits in the inbox with a description the user can read", !!card && /CARD_NOTE/.test(card.payload.description ?? ""), inbox.map((m) => m.type))
    await env.run(s.id, "continue please")
    check("the next user turn carries the concern into the model's context", /CARD_NOTE/.test(JSON.stringify(env.mainReqs().at(-1).messages)))
  } finally {
    await env.stop()
  }
})

await scenario("routing: a nit is a one-shot aside, delivered on the next call only and never persisted", async (check) => {
  const env = await makeEnvV2()
  try {
    let sent = false
    env.st.advisorPlan = (ctx, upd) => {
      if (!sent && /NIT_ME/.test(upd)) {
        sent = true
        return { toolCalls: [adviseCall("NIT_NOTE: rename the helper for clarity.", "nit")] }
      }
      return { text: "No findings." }
    }
    const s = await env.newSession("nit")
    await env.run(s.id, "NIT_ME please")
    await env.settle()
    check("a nit is not persisted into the transcript", !JSON.stringify(await env.transcript(s.id)).includes("NIT_NOTE"))
    await env.run(s.id, "next prompt")
    const carrying = env.mainReqs().filter((r) => JSON.stringify(r.messages).includes("NIT_NOTE"))
    check("the next primary call carries the nit as an advisory element", carrying.length === 1 && /<advisory[^>]*severity=\\?"nit/.test(JSON.stringify(carrying[0].messages)), carrying.length)
    await env.run(s.id, "and another")
    check("and it is not repeated afterwards", env.mainReqs().filter((r) => JSON.stringify(r.messages).includes("NIT_NOTE")).length === 1)
  } finally {
    await env.stop()
  }
})

await scenario("control: /advisor status answers without a model call and /advisor off stops reviews for this session", async (check) => {
  const env = await makeEnvV2()
  try {
    const s = await env.newSession("control")
    await env.run(s.id, "hello")
    await env.settle()
    const before = env.mock.requests.length
    const status = await env.command(s.id, "status")
    check("status lists the advisor", /Advisor/.test(status) && /\| advisor \|/.test(status), status)
    check("answering needed no model call", env.mock.requests.length === before, [before, env.mock.requests.length])
    check("off is acknowledged", /off for this session/.test(await env.command(s.id, "off")))
    const reviews = env.reviewStarts().length
    await env.run(s.id, "while off")
    await env.settle(1500)
    check("no review while off", env.reviewStarts().length === reviews, [reviews, env.reviewStarts().length])
    check("on is acknowledged", /on for this session/.test(await env.command(s.id, "on")))
    await env.run(s.id, "while on")
    await env.settle()
    check("reviews resume", env.reviewStarts().length > reviews)
    check("the control prompt and its reply never reach the advisor", !env.st.advisorCalls.some((u) => /The \/advisor reply is shown/.test(u)))
  } finally {
    await env.stop()
  }
})

await scenario("tools: a granted write tool follows the user's policy (ask with a timeout); reading secrets stays denied", async (check) => {
  const fs = await import("node:fs")
  const path = await import("node:path")
  for (const policy of ["ask", "allow"]) {
    const env = await makeEnvV2({
      advisor: { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 60000, permissionTimeoutMs: 3000, advisors: [{ name: "Fixer", tools: ["read", "edit"] }] },
      projectFiles: { ".env": "SECRET=1\n", "ok.txt": "fine\n" },
      extraConfig: policy === "allow" ? { permission: { edit: "allow" } } : {},
    })
    try {
      const target = path.join(env.oc.dir, "advisor-wrote.txt")
      let step = 0
      env.st.advisorPlan = () => {
        step++
        if (step === 1) return { toolCalls: [{ name: "read", args: { path: path.join(env.oc.dir, ".env") } }] }
        if (step === 2) return { toolCalls: [{ name: "write", args: { path: target, content: "by the advisor" } }] }
        return { text: "No findings." }
      }
      env.st.afterTools = (ctx) => (step === 1 ? (step++, { toolCalls: [{ name: "write", args: { path: target, content: "by the advisor" } }] }) : { text: "No findings." })
      const s = await env.newSession(`perm-${policy}`)
      const t0 = Date.now()
      await env.run(s.id, "hello")
      await waitFor(async () => /\| Fixer \| idle \|/.test(await env.command(s.id, "status")) && env.reviewStarts().length >= 1, { timeout: 30000, label: "review finished" }).catch(() => {})
      const exists = fs.existsSync(target)
      const toolResults = env.advisorReqs().flatMap((r) => r.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)))
      if (policy === "ask") {
        check("without a user rule the write is not performed silently", !exists, { exists })
        check("and the review ends instead of waiting forever", Date.now() - t0 < 30000, Date.now() - t0)
        check("reading .env was denied", !toolResults.some((t) => /SECRET=1/.test(t)), toolResults)
      } else check("with the user's own allow rule the write runs", exists)
    } finally {
      await env.stop()
    }
  }
})

await scenario("fallback: a retryable 429 does not hang the review; the chain moves to the next model", async (check) => {
  const env = await makeEnvV2({ advisor: { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 60000, retry: { fallbackChains: { advisor: ["mock/alt"] }, maxDelayMs: 600000 } } })
  try {
    env.st.advisorPlan = (ctx) => (ctx.model === "adv" ? { status: 429, body: "Too many requests: rate limit exceeded" } : { text: "No findings." })
    const s = await env.newSession("retry429")
    await env.run(s.id, "hello")
    const t0 = Date.now()
    await waitFor(() => env.reviewStarts().some((r) => r.model === "alt"), { timeout: 40000, label: "review on the fallback model" }).catch(() => {})
    check("the review reached the fallback model", env.reviewStarts().some((r) => r.model === "alt"), env.reviewStarts().map((r) => r.model))
    check("quickly, not after reviewTimeoutMs", Date.now() - t0 < 30000, Date.now() - t0)
    await env.settle(1500)
    check("status marks the fallback model", /mock\/alt \(fallback\)/.test(await env.command(s.id, "status")))
  } finally {
    await env.stop()
  }
})

await scenario("failure: a broken advisor model fails closed, never hurts the primary, and recovers on reset", async (check) => {
  const env = await makeEnvV2({ advisor: { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 30000, maxConsecutiveFailures: 1 } })
  try {
    let broken = true
    env.st.advisorPlan = () => (broken ? { status: 401, body: "bad key" } : { text: "No findings." })
    const s = await env.newSession("fail")
    for (const t of ["one", "two"]) {
      await env.run(s.id, t)
      const a = (await env.transcript(s.id)).filter((m) => m.type === "assistant").at(-1)
      check(`primary turn "${t}" still answers`, /plain reply/.test(JSON.stringify(a)))
      await env.settle(5000, 40000)
    }
    const st = await env.command(s.id, "status")
    check("advisor halted with its error", /halted/.test(st) && /last error/.test(st), st)
    const starts = env.reviewStarts().length
    await env.run(s.id, "three")
    await env.settle(3000)
    check("a halted advisor stops spending requests", env.reviewStarts().length === starts, [starts, env.reviewStarts().length])
    broken = false
    await env.command(s.id, "reset")
    await env.run(s.id, "four")
    await env.settle()
    check("reset brings it back", env.reviewStarts().length > starts && !/halted/.test(await env.command(s.id, "status")))
  } finally {
    await env.stop()
  }
})

await scenario("abort: a blocker landing after the user interrupted is a card, not a wake", async (check) => {
  const env = await makeEnvV2()
  try {
    env.st.mainDelay = 800
    let sent = false
    env.st.advisorPlan = (ctx, upd) => {
      if (!sent && /ABORT_ME/.test(upd)) {
        sent = true
        return { delayMs: 2500, toolCalls: [adviseCall("ABORT_NOTE: wrong directory.", "blocker")] }
      }
      return { text: "No findings." }
    }
    const s = await env.newSession("abort")
    await env.c.session.prompt({ sessionID: s.id, text: "RUN_STEPS:6 ABORT_ME" })
    await waitFor(() => env.reviewStarts().length >= 1, { timeout: 20000, label: "first review" })
    await env.c.session.interrupt({ sessionID: s.id, continue: false })
    const after = env.mainReqs().length
    await env.settle(4000)
    check("the primary was not restarted", env.mainReqs().length <= after + 1, [after, env.mainReqs().length])
    const inbox = await env.c.session.inbox.list({ sessionID: s.id })
    const ctxMsgs = await env.transcript(s.id)
    check("the blocker is kept as a visible card", [...inbox.map((m) => JSON.stringify(m.payload)), ...ctxMsgs.map((m) => JSON.stringify(m))].some((t) => /ABORT_NOTE/.test(t)))
    check("status says auto-resume is suppressed", /suppressed/.test(await env.command(s.id, "status")))
    await env.run(s.id, "a real message re-arms")
    check("a real message works again", true)
  } finally {
    await env.stop()
  }
})

await scenario("syncBacklog: strict holds the primary's next LLM call until the advisor has caught up; /advisor is never held", async (check) => {
  const env = await makeEnvV2({ advisor: { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 30000, syncBacklog: "strict" } })
  try {
    env.st.mainDelay = 100
    env.st.advisorPlan = () => ({ delayMs: 2000, text: "No findings." })
    const s = await env.newSession("sync")
    const run = env.run(s.id, "RUN_STEPS:2 go")
    await waitFor(() => env.reviewStarts().length >= 1, { timeout: 20000, label: "first review" })
    const t0 = Date.now()
    const status = await env.command(s.id, "status")
    check("status answers while the strict wait is active", /Advisor/.test(status) && Date.now() - t0 < 1500, Date.now() - t0)
    await run
    await env.settle(3000)
    const main = env.mainReqs()
    const adv = env.reviewStarts()
    check("the second primary request started only after the first review finished", main.length >= 2 && adv.length >= 1 && main[1].t - adv[0].t >= 1800, main.map((m) => m.t - adv[0]?.t))
  } finally {
    await env.stop()
  }
})

await scenario("compaction: compacting the primary resets the advisor (a fresh advisor session)", async (check) => {
  const env = await makeEnvV2()
  try {
    const s = await env.newSession("compact")
    await env.run(s.id, "first")
    await env.settle()
    const before = (await env.children(s.id)).filter((k) => String(k.title).startsWith("[advisor]")).length
    await env.c.session.compact({ sessionID: s.id })
    await env.c.session.wait({ sessionID: s.id })
    await env.settle(2000)
    await env.run(s.id, "after compaction")
    await env.settle()
    const after = (await env.children(s.id)).filter((k) => String(k.title).startsWith("[advisor]")).length
    check("a new advisor session was opened after the compaction", after > before, [before, after])
    check("the advisor was told its context was reset", env.st.advisorCalls.some((u) => /context was reset/i.test(u)), env.st.advisorCalls.length)
  } finally {
    await env.stop()
  }
})

await scenario("projects: with the plugin loaded for two projects on one server, each session is reviewed once", async (check) => {
  const dist = fs.readFileSync(DIST, "utf8")
  const env = await makeEnvV2({ withPlugin: false, globalFiles: { "plugins/advisor.js": dist }, advisor: { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 30000 } })
  try {
    const B = env.oc.addProject("projB", { advisorConfig: toWatchdog({ model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 30000 }) })
    const a = await env.newSession("A")
    await env.run(a.id, "from project A")
    await env.settle(2500)
    check("a prompt in project A produced exactly one review", env.reviewStarts().length === 1, env.reviewStarts().length)
    const bs = await B.client.session.create({ title: "B" })
    await B.client.session.prompt({ sessionID: bs.id, text: "from project B" })
    await B.client.session.wait({ sessionID: bs.id })
    await env.settle(2500)
    check("a prompt in project B added exactly one more", env.reviewStarts().length === 2, env.reviewStarts().length)
  } finally {
    await env.stop()
  }
})

process.exitCode = R.summary() ? 1 : 0
process.exit(process.exitCode)
