import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_TOOLS, loadConfig } from "../../src/config.ts"
import { createTemplate, setAdvisorEnabled, setModelRole } from "../../src/yamlio.ts"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "adv-yaml-"))
function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
function load(home: string, proj: string, env: NodeJS.ProcessEnv = {}) {
  return loadConfig({ directory: proj, home, env: { XDG_CONFIG_HOME: path.join(home, "xdg"), ...env } })
}

test("config: no files -> one dormant default advisor with omp defaults", () => {
  const home = tmp()
  const c = load(home, path.join(home, "p"))
  assert.equal(c.advisors.length, 1)
  const a = c.advisors[0]!
  assert.equal(a.model, undefined)
  assert.deepEqual([a.reviewMode, a.reviewInterval, a.syncBacklog], ["turn", 1, "off"])
  assert.deepEqual(a.tools, DEFAULT_TOOLS)
  assert.equal(c.continueSeverity, "concern")
  assert.equal(c.retry.fallbackOn, "any")
})

test("config: the real-world roster parses (paused entry, tool subset, escaped multi-line instructions)", () => {
  const home = tmp()
  const proj = path.join(home, "p")
  write(path.join(proj, ".opencode/WATCHDOG.yml"), fs.readFileSync(new URL("../fixtures/user-example.yml", import.meta.url), "utf8"))
  const c = load(home, proj)
  assert.deepEqual(c.warnings, [])
  assert.equal(c.advisors.length, 5)
  assert.equal(c.advisors.find((a) => a.name === "PlanFidelity")!.enabled, false)
  assert.deepEqual(c.advisors.find((a) => a.name === "SecurityWatch")!.tools, ["read", "grep"])
  const laravel = c.advisors.find((a) => a.name === "BackendRules")!
  assert.ok(laravel.instructions.includes("\n"))
  assert.ok(laravel.instructions.includes("RULE-10.00.2"))
})

test("config: layering - project beats user, same slug merges, .yml is read before .yaml, instructions concatenate in read order", () => {
  const home = tmp()
  const xdg = path.join(home, "xdg/opencode")
  const proj = path.join(home, "p")
  write(path.join(xdg, "WATCHDOG.yml"), `instructions: G\nmodelRoles: {advisor: a/b}\nadvisors:\n  - {name: Sec, instructions: S1}\n  - {name: Keep}\n`)
  write(path.join(proj, "WATCHDOG.yml"), `instructions: P1\nadvisors:\n  - {name: sec, model: c/d}\n`)
  write(path.join(proj, "WATCHDOG.yaml"), `instructions: P2\n`)
  write(path.join(proj, ".opencode/WATCHDOG.yml"), `instructions: P3\nadvisors:\n  - {name: SEC, reviewInterval: 3}\n`)
  const c = load(home, proj)
  assert.deepEqual(c.advisors.map((a) => a.slug), ["sec", "keep"])
  const sec = c.advisors[0]!
  assert.equal(sec.model, "c/d")
  assert.equal(sec.instructions, "S1", "fields a nearer entry does not set survive")
  assert.equal(sec.reviewInterval, 3)
  assert.equal(c.advisors[1]!.model, "a/b", "modelRoles.advisor is the fallback model")
  assert.deepEqual(c.instructions.split("\n\n"), ["G", "P1", "P2", "P3"])
})

test("config: a broken entry only costs that entry; invalid values name the entry", () => {
  const home = tmp()
  const proj = path.join(home, "p")
  write(
    path.join(proj, "WATCHDOG.yml"),
    [
      "advisors:",
      "  - name: Bad",
      "    reviewInterval: 0",
      "    reviewMode: sometimes",
      "    syncBacklog: 2",
      "    tools: [recall, eval]",
      "  - name: Mixed",
      "    tools: [search, find, write, ast_edit, debug]",
      "  - name: Silent",
      "    tools: []",
      "  - {nope: 1}",
      "",
    ].join("\n"),
  )
  const c = load(home, proj)
  const by = (n: string) => c.advisors.find((a) => a.name === n)!
  assert.equal(by("Bad").reviewInterval, 1)
  assert.equal(by("Bad").reviewMode, "turn")
  assert.deepEqual(by("Bad").tools, DEFAULT_TOOLS, "no valid tool left -> defaults (as omp)")
  assert.deepEqual(by("Mixed").tools, ["grep", "glob", "edit"])
  assert.deepEqual(by("Silent").tools, [])
  for (const field of ["reviewInterval", "reviewMode", "syncBacklog"]) {
    assert.ok(c.warnings.some((w) => w.includes("advisors[Bad]") && w.includes(field)), field)
  }
  assert.ok(c.warnings.some((w) => w.includes('tool "debug" is not available')))
  assert.ok(c.warnings.some((w) => /no "name"/.test(w)))
})

