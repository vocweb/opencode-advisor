# opencode 2.x E2E harness

Run: `OPENCODE_BIN=opencode node test/e2e/smoke-v2.e2e.mjs` (needs `npm install`; uses `@opencode/client@2.1.1`).
Files: `harness-v2.mjs` (server + events), `lib-v2.mjs` (`makeEnvV2`, same shape as `makeEnv`), `smoke-v2.e2e.mjs`.
Gotchas:
- `opencode serve --port 0 --print-logs` prints `listening on <url>` and `server password <pw>`; parse both from the logs.
- Every HTTP call needs basic auth `opencode:<password>` and an `x-opencode-directory: <project>` header; the client takes both via `headers`.
- The directory header picks the project, so `addProject(name)` gives a second project on the same server.
- Isolation: HOME and all XDG_* dirs live in a realpath'd temp root (macOS /var is a symlink); never touch ~/.config/opencode or the user's own service.
- Port is random; only the spawned child is killed. The temp root is deleted on stop (set `KEEP_E2E_ROOT=1` to keep it).
- v2 client inputs are flat: `session.prompt({ sessionID, text })`, `session.command({ sessionID, name, text })`, `session.wait({ sessionID })`.
- Slash-command replies from the plugin arrive as `synthetic` messages; `command()` returns the newest one's `description` (else `text`), found in `session.context` and `session.inbox.list`.
- `session.list` returns `{ data, cursor }`, not an array; `children()` returns `data` (filtered by `parentID`, untested here).
