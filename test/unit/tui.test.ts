import { test } from "node:test"
import assert from "node:assert/strict"
import { parseEntries, setupTui, toastFor, type ToastSpec, type TuiLike } from "../../src/tui-logic.ts"

const advisory = (severity: string, count = 1) => ({
  type: "synthetic",
  payload: { text: `<advisory severity="${severity}" guidance="x">\nThe migration drops the table.\n</advisory>`, metadata: { opencodeAdvisor: true, severity, count } },
})

test("toastFor: an advisory becomes a toast sized by severity; a notice shows its description; everything else is ignored", () => {
  assert.deepEqual(toastFor("s1", advisory("blocker")), { title: "Advisor (blocker)", message: "The migration drops the table.", variant: "error", sessionID: "s1" })
  assert.equal(toastFor("s1", advisory("concern", 3))?.message, "The migration drops the table. (+2 more)")
  assert.equal(toastFor("s1", advisory("nit"))?.variant, "warning")
  const notice = { type: "synthetic", payload: { text: "[opencode-advisor] notice", description: "Advisor \"A\" halted", metadata: { opencodeAdvisor: "notice", variant: "error" } } }
  assert.deepEqual(toastFor("s1", notice), { title: "Advisor", message: 'Advisor "A" halted', variant: "error", sessionID: "s1" })
  assert.equal(toastFor("s1", { type: "synthetic", payload: { text: "hi", metadata: { opencodeAdvisor: "control" } } }), undefined, "the /advisor reply is not a toast")
  assert.equal(toastFor("s1", { type: "user", payload: { text: "hi" } }), undefined)
  assert.equal(toastFor("s1", { type: "synthetic", payload: { text: "plain" } }), undefined, "not ours")
})

test("parseEntries: reads the tab-separated list the server prints", () => {
  assert.deepEqual(parseEntries("Sec\tenabled\ta/b\tfile\nStyle\tdisabled\t-\tbuiltin"), [
    { name: "Sec", enabled: true, model: "a/b", editable: true },
    { name: "Style", enabled: false, model: "-", editable: false },
  ])
  assert.deepEqual(parseEntries(""), [])
})

function fake(script: { selects?: unknown[]; prompts?: (string | undefined)[]; route?: { type: string; sessionID?: string } }) {
  const toasts: ToastSpec[] = []
  const alerts: { title: string; message: string }[] = []
  const commands: string[] = []
  let handler: ((e: { data: { sessionID?: string; item?: unknown } }) => void) | undefined
  let command: { run: () => void | Promise<void>; slash?: { name: string } } | undefined
  const selects = [...(script.selects ?? [])]
  const prompts = [...(script.prompts ?? [])]
  const ctx: TuiLike = {
    options: {},
    ui: {
      toast: { show: (o) => void toasts.push(o) },
      dialog: {
        select: async () => selects.shift() as never,
        prompt: async () => prompts.shift(),
        alert: async (o) => void alerts.push(o),
      },
      router: { current: () => script.route ?? { type: "session", sessionID: "s1" } },
    },
    keymap: { layer: (f) => void (command = f().commands[0]) },
    data: { on: (_t, h) => ((handler = h as never), () => void (handler = undefined)) },
    command: async (_s, text) => {
      commands.push(text)
      return text === "entries" ? "Sec\tenabled\ta/b\tfile\nOld\tdisabled\t-\tfile" : `reply to ${text || "(toggle)"}`
    },
  }
  return { ctx, toasts, alerts, commands, emit: (e: unknown) => handler?.(e as never), run: () => command!.run(), registered: () => command }
}

test("tui: registers /advisor-config, shows toasts for advisories, and stops listening on cleanup", async () => {
  const f = fake({})
  const stop = setupTui(f.ctx)
  assert.equal(f.registered()?.slash?.name, "advisor-config")
  f.emit({ data: { sessionID: "s1", item: advisory("blocker") } })
  assert.equal(f.toasts.length, 1)
  stop()
  f.emit({ data: { sessionID: "s1", item: advisory("blocker") } })
  assert.equal(f.toasts.length, 1, "no toast after cleanup")
  const off = fake({})
  off.ctx.options = { toast: false }
  setupTui(off.ctx)
  off.emit({ data: { sessionID: "s1", item: advisory("blocker") } })
  assert.equal(off.toasts.length, 0, "toast: false in the plugin options silences them")
})

test("tui menu: status, enable/disable, set model and create-sample go through the server command and show the reply", async () => {
  let f = fake({ selects: ["status"] })
  setupTui(f.ctx)
  await f.run()
  assert.deepEqual(f.commands, ["status"])
  assert.deepEqual(f.alerts, [{ title: "Advisor status", message: "reply to status" }])

  f = fake({ selects: ["disable", { name: "Sec", enabled: true, model: "a/b", editable: true }] })
  setupTui(f.ctx)
  await f.run()
  assert.deepEqual(f.commands, ["entries", "disable Sec"], "only enabled, editable entries are offered to disable")

  f = fake({ selects: ["model", { name: "Sec", enabled: true, model: "a/b", editable: true }], prompts: [" anthropic/claude-haiku-4-5:low "] })
  setupTui(f.ctx)
  await f.run()
  assert.deepEqual(f.commands, ["entries", "model Sec anthropic/claude-haiku-4-5:low"])

  f = fake({ selects: ["init", "user"] })
  setupTui(f.ctx)
  await f.run()
  assert.deepEqual(f.commands, ["configure init user"])

  f = fake({ selects: ["setup"], prompts: [undefined] })
  setupTui(f.ctx)
  await f.run()
  assert.deepEqual(f.commands, [], "cancelling the prompt changes nothing")

  f = fake({ route: { type: "home" } })
  setupTui(f.ctx)
  await f.run()
  assert.deepEqual(f.commands, [])
  assert.match(f.alerts[0]!.message, /Open a session first/)
})
