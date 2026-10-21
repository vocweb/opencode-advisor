// Smoke test of the v2 harness; independent of the advisor plugin (uses an inline probe plugin).
import fs from "node:fs"
import path from "node:path"
import { makeEnvV2, createRunner } from "./lib-v2.mjs"

const t = createRunner()

const PROBE = `export default {
  id: "probe",
  async setup(ctx) {
    const fs = await import("node:fs")
    fs.writeFileSync(ctx.directory ? ctx.directory + "/probe.marker" : process.cwd() + "/probe.marker", "setup ran")
    return {}
  },
}
`

let env
try {
  env = await makeEnvV2({ advisor: null, pluginFiles: { "probe.js": PROBE } })
  const sid = (await env.newSession("smoke")).id

  await t.scenario("harness starts v2 and a plain prompt gets the mock reply", async (ok) => {
    await env.run(sid, "hello there")
    const msgs = await env.transcript(sid)
    const a = msgs.filter((m) => m.type === "assistant")
    const text = JSON.stringify(a)
    ok("an assistant message exists", a.length > 0, msgs.map((m) => m.type))
    ok("reply contains mock text", text.includes("plain reply"), text.slice(0, 400))
    ok("mock saw a main request", env.mainReqs().length > 0)
  })

  await t.scenario("inline probe plugin loaded and setup ran", async (ok) => {
    const marker = path.join(env.oc.dir, "probe.marker")
    ok("marker written", fs.existsSync(marker), env.oc.logs.join("").slice(-800))
  })

  await t.scenario("collectEventsV2 receives session.* events", async (ok) => {
    await env.run(sid, "again")
    await new Promise((r) => setTimeout(r, 300))
    const types = [...new Set(env.events.map((e) => e.type))]
    ok("got session.* events", types.some((x) => String(x).startsWith("session.")), types)
  })
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  if (env) await env.stop()
}
const failed = t.summary()
process.exit(failed || process.exitCode ? 1 : 0)
