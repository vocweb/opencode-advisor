import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isMap, isSeq, parseDocument, type Document } from "yaml"
import { EXAMPLE_YAML } from "./template.ts"
import { errMessage, slugify } from "./util.ts"

export type IoResult = { ok: true; file: string } | { ok: false; error: string }

// 既にあるファイルを優先する (omp と同じ挙動)。
// Ưu tiên file đã tồn tại, giống hành vi của omp.
export function resolveWatchdogFile(dir: string): string {
  const yml = path.join(dir, "WATCHDOG.yml")
  const yaml = path.join(dir, "WATCHDOG.yaml")
  return !fs.existsSync(yml) && fs.existsSync(yaml) ? yaml : yml
}

// 推測できない名前の一時ファイルへ排他的に書いて rename する。symlink はユーザー自身のファイル (dotfiles) のときだけ実体へ書き、repo 内のものは拒否する。
// Ghi vào file tạm tên ngẫu nhiên rồi rename; chỉ theo symlink khi là file của chính người dùng (dotfiles), còn trong repo thì từ chối.
function writeAtomic(file: string, text: string, allowSymlink: boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let target = file
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    if (!allowSymlink) throw new Error(`${file} is a symbolic link; refusing to write through it`)
    target = fs.realpathSync(file)
  }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`)
  fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 })
  try {
    fs.renameSync(tmp, target)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

// parseDocument ならコメントが保持され、書き戻しても消えない。
// parseDocument giữ nguyên comment nên ghi lại không làm mất chúng.
function openDoc(file: string): { doc: Document } | { error: string } {
  const doc = parseDocument(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
  if (doc.errors.length > 0) return { error: `${file} is not valid YAML (${doc.errors[0]!.message.split("\n")[0]}); not modified.` }
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  else if (!isMap(doc.contents)) return { error: `${file} is not a YAML mapping; not modified.` }
  return { doc }
}

export function setModelRole(file: string, model: string, allowSymlink = false): IoResult {
  try {
    const o = openDoc(file)
    if ("error" in o) return { ok: false, error: o.error }
    o.doc.setIn(["modelRoles", "advisor"], model)
    writeAtomic(file, o.doc.toString({ lineWidth: 0, doubleQuotedAsJSON: true }), allowSymlink)
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

// 名前の slug が一致する roster エントリの enabled だけを書き換える。
// Chỉ sửa enabled của entry roster có slug tên trùng khớp.
export function setAdvisorEnabled(file: string, name: string, enabled: boolean, allowSymlink = false): IoResult {
  try {
    const o = openDoc(file)
    if ("error" in o) return { ok: false, error: o.error }
    const list = o.doc.get("advisors")
    const slug = slugify(name)
    if (isSeq(list)) {
      for (const item of list.items) {
        if (isMap(item) && slugify(String(item.get("name") ?? "")) === slug) {
          item.set("enabled", enabled)
          writeAtomic(file, o.doc.toString({ lineWidth: 0, doubleQuotedAsJSON: true }), allowSymlink)
          return { ok: true, file }
        }
      }
    }
    return { ok: false, error: `No advisor named "${name}" in ${file}.` }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

// 注釈付きサンプルを作る。ユーザーの設定を壊さないため上書きしない。
// Tạo file mẫu có chú thích; không bao giờ ghi đè để không phá cấu hình của người dùng.
export function createTemplate(file: string, allowSymlink = false): IoResult {
  try {
    if (fs.existsSync(file)) return { ok: false, error: `${file} already exists; not overwritten.` }
    writeAtomic(file, EXAMPLE_YAML, allowSymlink)
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}
