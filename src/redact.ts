/**
 * Best-effort secret redaction applied to every piece of primary-session text before it is sent
 * to the advisor model. It is a safety net, not a guarantee: the advisor model is a second
 * provider/model that receives your code context. Keep that in mind when choosing it.
 */

const REPLACEMENT = "[REDACTED]"

const SIMPLE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b[spr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bxapp-[A-Za-z0-9-]{10,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
]

const BEARER = /\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{20,}/gi

const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi

// JSON/YAML のようにキーが引用符で囲まれる形、引用符付きで空白を含む値、pass/pwd 系のキー名にも対応する。
// Hỗ trợ khóa nằm trong dấu nháy kiểu JSON/YAML, giá trị có nháy và chứa khoảng trắng, và các khóa kiểu pass/pwd.
const KEY_VALUE =
  /\b([A-Za-z0-9_.-]*(?:secret|token|passwd|password|pass|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(["']?)(\s*[:=]\s*)(?:(["'`])([^"'`\n]{8,})\4|([^\s"'`,;)}\]]{8,}))/gi

const ENV_REFERENCE = /^(?:process\.env|os\.environ|env\.|getenv|config\.|settings\.|\$\{?|<)/i

/** An unquoted value looks like a real secret if it has a digit, or is long. Plain identifiers/type names are left alone. */
function looksSecret(value: string): boolean {
  if (ENV_REFERENCE.test(value)) return false
  return /\d/.test(value) || value.length >= 24
}

export function redact(text: string): string {
  if (!text) return text
  let out = text
  for (const re of SIMPLE_PATTERNS) out = out.replace(re, REPLACEMENT)
  out = out.replace(BEARER, `$1$2${REPLACEMENT}`)
  out = out.replace(URL_CREDS, `$1$2:${REPLACEMENT}@`)
  out = out.replace(KEY_VALUE, (m, key: string, keyQuote: string, sep: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    // 引用符付きの値は、秘密の名前のキーに対して明示的に書かれているので、環境変数参照でなければ伏せる。
    // Giá trị có nháy được viết tường minh cho một khóa mang tên bí mật nên che luôn, trừ khi chỉ là tham chiếu biến môi trường.
    if (quote !== undefined && quoted !== undefined) return ENV_REFERENCE.test(quoted) ? m : `${key}${keyQuote}${sep}${quote}${REPLACEMENT}${quote}`
    return bare !== undefined && looksSecret(bare) ? `${key}${keyQuote}${sep}${REPLACEMENT}` : m
  })
  return out
}