test("config: invalid YAML and non-mapping roots are skipped with a warning", () => {
  const home = tmp()
  const proj = path.join(home, "p")
  write(path.join(proj, "WATCHDOG.yml"), "a: [unclosed\n")
  write(path.join(proj, "WATCHDOG.yaml"), "- just\n- a list\n")
  const c = load(home, proj)
  assert.ok(c.warnings.some((w) => /invalid YAML/.test(w) && /skipped/.test(w)))
  assert.ok(c.warnings.some((w) => /expected a mapping/.test(w)))
  assert.equal(c.advisors.length, 1)
})

test("config: precedence of maxNotesPerUpdate; omp-only keys are ignored with a warning", () => {
  const home = tmp()
  const proj = path.join(home, "p")
  write(
    path.join(proj, "WATCHDOG.yml"),
    "maxNotesPerUpdate: 7\nadvisor: {maxNotesPerUpdate: 2, mystery: 1}\nretry: {usageAwareFallback: true, maxDelayMs: 5}\ntier: {advisor: fast}\nadvisors:\n  - {name: A}\n  - {name: B, maxNotesPerUpdate: 9}\n",
  )
  const c = load(home, proj)
  assert.equal(c.advisors.find((a) => a.name === "A")!.maxNotesPerUpdate, 7)
  assert.equal(c.advisors.find((a) => a.name === "B")!.maxNotesPerUpdate, 9)
  assert.equal(c.retry.maxDelayMs, 5)
  assert.ok(c.warnings.some((w) => w.includes('"retry.usageAwareFallback" is not supported by opencode-advisor; ignored')))
  assert.ok(c.warnings.some((w) => w.includes('"tier.advisor" is not supported')))
  assert.ok(c.warnings.some((w) => w.includes('unknown key "advisor.mystery"')))
})

test("config: roster entries do not inherit the default advisor's cadence but do inherit syncBacklog", () => {
  const home = tmp()
  const proj = path.join(home, "p")
  write(path.join(proj, "WATCHDOG.yml"), "advisor: {reviewMode: agent-end, reviewInterval: 4, syncBacklog: strict}\nadvisors:\n  - {name: A}\n")
  const a = load(home, proj).advisors[0]!
  assert.deepEqual([a.reviewMode, a.reviewInterval, a.syncBacklog], ["turn", 1, "strict"])
  const d = tmp()
  write(path.join(d, "p/WATCHDOG.yml"), "advisor: {reviewMode: agent-end, reviewInterval: 4}\n")
  const def = load(d, path.join(d, "p")).advisors[0]!
  assert.deepEqual([def.reviewMode, def.reviewInterval], ["agent-end", 4])
})

test("config: task.agentAdvisor, OPENCODE_ADVISOR force on/off", () => {
  const home = tmp()
  const proj = path.join(home, "p")
  write(path.join(proj, "WATCHDOG.yml"), "advisor: {enabled: false}\ntask:\n  agentAdvisor: {task: on, explore: off, other: a/b}\n")
  assert.deepEqual(load(home, proj).agentAdvisor, { task: "on", explore: "off", other: "a/b" })
  assert.equal(load(home, proj).enabled, false)
  assert.equal(load(home, proj, { OPENCODE_ADVISOR: "1" }).enabled, true)
  assert.equal(load(home, proj, { OPENCODE_ADVISOR: "off" }).enabled, false)
})

// ------------------------------------------------------------------ yamlio
const COMMENTED = "# top comment\nmodelRoles:\n  advisor: old/model # keep me\nadvisors:\n  # roster note\n  - name: Sec # inline\n    enabled: true\n  - name: Style\n"

test("yamlio: setModelRole / setAdvisorEnabled keep comments and touch only their key", () => {
  const f = path.join(tmp(), "WATCHDOG.yml")
  fs.writeFileSync(f, COMMENTED)
  assert.ok(setModelRole(f, "new/model").ok)
  let text = fs.readFileSync(f, "utf8")
  assert.equal(text, COMMENTED.replace("old/model", "new/model"))
  assert.ok(setAdvisorEnabled(f, "sec", false).ok)
  text = fs.readFileSync(f, "utf8")
  assert.equal(text, COMMENTED.replace("old/model", "new/model").replace("enabled: true", "enabled: false"))
  assert.ok(setAdvisorEnabled(f, "Style", false).ok)
  assert.match(fs.readFileSync(f, "utf8"), /name: Style\n\s+enabled: false/)
})

test("yamlio: unknown advisor / unparsable file are reported without touching the file; model role creates the file", () => {
  const dir = tmp()
  const f = path.join(dir, "WATCHDOG.yml")
  fs.writeFileSync(f, COMMENTED)
  const missing = setAdvisorEnabled(f, "Nope", true)
  assert.equal(missing.ok, false)
  assert.equal(fs.readFileSync(f, "utf8"), COMMENTED)
  const bad = path.join(dir, "bad.yml")
  fs.writeFileSync(bad, "a: [unclosed\n")
  assert.equal(setModelRole(bad, "x/y").ok, false)
  assert.equal(fs.readFileSync(bad, "utf8"), "a: [unclosed\n")
  const fresh = path.join(dir, "nested/WATCHDOG.yml")
  assert.ok(setModelRole(fresh, "x/y").ok)
  assert.match(fs.readFileSync(fresh, "utf8"), /advisor: x\/y/)
})

