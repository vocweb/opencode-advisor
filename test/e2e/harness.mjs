// E2E harness: a scripted OpenAI-compatible mock LLM + a real `opencode serve` process.
import http from "node:http"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { stringify as yamlStringify } from "yaml"

export const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode"

// v1 の harness を v2 の binary で動かすと 405 などで不可解に落ちるため、最初に版を確認して明確なエラーにする。
// Chạy harness v1 với binary v2 sẽ lỗi khó hiểu (405...), nên kiểm phiên bản trước và báo lỗi rõ ràng.
function assertV1Binary() {
  const binVersion = execFileSync(OPENCODE_BIN, ["--version"], { encoding: "utf8" }).trim()
  if (!/^(opencode )?v?1\./.test(binVersion)) throw new Error(`The v1 E2E suite needs an opencode 1.x binary (OPENCODE_BIN), got "${binVersion}". Use test:e2e:v2 for 2.x.`)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(fn, { timeout = 20000, interval = 100, label = "condition" } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`)
    await sleep(interval)
  }
}

/**
 * Mock LLM. `handler(ctx)` gets { n, model, system, messages, tools, body } and returns
 * { text?, toolCalls?: [{name, args}], delayMs? }. Every request is recorded in `requests`.
 */
export async function startMock(handler) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
      res.writeHead(404).end()
      return
    }
    let raw = ""
    for await (const c of req) raw += c
    const body = JSON.parse(raw)
    const system = body.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n")
    const tools = (body.tools || []).map((t) => t.function.name)
    const ctx = { n: requests.length, t: Date.now(), model: body.model, system, messages: body.messages, tools, body }
    requests.push(ctx)
    let out
    try {
      out = (await handler(ctx)) || { text: "ok" }
    } catch (e) {
      out = { text: "mock handler error: " + e.message }
    }
    if (out.delayMs) await sleep(out.delayMs)
    if (out.status) {
      res.writeHead(out.status, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: out.body || "mock error", type: "mock_error" } }))
      return
    }
    const id = "chatcmpl-" + ctx.n
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.write(chunk({ role: "assistant", content: "" }))
    if (out.reasoning) res.write(chunk({ reasoning_content: out.reasoning }))
    if (out.text) res.write(chunk({ content: out.text }))
    const calls = out.toolCalls || []
    calls.forEach((c, i) => {
      res.write(
        chunk({
          tool_calls: [
            { index: i, id: `call_${ctx.n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } },
          ],
        }),
      )
    })
    res.write(chunk({}, calls.length ? "tool_calls" : "stop"))
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: out.promptTokens ?? 100, completion_tokens: 20, total_tokens: (out.promptTokens ?? 100) + 20 } })}\n\n`,
    )
    res.write("data: [DONE]\n\n")
    res.end()
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  return { port, requests, close: () => new Promise((r) => server.close(r)) }
}

function modelEntry(name) {
  return { name, tool_call: true, reasoning: false, attachment: false, limit: { context: 200000, output: 8000 } }
}

/** Starts `opencode serve` in an isolated sandbox. Returns { client, dir, stop, logs }. */
export async function startOpencode({ mockPort, pluginFiles = {}, projectFiles = {}, advisorConfig, extraConfig = {}, globalFiles = {}, root: reuseRoot }) {
  // harness-v2 も本ファイルを import するため、版の確認は v1 の起動経路でのみ行う。
  // harness-v2 cũng import file này, nên chỉ kiểm phiên bản ở đường khởi động v1.
  assertV1Binary()
  // macOS tmpdir is a symlink (/var -> /private/var); opencode compares real paths for its external_directory rule.
  const root = reuseRoot ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-e2e-")))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  const xdg = { config: path.join(home, ".config"), data: path.join(home, ".local/share"), cache: path.join(home, ".cache"), state: path.join(home, ".local/state") }
  for (const d of [home, project, ...Object.values(xdg)]) fs.mkdirSync(d, { recursive: true })
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
  for (const [rel, content] of Object.entries(projectFiles)) {
    const p = path.join(project, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  for (const [rel, content] of Object.entries(pluginFiles)) {
    const p = path.join(project, ".opencode/plugins", rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  for (const [rel, content] of Object.entries(globalFiles)) {
    const p = path.join(xdg.config, "opencode", rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  if (advisorConfig) {
    fs.mkdirSync(path.join(project, ".opencode"), { recursive: true })
    fs.writeFileSync(path.join(project, ".opencode/WATCHDOG.yml"), yamlStringify(advisorConfig))
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
  const onData = (d) => {
    const s = d.toString()
    logs.push(s)
    const m = s.match(/listening on (http:\/\/[^\s]+)/i)
    if (m && !url) url = m[1]
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  await waitFor(() => url, { timeout: 60000, label: "opencode server url" })
  const client = createOpencodeClient({ baseUrl: url, directory: project })
  return {
    client,
    url,
    dir: project,
    root,
    logs,
    stop: async () => {
      child.kill("SIGTERM")
      await sleep(300)
      child.kill("SIGKILL")
    },
  }
}

/** Collect SSE events from the server into an array. */
export async function collectEvents(client) {
  const events = []
  const sub = await client.event.subscribe()
  ;(async () => {
    try {
      for await (const e of sub.stream) events.push({ t: Date.now(), ...e })
    } catch {}
  })()
  return events
}
