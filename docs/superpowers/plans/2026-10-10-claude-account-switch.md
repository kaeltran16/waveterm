# Claude account switching and manual vault sync implementation plan

**Spec:** `docs/superpowers/specs/2026-10-10-claude-account-switch-design.md` Read it first: it is the design, and every task's requirements include it. The design canvas it names is gitignored; read its boards from the absolute path the spec gives.
**Verify:** `node scripts/verify.mjs ./pkg/jarvis ./pkg/wshrpc/... ./pkg/secretstore`
**Check:** `go vet ./pkg/jarvis/ ./pkg/wshrpc/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke settings-claude-account settings-vault-sync`

## Goal and shape

Settings gains a Claude account section that lists every Claude.ai login Arc has seen and switches the active
one in one click (backend in `pkg/jarvis`, beside `claudetrust.go`, whose config-path resolution and
`lockClaudeConfig` it reuses), and the Vault section's Sync remote row gains a Sync now button over the existing
`VaultSyncCommand`. Task 1 (backend) and Task 2 (vault button) are independent. Task 3 (account UI) needs Task
1's generated RPC client and edits the same Settings files as Task 2, so it runs after both.

Repo rules that bite here (AGENTS.md): never hand-edit generated files, run `task generate` after changing a
wshrpc type; typecheck with `task check:ts` (not `npx tsc`), give it more than 2 minutes; colors only from
`@theme` tokens in `frontend/tailwindsetup.css`; testable logic goes in a pure `.ts` with a `.test.ts` beside
it, no render tests; prettier/gofmt only the files you touched; never run prettier on `scripts/*.mjs`.

### Task 1: Claude account backend and RPC
**Depends on:** none

Implement spec section 1 "Behaviour" in a new `pkg/jarvis/claudeaccount.go` with `claudeaccount_test.go`.

- Resolve the credentials file as `<config dir>/.credentials.json` (config dir = `CLAUDE_CONFIG_DIR`, else
  `~/.claude`) through a package var, like `claudeConfigPath`, so tests use temp files. Reuse `claudeConfigPath`
  and `lockClaudeConfig` from `claudetrust.go` for the user config file; do not copy them.
- Reach the secret store through a small package-var interface (get, set, delete, names) backed by
  `pkg/secretstore`, so tests use an in-memory fake. Secret names and value shape exactly as the spec says.
- Exported functions: list (captures first), switch by uuid, remove by uuid. One mutex serializes capture,
  switch and remove. Treat JSON you do not own as `map[string]json.RawMessage` so unknown keys survive.
- Switch order and rollback exactly as the spec's five steps; errors wrap with the file path and cause.
- Add `pkg/wshrpc/wshrpctypes_claudeaccount.go` with a `ClaudeAccountCommands` interface composed into the
  main interface in `pkg/wshrpc/wshrpctypes.go` (follow `wshrpctypes_vault.go` / `VaultCommands`):
  `ClaudeAccountsCommand(ctx) (*ClaudeAccountsRtnData, error)`,
  `ClaudeAccountSwitchCommand(ctx, CommandClaudeAccountData) error`,
  `ClaudeAccountRemoveCommand(ctx, CommandClaudeAccountData) error`. `CommandClaudeAccountData` carries
  `accountuuid`; `ClaudeAccountsRtnData` carries `loggedin` and `accounts`, each with `accountuuid`, `email`,
  `orgname`, `plan`, `active`, `expired`, `lastusedts` (ms). Handlers in a new
  `pkg/wshrpc/wshserver/wshserver_claudeaccount.go` (follow `wshserver_vault.go`), then `task generate`.
- Tests: every case listed under the spec's Testing bullet for Go. They must fail if a switch drops
  `mcpOAuth` or another key, skips the pre-switch capture, or leaves `.credentials.json` changed after a
  failed config write.

### Task 2: Sync now on the vault Sync remote row
**Depends on:** none

Implement spec section 2 in `MemorySection` of `frontend/app/view/agents/settingssurface.tsx`.