test("yamlio: createTemplate never overwrites, and its output loads without warnings", () => {
  const home = tmp()
  const f = path.join(home, "p/WATCHDOG.yml")
  assert.ok(createTemplate(f).ok)
  assert.equal(createTemplate(f).ok, false)
  const c = load(home, path.join(home, "p"))
  assert.deepEqual(c.warnings, [])
  assert.deepEqual(c.advisors.map((a) => [a.name, a.enabled]), [["Security", true], ["Style", false]])
})

test("yamlio: editing one key does not re-wrap long scalars elsewhere in the file", () => {
  const f = path.join(tmp(), "WATCHDOG.yml")
  const src = fs.readFileSync(new URL("../fixtures/user-example.yml", import.meta.url), "utf8")
  fs.writeFileSync(f, src)
  assert.ok(setAdvisorEnabled(f, "PlanFidelity", true).ok)
  const out = fs.readFileSync(f, "utf8")
  assert.equal(out.split("\n").length, src.split("\n").length, "no scalar was folded onto extra lines")
})

test("util: a prototype key is not a thinking level", async () => {
  const { parseModelSelector } = await import("../../src/util.ts")
  assert.deepEqual(parseModelSelector("p/m:constructor"), { ref: { providerID: "p", modelID: "m:constructor" } })
})

test("config: the published docs/example/WATCHDOG.yml loads cleanly with its documented shape", () => {
  const home = tmp()
  const proj = path.join(home, "p")
  write(path.join(proj, ".opencode/WATCHDOG.yml"), fs.readFileSync(new URL("../../docs/example/WATCHDOG.yml", import.meta.url), "utf8"))
  const c = load(home, proj)
  assert.deepEqual(c.warnings, [])
  assert.deepEqual(c.advisors.map((a) => a.name), ["PlanFidelity", "SecurityWatch", "LaravelBECheck", "NuxtFECheck", "PlanClarifier"])
  assert.equal(c.advisors[0]!.enabled, false)
  assert.deepEqual(c.advisors[1]!.tools, ["read", "grep"])
  assert.ok(c.advisors[4]!.instructions.includes("CẦN LÀM RÕ"), "the trigger phrase the DEV writes must stay verbatim")
})

test("config: @imports from a project file stay inside the project and skip secret files; the user's own global file may import from ~", () => {
  const home = tmp()
  const proj = path.join(home, "p")
  write(path.join(home, "outside.md"), "OUTSIDE_SECRET")
  write(path.join(home, ".aws/credentials"), "AWS_SECRET")
  write(path.join(proj, "ok.md"), "INSIDE_OK")
  write(path.join(proj, ".env.local"), "ENV_SECRET")
  fs.symlinkSync(path.join(home, "outside.md"), path.join(proj, "link.md"))
  write(path.join(proj, "WATCHDOG.md"), "A @./ok.md\nB @../outside.md\nC @~/.aws/credentials\nD @./.env.local\nE @./link.md\n")
  write(path.join(home, "xdg/opencode/WATCHDOG.md"), "G @~/outside.md\n")
  const c = load(home, proj)
  assert.match(c.watchdog, /INSIDE_OK/)
  assert.match(c.watchdog, /G OUTSIDE_SECRET/, "the global file is the user's own and may reach into ~")
  assert.doesNotMatch(c.watchdog, /B OUTSIDE_SECRET/, "a project file cannot climb out of the project")
  assert.doesNotMatch(c.watchdog, /AWS_SECRET/, "a project file cannot import from ~")
  assert.doesNotMatch(c.watchdog, /ENV_SECRET/, "secret files are never imported")
  assert.doesNotMatch(c.watchdog, /E OUTSIDE_SECRET/, "a symlink inside the project cannot smuggle an outside file in")
})

test("yamlio: writes refuse to follow a symlink and never leave a predictable temp file behind", () => {
  const dir = tmp()
  const victim = path.join(dir, "victim.txt")
  write(victim, "KEEP")
  const file = path.join(dir, "WATCHDOG.yml")
  fs.symlinkSync(victim, file)
  fs.symlinkSync(victim, `${file}.tmp`)
  const r = setModelRole(file, "a/b")
  assert.equal(r.ok, false)
  assert.equal(fs.readFileSync(victim, "utf8"), "KEEP", "the symlink target is untouched")
  fs.rmSync(file)
  assert.equal(setModelRole(file, "a/b").ok, true)
  assert.equal(fs.readFileSync(victim, "utf8"), "KEEP", "a pre-planted <file>.tmp symlink is not followed either")
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp") && f !== "WATCHDOG.yml.tmp"), [], "no stray temp file")
})
