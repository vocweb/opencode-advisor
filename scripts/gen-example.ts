// WATCHDOG.example.yml は src/template.ts から生成する。手書きだと内容が食い違うため。
// WATCHDOG.example.yml được sinh từ src/template.ts để hai bản không bao giờ lệch nhau.
import fs from "node:fs"
import { EXAMPLE_YAML } from "../src/template.ts"

fs.writeFileSync(new URL("../WATCHDOG.example.yml", import.meta.url), EXAMPLE_YAML)
