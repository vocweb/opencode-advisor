// E2E harness for opencode 2.x: real `opencode serve` in an isolated sandbox + the typed @opencode/client.
// Reuses the scripted mock LLM (`startMock`) from harness.mjs.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { stringify as yamlStringify } from "yaml"
import { OPENCODE_BIN, sleep, waitFor } from "./harness.mjs"

export { startMock, waitFor, sleep } from "./harness.mjs"

function modelEntry(name) {
  return { name, tool_call: true, reasoning: false, attachment: false, limit: { context: 200000, output: 8000 } }
}

/** Writes opencode.json, plugins, WATCHDOG.yml and extra files of one project directory. */
function writeProject(project, { mockPort, pluginFiles = {}, projectFiles = {}, advisorConfig, extraConfig = {} }) {
  fs.mkdirSync(project, { recursive: true })
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    model: "mock/main",
    small_model: "mock/main",
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "x" },
        models: { main: modelEntry("Main"), adv: modelEntry("Adv"), alt: modelEntry("Alt") },
      },
    },
    ...extraConfig,
  }
  fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify(cfg, null, 2))
  const put = (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  for (const [rel, c] of Object.entries(projectFiles)) put(path.join(project, rel), c)
  for (const [rel, c] of Object.entries(pluginFiles)) put(path.join(project, ".opencode/plugins", rel), c)
  if (advisorConfig) put(path.join(project, ".opencode/WATCHDOG.yml"), yamlStringify(advisorConfig))
}

/**
 * Starts `opencode serve` (v2) in an isolated sandbox.
 * Returns { client, http, url, password, dir, root, logs, forDirectory, addProject, stop }.
 */
export async function startOpencodeV2({ mockPort, pluginFiles = {}, projectFiles = {}, advisorConfig, extraConfig = {}, globalFiles = {}, root: reuseRoot }) {
  // macOS tmpdir is a symlink (/var -> /private/var); opencode compares real paths.
  const root = reuseRoot ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc2-e2e-")))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  const xdg = { config: path.join(home, ".config"), data: path.join(home, ".local/share"), cache: path.join(home, ".cache"), state: path.join(home, ".local/state") }
  for (const d of [home, ...Object.values(xdg)]) fs.mkdirSync(d, { recursive: true })
  const projOpts = { mockPort, pluginFiles, projectFiles, advisorConfig, extraConfig }
  writeProject(project, projOpts)
  for (const [rel, content] of Object.entries(globalFiles)) {
    const p = path.join(xdg.config, "opencode", rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  const logs = []
  const child = spawn(OPENCODE_BIN, ["serve", "--port", "0", "--print-logs"], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdg.config,
      XDG_DATA_HOME: xdg.data,
      XDG_CACHE_HOME: xdg.cache,
      XDG_STATE_HOME: xdg.state,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let url = null
  let password = null
  const onData = (d) => {
    const s = d.toString()
    logs.push(s)
    const m = s.match(/listening on (http:\/\/[^\s]+)/i)
    if (m && !url) url = m[1]
    const p = s.match(/server password (\S+)/i)
    if (p && !password) password = p[1]
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  try {
    await waitFor(() => url && password, { timeout: 60000, label: "opencode v2 server url+password" })
  } catch (e) {
    child.kill("SIGKILL")
    throw new Error(e.message + "\n" + logs.join(""))
  }

  const authHeader = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
  /** client + raw http helper bound to one project directory */
  const forDirectory = (directory) => {
    const headers = { authorization: authHeader, "x-opencode-directory": directory }
    return {
      dir: directory,
      headers,
      client: OpenCode.make({ baseUrl: url, headers }),
      http: (p, init = {}) => fetch(url + p, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }),
    }
  }
  const main = forDirectory(project)
  let stopped = false
  return {
    ...main,
    url,
    password,
    root,
    logs,
    forDirectory,
    /** Creates another project dir under the same sandbox/server; returns its bound { dir, client, http }. */
    addProject: (name, opts = {}) => {
      const dir = path.join(root, name)
      writeProject(dir, { ...projOpts, pluginFiles: {}, projectFiles: {}, advisorConfig: undefined, ...opts })
      return forDirectory(dir)
    },
    stop: async () => {
      if (stopped) return
      stopped = true
      child.kill("SIGTERM")
      await sleep(300)
      child.kill("SIGKILL")
      if (!reuseRoot && !process.env.KEEP_E2E_ROOT) fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Collect v2 events (all directories) into an array of { t, ...event }; `stop()` ends the subscription. */
export function collectEventsV2(client) {
  const events = []
  const ac = new AbortController()
  const done = (async () => {
    try {
      for await (const e of client.event.subscribe({ signal: ac.signal })) events.push({ t: Date.now(), ...e })
    } catch {}
  })()
  events.stop = async () => {
    ac.abort()
    await done
  }
  return events
}