- Put the button-state decision (enabled, label) in a pure function in
  `frontend/app/view/agents/settingsmodel.ts` beside `vaultStatusLine`, taking the vault status plus a local
  "click in flight" flag, with vitest cases in `settingsmodel.test.ts` for running, off (no-git, no-remote),
  failed and idle.
- Button style matches the Settings secondary button (`rounded border border-edge-mid px-[13px] py-[7px]
  text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-primary`) with a lucide
  `RefreshCw` icon at 12, fixed width so the label change does not shift the input; it sits right of the
  remote input in the row's control slot. Give it `data-testid="vault-sync-now"`.
- Call `RpcApi.VaultSyncCommand(TabRpcClient, { wait: true }, { timeout: 120_000 })`, then `loadStatus()`;
  an RPC rejection goes to the existing `remoteError` note. Render the existing status line in the error color
  when `status.lasterror` is set and nothing is running.
- Add CDP scenario `settings-vault-sync` to `scripts/cdp/scenarios.mjs` and its `SCENARIOS` list, following
  `settings-radar-audit`: open Settings, select the Vault section (`[data-section="memory"]`), wait for
  `[data-setting-row="memory.remote"]`, and assert the button exists and that its disabled state agrees with
  `vaultstatus` read over RPC (off or running means disabled). Scroll it into view and shoot
  `cdp-shots/settings-vault-sync.png`. Click only when enabled, then wait for the status line to change.
  This shot is the step that shows the Sync now button.

### Task 3: Claude account section in Settings
**Depends on:** Task 1, Task 2

Implement spec section 1 "Settings UI" and "Usage donuts".

- `frontend/app/view/agents/settingsmodel.ts`: add the section (`id: "claudeaccount"`, name "Claude account",
  group Agents, directly after `newagent`) with rows `claudeaccount.accounts` (title "Accounts", scope local,
  key line as the spec gives) and `claudeaccount.add` (title "Add an account"), descriptions verbatim from
  the spec; rows store no wconfig key, so no `config` flag. Update any test that counts sections or rows.
- New pure `frontend/app/view/agents/claudeaccountmodel.ts` + `claudeaccountmodel.test.ts`: from
  `ClaudeAccountsRtnData` derive the ordered rows (active first, then by `lastusedts` descending) with each
  row's flags (active, switchable, expired) and meta line (`org · plan`, plus `· last used <formatAgo>` for
  non-active rows), whether to show the one-account hint and the no-login note, and the "No new login found"
  check result (the account count did not grow).
- `frontend/app/view/agents/ratelimitstore.ts`: export a function that drops one provider's saved snapshot
  from the atom and localStorage (try/catch like `recordRateLimit`), with a test; call it for `claude` after a
  successful switch.
- `settingssurface.tsx`: a `ClaudeAccountSection` rendered from `SectionBody` for `claudeaccount`, laid out as
  `Main.dc.html` and `States.dc.html` draw it, using the existing `SettingRow` (stacked for Accounts), `Note`,
  and button classes; tokens only (selected row `bg-surface-selected border-edge-strong`, others
  `bg-surface-raised border-edge-mid`, Claude initial `bg-rt-claude-soft border-rt-claude-line
  text-rt-claude`, Active label `text-success` with a `bg-success` dot, expired line `text-warning`). List on
  mount; Switch and Remove call the Task 1 RPCs, then re-list; errors go to an error `Note` under the list.
  Test ids: `data-testid="claude-account-row"` per account with `data-active` set on the active one,
  `claude-account-switch`, `claude-account-remove`, `claude-account-check`.
- Add CDP scenario `settings-claude-account` (follow `settings-radar-audit`): open Settings, select
  `[data-section="claudeaccount"]`, assert the Accounts row shows either a row with `data-active` or the
  no-login note, and the Check now button; shoot `cdp-shots/settings-claude-account.png` (the step that shows
  the section); click Check now and assert no error note appears. Never click Switch or Remove: the dev app
  shares the real `~/.claude`.
