import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { configSignature, loadConfig } from "../../src/config.ts"
import { applyConfig } from "../../src/reload.ts"

function project(yml: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adv-reload-"))
  const proj = path.join(home, "p")
  fs.mkdirSync(path.join(proj, ".opencode"), { recursive: true })
  const file = path.join(proj, ".opencode/WATCHDOG.yml")
  fs.writeFileSync(file, yml)
  const opts = { directory: proj, home, env: { XDG_CONFIG_HOME: path.join(home, "xdg") } }
  return { opts, file }
}

test("reload: the signature changes when a watched file is edited or appears, and not otherwise", () => {
  const { opts, file } = project("advisors:\n  - {name: A}\n")
  const a = configSignature(opts)
  assert.equal(configSignature(opts), a)
  fs.writeFileSync(file, "advisors:\n  - {name: A, reviewInterval: 2}\n")
  assert.notEqual(configSignature(opts), a)
  const b = configSignature(opts)
  fs.writeFileSync(path.join(path.dirname(file), "WATCHDOG.md"), "watch this")
  assert.notEqual(configSignature(opts), b)
})

test("reload: settings and roster fields are updated in place, so runtimes holding the objects see them", () => {
  const { opts, file } = project("modelRoles: {advisor: a/b}\nadvisor: {immuneTurns: 3}\nretry: {maxDelayMs: 1000}\nadvisors:\n  - {name: A}\n  - {name: B}\n")
  const cfg = loadConfig(opts)
  const specs = cfg.advisors
  const a = specs.find((s) => s.slug === "a")!
  const retryObj = cfg.retry
  fs.writeFileSync(file, "modelRoles: {advisor: a/b}\nadvisor: {immuneTurns: 1}\nretry: {maxDelayMs: 5}\nadvisors:\n  - {name: A, reviewInterval: 4, model: c/d, syncBacklog: strict}\n  - {name: C}\n")
  const r = applyConfig(cfg, specs, loadConfig(opts))
  assert.equal(cfg.immuneTurns, 1)
  assert.equal(retryObj.maxDelayMs, 5, "the retry object itself was updated")
  assert.equal(cfg.retry, retryObj)
  assert.equal(specs.find((s) => s.slug === "a"), a, "the same spec object")
  assert.deepEqual([a.reviewInterval, a.model, a.syncBacklog], [4, "c/d", "strict"])
  assert.deepEqual(r.added.map((s) => s.name), ["C"])
  assert.deepEqual(r.remodeled.map((s) => s.name), ["A"])
  const b = specs.find((s) => s.slug === "b")!
  assert.equal(b.enabled, false, "an entry removed from the file is stopped")
  assert.deepEqual(r.toggled.map((s) => s.name), ["B"])
  assert.equal(r.agentsStale, false, "cadence, model and entries do not need the agent definitions rebuilt")
})

test("reload: a change to tools, instructions or WATCHDOG.md is reported as needing the agent definitions", () => {
  const { opts, file } = project("advisors:\n  - {name: A}\n")
  const cfg = loadConfig(opts)
  fs.writeFileSync(file, "advisors:\n  - {name: A, tools: [read], instructions: be strict}\n")
  const r = applyConfig(cfg, cfg.advisors, loadConfig(opts))
  assert.equal(r.agentsStale, true)
  assert.match(r.result.restart.join(), /A: tools or instructions/)
  fs.writeFileSync(path.join(path.dirname(file), "WATCHDOG.md"), "new guidance")
  const r2 = applyConfig(cfg, cfg.advisors, loadConfig(opts))
  assert.equal(r2.agentsStale, true)
  assert.match(r2.result.restart.join(), /WATCHDOG\.md/)
})
