// 注釈付きサンプルの唯一の出典。WATCHDOG.example.yml と configure init が食い違わないようにするため。
// Nguồn duy nhất của file mẫu, để WATCHDOG.example.yml và configure init không bao giờ lệch nhau.
export const EXAMPLE_YAML = `# opencode-advisor configuration (schema mirrors oh-my-pi's WATCHDOG.yml).
# Place it at ~/.config/opencode/WATCHDOG.yml (user) or <project>/.opencode/WATCHDOG.yml (project).
# Nearer files win; \`instructions\` are concatenated; \`advisors\` merge by name.
# Cấu hình opencode-advisor (schema giống WATCHDOG.yml của oh-my-pi). File gần project hơn sẽ thắng.

# Shared by every advisor (appended to WATCHDOG.md). "@./file.md" is expanded.
instructions: |
  Prefer small, concrete findings. Flag missing tests for changed behaviour.

# Default model of every advisor without its own "model". REQUIRED for reviews to run.
# Mô hình mặc định cho mọi advisor không có "model" riêng. BẮT BUỘC để review chạy.
modelRoles:
  advisor: anthropic/claude-haiku-4-5

advisor:
  enabled: true
  reviewMode: turn          # turn | agent-end (only for the default advisor, when no roster is given)
  reviewInterval: 1         # review every Nth update (default advisor only)
  maxNotesPerUpdate: 4
  syncBacklog: off          # off | 1 | 3 | 5 | strict: make the primary wait for the advisor before its next LLM call
  immuneTurns: 3            # after a steering note, later concerns become asides for N primary turns
  continueSeverity: concern # after a final answer, notes at or above this wake the agent; lower ones are cards
  evictStaleResults: true
  maxSteersPerPrompt: 6
  contextTokenBudget: 120000
  reviewTimeoutMs: 300000
  maxConsecutiveFailures: 3 # dropped review batches in a row before the advisor halts
  toast: true
  includeReasoning: true

retry:
  enabled: true
  modelFallback: true
  fallbackOn: any                         # any | usage-limit | except-usage-limit
  fallbackRevertPolicy: cooldown-expiry   # cooldown-expiry | never
  maxDelayMs: 300000                      # cooldown of a failing model
  fallbackChains:
    advisor: [google/gemini-3-pro]        # keys: advisor | provider/model | provider/*

# Which \`task\` subagents are also watched: agent name -> on | off | provider/model
task:
  agentAdvisor: {}

# Optional roster: several named advisors, each with its own model / focus / tools.
advisors:
  - name: Security
    model: anthropic/claude-sonnet-4-5
    tools: [read, grep, glob]   # omitted = read, grep, glob ; [] = no investigative tools
    instructions: |
      Focus on secrets, injection, authz and unsafe shell commands.
  - name: Style
    enabled: false              # paused until \`/advisor enable Style\`
    reviewMode: agent-end       # turn | agent-end
    reviewInterval: 2
    instructions: |
      Naming, dead code, consistency with the surrounding codebase.
`

// 初回に残す最小ファイル。モデルの置き場所だけを示す。
// File tối thiểu để lại ở lần chạy đầu, chỉ chỉ chỗ đặt model.
export const STARTER_YAML = `# opencode-advisor: set a reviewer model, or run \`/advisor setup <provider/model>\`.
# See WATCHDOG.example.yml in the plugin repository for every option.
# Đặt model cho advisor, hoặc chạy \`/advisor setup <provider/model>\`.
advisor:
  enabled: true
# modelRoles:
#   advisor: anthropic/claude-haiku-4-5
`
