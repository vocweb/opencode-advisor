// TUI プラグインの中身。@opencode/plugin を実行時に読み込まず、必要な最小限の形だけを型で受け取る (server と同じ bundle に影響しない)。
// Phần lõi của plugin TUI: không nạp @opencode/plugin lúc chạy mà chỉ nhận các hình dạng tối thiểu cần dùng (không ảnh hưởng bundle của server).
import { clip } from "./util.ts"

const SELF_MARK = "opencodeAdvisor"

export interface ToastSpec {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  sessionID?: string
}

interface InboxItem {
  type?: string
  payload?: { text?: string; description?: string; metadata?: Record<string, unknown> }
}

/** The toast an advisor delivery or notice deserves, or undefined for anything else in the inbox. */
export function toastFor(sessionID: string | undefined, item: InboxItem | undefined): ToastSpec | undefined {
  if (item?.type !== "synthetic") return undefined
  const meta = item.payload?.metadata
  const mark = meta?.[SELF_MARK]
  const base = sessionID ? { sessionID } : {}
  if (mark === "notice") {
    const variant = meta?.variant === "error" ? "error" : "warning"
    return { title: "Advisor", message: clip(String(item.payload?.description ?? ""), 280), variant, ...base }
  }
  if (mark !== true) return undefined
  const severity = String(meta?.severity ?? "nit")
  // advisory の本文だけを取り出す (タグは外す)。複数あれば最初の 1 件に「ほか n 件」を添える。
  // Chỉ lấy phần nội dung advisory (bỏ thẻ); nếu có nhiều thì lấy cái đầu kèm "và n cái nữa".
  const body = String(item.payload?.text ?? "")
    .replace(/<\/?advisory[^>]*>/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0]
  const count = Number(meta?.count ?? 1)
  const more = count > 1 ? ` (+${count - 1} more)` : ""
  return { title: `Advisor (${severity})`, message: clip(`${body ?? ""}${more}`, 280), variant: severity === "blocker" ? "error" : "warning", ...base }
}

export interface Entry {
  name: string
  enabled: boolean
  model: string
  editable: boolean
}

/** Parse the output of `/advisor entries`. */
export function parseEntries(text: string): Entry[] {
  return text
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((c) => c.length >= 4 && c[0])
    .map((c) => ({ name: c[0]!, enabled: c[1] === "enabled", model: c[2]!, editable: c[3] === "file" }))
}

// ---------------------------------------------------------------- the plugin

interface Dialogs {
  select<V>(o: { title: string; options: readonly { title: string; value: V; description?: string }[] }): Promise<V | undefined>
  prompt(o: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
  alert(o: { title: string; message: string }): Promise<void>
}

export interface TuiLike {
  options: Readonly<Record<string, unknown>>
  ui: { toast: { show(o: ToastSpec): void }; dialog: Dialogs; router: { current(): { type: string; sessionID?: string } } }
  keymap: { layer(factory: () => { mode?: string; commands: readonly { id: string; title: string; group?: string; palette?: true; slash?: { name: string }; run: () => void | Promise<void> }[] }): void }
  data: { on(type: "session.inbox.enqueued", handler: (e: { data: { sessionID?: string; item?: InboxItem } }) => void): () => void }
  /** Run `/advisor <text>` in a session and return the reply text. */
  command(sessionID: string, text: string): Promise<string>
}

type Action = "status" | "dump" | "toggle" | "reset" | "reload" | "enable" | "disable" | "model" | "setup" | "init" | "configure"

export function setupTui(ctx: TuiLike): () => void {
  const toastsOn = ctx.options.toast !== false
  const stop = ctx.data.on("session.inbox.enqueued", (e) => {
    if (!toastsOn) return
    const t = toastFor(e.data.sessionID, e.data.item)
    if (t) ctx.ui.toast.show(t)
  })

  const show = (title: string, message: string) => ctx.ui.dialog.alert({ title, message })

  async function menu(): Promise<void> {
    const route = ctx.ui.router.current()
    if (route.type !== "session" || !route.sessionID) return void (await show("Advisor", "Open a session first: the advisor is controlled per session."))
    const sessionID = route.sessionID
    const run = async (text: string, title: string) => show(title, await ctx.command(sessionID, text))

    const action = await ctx.ui.dialog.select<Action>({
      title: "Advisor",
      options: [
        { title: "Status", value: "status", description: "Each advisor's state, model, tokens and cost" },
        { title: "Dump", value: "dump", description: "What the advisors saw and said" },
        { title: "Turn on/off for this session", value: "toggle" },
        { title: "Reset", value: "reset", description: "Forget the advisor's context and failure state" },
        { title: "Reload the configuration", value: "reload" },
        { title: "Enable an advisor", value: "enable" },
        { title: "Disable an advisor", value: "disable" },
        { title: "Set an advisor's model", value: "model" },
        { title: "Set the default model", value: "setup", description: "modelRoles.advisor in the user-level WATCHDOG.yml" },
        { title: "Create a sample WATCHDOG.yml", value: "init" },
        { title: "Configuration files and warnings", value: "configure" },
      ],
    })
    if (!action) return

    const pick = async (title: string, filter: (e: Entry) => boolean): Promise<Entry | undefined> => {
      const entries = parseEntries(await ctx.command(sessionID, "entries")).filter(filter)
      if (entries.length === 0) return void (await show(title, "No advisor can be changed this way."))
      return ctx.ui.dialog.select<Entry>({ title, options: entries.map((e) => ({ title: e.name, value: e, description: `${e.enabled ? "enabled" : "disabled"} · ${e.model}` })) })
    }

    switch (action) {
      case "status":
        return run("status", "Advisor status")
      case "dump":
        return run("dump", "Advisor dump")
      case "toggle":
        return run("", "Advisor")
      case "reset":
        return run("reset", "Advisor")
      case "reload":
        return run("reload", "Advisor")
      case "configure":
        return run("configure", "Advisor configuration")
      case "enable":
      case "disable": {
        const e = await pick(action === "enable" ? "Enable which advisor?" : "Disable which advisor?", (x) => x.editable && x.enabled === (action === "disable"))
        if (e) await run(`${action} ${e.name}`, "Advisor")
        return
      }
      case "model": {
        const e = await pick("Which advisor's model?", (x) => x.editable)
        if (!e) return
        const model = await ctx.ui.dialog.prompt({ title: `Model for ${e.name}`, description: "provider/model, optionally :level (for example anthropic/claude-haiku-4-5:low), or inherit", value: e.model === "-" ? "" : e.model })
        if (model?.trim()) await run(`model ${e.name} ${model.trim()}`, "Advisor")
        return
      }
      case "setup": {
        const model = await ctx.ui.dialog.prompt({ title: "Default advisor model", description: "provider/model, optionally :level", placeholder: "anthropic/claude-haiku-4-5" })
        if (model?.trim()) await run(`setup ${model.trim()}`, "Advisor")
        return
      }
      case "init": {
        const scope = await ctx.ui.dialog.select<"project" | "user">({ title: "Where?", options: [{ title: "This project", value: "project" }, { title: "Your user config", value: "user" }] })
        if (scope) await run(`configure init ${scope}`, "Advisor")
        return
      }
    }
  }

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [{ id: "opencode-advisor.menu", title: "Advisor: control and configure", group: "Advisor", palette: true, slash: { name: "advisor-config" }, run: () => menu().catch((e) => ctx.ui.toast.show({ title: "Advisor", message: String(e instanceof Error ? e.message : e).slice(0, 280), variant: "error" })) }],
  }))

  return () => stop()
}
