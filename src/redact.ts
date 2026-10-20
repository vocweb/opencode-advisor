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
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
]

const BEARER = /\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{20,}/gi

const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi

const KEY_VALUE =
  /\b([A-Za-z0-9_.-]*(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["'`]?)([^\s"'`,;)}\]]{8,})\3/gi

/** A value looks like a real secret if it has a digit, or is long. Plain identifiers/type names are left alone. */
function looksSecret(value: string): boolean {
  if (/^(?:process\.env|os\.environ|env\.|getenv|config\.|settings\.|\$\{?|<)/i.test(value)) return false
  return /\d/.test(value) || value.length >= 24
}

export function redact(text: string): string {
  if (!text) return text
  let out = text
  for (const re of SIMPLE_PATTERNS) out = out.replace(re, REPLACEMENT)
  out = out.replace(BEARER, `$1$2${REPLACEMENT}`)
  out = out.replace(URL_CREDS, `$1$2:${REPLACEMENT}@`)
  out = out.replace(KEY_VALUE, (m, key: string, sep: string, quote: string, value: string) =>
    looksSecret(value) ? `${key}${sep}${quote}${REPLACEMENT}${quote}` : m,
  )
  return out
}
