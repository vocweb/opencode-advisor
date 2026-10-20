import fs from "node:fs"
import path from "node:path"
import { globalConfigDir } from "./config.ts"
import { STARTER_YAML } from "./template.ts"
import { errMessage } from "./util.ts"
import { resolveWatchdogFile } from "./yamlio.ts"

export function globalWatchdogFile(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWatchdogFile(globalConfigDir(env))
}

// 初回起動時に空の WATCHDOG.yml を置く。既存設定は上書きせず、環境変数で無効化できる。
// Lần chạy đầu tạo WATCHDOG.yml khởi tạo; không ghi đè cấu hình sẵn có và có thể tắt bằng biến môi trường.
export function ensureStarterConfig(existingSources: readonly string[], env: NodeJS.ProcessEnv = process.env): { created: boolean; file: string; error?: string } {
  const file = globalWatchdogFile(env)
  if (env.OPENCODE_ADVISOR_NO_SETUP === "1" || existingSources.some((s) => /WATCHDOG\.ya?ml$/.test(s)) || fs.existsSync(file)) return { created: false, file }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, STARTER_YAML, { flag: "wx" })
    return { created: true, file }
  } catch (e) {
    return { created: false, file, error: errMessage(e) }
  }
}
