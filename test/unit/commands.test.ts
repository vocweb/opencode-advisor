import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { control, type CommandCtx } from "../../src/commands.ts"
import { loadConfig, type AdvisorSpec } from "../../src/config.ts"
import { Delivery } from "../../src/delivery.ts"
import { Registry } from "../../src/registry.ts"
import type { AdvisorRuntime } from "../../src/runtime.ts"
import type { Host } from "../../src/host.ts"

const COMMENTED = "# mine\nmodelRoles:\n  advisor: a/b\nadvisors:\n  - name: Sec # keep\n  - name: Style\n    enabled: false\n"

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adv-cmd-"))
  const project = path.join(home, "p")
  const gdir = path.join(home, "xdg/opencode")
  fs.mkdirSync(path.join(project, ".opencode"), { recursive: true })
  fs.writeFileSync(path.join(project, ".opencode/WATCHDOG.yml"), COMMENTED)
  const env = { XDG_CONFIG_HOME: path.join(home, "xdg") }
  const cfg = loadConfig({ directory: project, home, env })
  const applied: string[] = []
  const host = { kind: "v1", log: () => {}, advisorChildren: async () => [], transcript: async () => [] } as unknown as Host
  const ctx: CommandCtx = {
    cfg,
    specs: cfg.advisors,
    host,
    registry: new Registry(),
    delivery: new Delivery(host, cfg),
    runtimes: new Map<string, AdvisorRuntime[]>(),
    disabledSessions: new Set(),
    directory: project,
    worktree: undefined,
    env,
    runtimesFor: () => [],
    disposeSession: () => {},
    applyEnabled: (s: AdvisorSpec) => void applied.push(`${s.slug}:${s.enabled}`),
  }
  return { ctx, project, gdir, applied }
}

test("commands: a bare /advisor toggles this session only", async () => {
  const { ctx } = setup()
  assert.match(await control(ctx, "s1", ""), /off for this session/)
  assert.ok(ctx.disabledSessions.has("s1") && !ctx.disabledSessions.has("s2"))
  assert.match(await control(ctx, "s1", ""), /on for this session/)
  assert.equal(ctx.disabledSessions.size, 0)
})

test("commands: disable/enable edit the winning file, keep its comments and apply live", async () => {
  const { ctx, project, applied } = setup()
  const file = path.join(project, ".opencode/WATCHDOG.yml")
  assert.match(await control(ctx, "s", "disable sec"), /disabled/)
  assert.equal(fs.readFileSync(file, "utf8"), COMMENTED.replace("- name: Sec # keep\n", "- name: Sec # keep\n    enabled: false\n"))
  assert.equal(ctx.specs.find((s) => s.slug === "sec")!.enabled, false)
  assert.match(await control(ctx, "s", "enable Style"), /enabled/)
  assert.match(fs.readFileSync(file, "utf8"), /name: Style\n\s+enabled: true/)
  assert.deepEqual(applied, ["sec:false", "style:true"])
  assert.match(await control(ctx, "s", "enable nope"), /No advisor named "nope"/)
})

test("commands: configure init creates the sample once, never overwrites", async () => {
  const { ctx, project } = setup()
  fs.rmSync(path.join(project, ".opencode"), { recursive: true })
  assert.match(await control(ctx, "s", "configure init"), /Created/)
  const created = path.join(project, "WATCHDOG.yml")
  assert.ok(fs.existsSync(created))
  fs.writeFileSync(created, "# edited\n")
  assert.match(await control(ctx, "s", "configure init"), /already exists/)
  assert.equal(fs.readFileSync(created, "utf8"), "# edited\n")
  const report = await control(ctx, "s", "configure")
  assert.match(report, /Project:.*WATCHDOG\.yml.*exists/)
})

test("commands: setup writes modelRoles.advisor to the user file, validates the selector, updates inheriting entries", async () => {
  const { ctx, gdir } = setup()
  assert.match(await control(ctx, "s", "setup nonsense"), /Setup failed/)
  assert.match(await control(ctx, "s", "setup c/d"), /c\/d/)
  assert.match(fs.readFileSync(path.join(gdir, "WATCHDOG.yml"), "utf8"), /advisor: c\/d/)
  assert.deepEqual(ctx.specs.map((s) => s.model), ["c/d", "c/d"], "entries that inherited the default follow the new one")
})

test("commands: status lists every roster entry, a disabled one as paused", async () => {
  const { ctx } = setup()
  const out = await control(ctx, "s", "status")
  assert.match(out, /\| Sec \| idle \| a\/b \|/)
  assert.match(out, /\| Style \| paused \|/)
})
