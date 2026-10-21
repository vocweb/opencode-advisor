// Installs the packed npm tarball on opencode 2.x through opencode.json "plugins" (the v2 key) and checks it works.
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRunner, makeEnvV2 } from "./lib-v2.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, "../..")
const out = execFileSync("npm", ["pack", "--silent", "--pack-destination", "/tmp"], { cwd: pkgDir, encoding: "utf8" }).trim().split("\n").pop()
const tgz = path.join("/tmp", out)
const R = createRunner()

await R.scenario(`pack (v2): ${out} installed via opencode.json "plugins" works end to end`, async (check) => {
  const env = await makeEnvV2({ pluginFiles: {}, advisor: { model: "mock/adv", immuneTurns: 0, reviewTimeoutMs: 30000 }, extraConfig: { plugins: [`@vocweb/opencode-advisor@file:${tgz}`] } })
  try {
    env.st.advisorPlan = () => ({ text: "No findings." })
    const s = await env.newSession("pack")
    await env.run(s.id, "hello")
    await env.settle()
    check("the advisor reviewed the turn", env.reviewStarts().length === 1, env.reviewStarts().length)
    check("primary does not see the advise tool", env.mainReqs().every((r) => !r.tools.includes("advise")))
    check("/advisor works", /\*\*on\*\*/.test(await env.command(s.id, "status")))
  } finally {
    await env.stop()
  }
})
process.exitCode = R.summary() ? 1 : 0
process.exit(process.exitCode)
