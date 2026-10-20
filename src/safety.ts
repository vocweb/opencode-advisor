/**
 * The advisor reads untrusted content (tool outputs, web pages, files). A prompt-injected advisor
 * could try to launder instructions into the primary agent through `advise`. This screen rejects
 * the clearly hostile shapes before a note ever reaches the primary session.
 *
 * Rule of thumb borrowed from oh-my-pi: a *warning* that quotes a dangerous command which is already
 * present in the reviewed transcript is legitimate; a dangerous directive that appears only in the
 * advisor's output is suspicious.
 */

interface Pattern {
  name: string
  re: RegExp
}

/** Hostile whatever the context: advice has no business talking like this. */
const ALWAYS: Pattern[] = [
  { name: "instruction-override", re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|previous\s+|prior\s+|above\s+|earlier\s+){1,3}(?:instructions?|rules?|prompts?|guidelines?|constraints?)\b/i },
  { name: "instruction-override", re: /\b(?:new|updated)\s+(?:system\s+)?instructions?\s*:/i },
  { name: "role-hijack", re: /\byou\s+are\s+now\b/i },
  { name: "concealment", re: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|notify|alert|show)\s+(?:the\s+)?user\b/i },
  { name: "concealment", re: /\bwithout\s+(?:telling|informing|notifying)\s+(?:the\s+)?user\b/i },
  { name: "advisory-forgery", re: /<\/?advisory\b/i },
]

/** Hostile only when the advisor invents it (i.e. it is not quoting something from the transcript). */
const OUTPUT_ONLY: Pattern[] = [
  { name: "destructive-shell", re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\*)/i },
  { name: "destructive-shell", re: /\b(?:mkfs(?:\.\w+)?|dd\s+if=\S+\s+of=\/dev\/\S+|:\(\)\s*\{\s*:\|:&\s*\};:|chmod\s+-R\s+0?777\s+\/)/i },
  { name: "pipe-to-shell", re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i },
  { name: "force-push", re: /\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)/i },
  { name: "history-rewrite", re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*d?)\b/i },
  { name: "exfiltration", re: /\b(?:curl|wget|nc|ncat)\b[^\n]*(?:\.ssh|id_rsa|\.aws|\.env\b|\/etc\/passwd)/i },
  { name: "exfiltration", re: /\b(?:send|post|upload|exfiltrate|email)\b[^\n]{0,60}\b(?:api[_ -]?keys?|secrets?|credentials?|tokens?|passwords?|private\s+keys?)\b[^\n]{0,60}\b(?:to|at)\s+https?:\/\//i },
  { name: "account-deletion", re: /\b(?:delete|remove|drop)\s+(?:the\s+|your\s+|all\s+)?(?:user\s+)?(?:account|database|repo(?:sitory)?|production\s+\w+)\b/i },
]

export interface SafetyVerdict {
  ok: boolean
  reasons: string[]
}

/**
 * @param note       the advisor's note
 * @param reviewInput the transcript text the advisor was shown in this review (used for the quoting exemption)
 */
export function screenNote(note: string, reviewInput = ""): SafetyVerdict {
  const reasons = new Set<string>()
  for (const p of ALWAYS) if (p.re.test(note)) reasons.add(p.name)
  const haystack = reviewInput.toLowerCase()
  for (const p of OUTPUT_ONLY) {
    const m = note.match(p.re)
    if (!m) continue
    const quoted = m[0].toLowerCase().replace(/\s+/g, " ")
    const inInput = haystack.replace(/\s+/g, " ").includes(quoted)
    if (!inInput) reasons.add(p.name)
  }
  return { ok: reasons.size === 0, reasons: [...reasons] }
}
