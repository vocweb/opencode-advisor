import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "../../src/config.ts"
import { Delivery } from "../../src/delivery.ts"
import type { Host } from "../../src/host.ts"
import type { Note } from "../../src/types.ts"

const note = (severity: Note["severity"]): Note => ({ id: 1, advisor: "a", severity, text: "do the thing", turn: 0, at: Date.now() }) as unknown as Note

function make() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adv-del-"))
  const cfg = loadConfig({ directory: path.join(home, "p"), home, env: { XDG_CONFIG_HOME: path.join(home, "xdg") } })
  const delivered: string[] = []
  const host = {
    log: () => {},
    activeAgent: async () => undefined,
    deliver: async (_p: string, notes: Note[], kind: string) => void delivered.push(`${kind}:${notes.length}`),
    toast: () => {},
  } as unknown as Host
  return { d: new Delivery(host, cfg), delivered }
}

test("delivery.clear: notes queued for a session are dropped, so nothing stale arrives after /advisor off or a compaction", async () => {
  const { d, delivered } = make()
  d.setBusy("s1", true)
  d.submit("s1", [note("blocker")], { final: false })
  d.clear("s1")
  await d.drain()
  assert.deepEqual(delivered, [], "the queued blocker was never delivered")
})

test("delivery.clear: without it the same queued blocker is delivered (so the test above is meaningful)", async () => {
  const { d, delivered } = make()
  d.setBusy("s1", true)
  d.submit("s1", [note("blocker")], { final: false })
  await d.drain()
  assert.equal(delivered.length, 1)
})

test("delivery.clear: only the named session is cleared", async () => {
  const { d, delivered } = make()
  d.setBusy("s1", true)
  d.setBusy("s2", true)
  d.submit("s1", [note("blocker")], { final: false })
  d.submit("s2", [note("blocker")], { final: false })
  d.clear("s1")
  await d.drain()
  assert.equal(delivered.length, 1)
})
