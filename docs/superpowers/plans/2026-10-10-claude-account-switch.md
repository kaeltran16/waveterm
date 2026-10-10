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
- A failed sync must not show twice. `VaultSyncCommand` with `wait: true` rejects with the sync's own error,
  which the reloaded status also carries as `lasterror` (shown by the status line). Only an RPC failure belongs
  in the note: after a rejection, reload the status and put the message in `remoteError` only when the
  reloaded status has no `lasterror`, is still `running` (the 120 s timeout fired mid-sync), or could not be
  loaded. Make that decision a second pure function in `settingsmodel.ts`, with vitest cases for a sync
  failure (no note), a timeout while running (note), and a rejection with no `lasterror` (note).
- Button style matches the Settings secondary button (`rounded border border-edge-mid px-[13px] py-[7px]
  text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-primary`) with a lucide
  `RefreshCw` icon at 12, fixed width so the label change does not shift the input; it sits right of the
  remote input in the row's control slot. Give it `data-testid="vault-sync-now"`, and the existing status line
  `data-testid="vault-sync-status"`.
- Call `RpcApi.VaultSyncCommand(TabRpcClient, { wait: true }, { timeout: 120_000 })`, then `loadStatus()`;
  a rejection reaches the existing `remoteError` note only as the bullet above decides. Render the existing
  status line in the error color (`text-error`) when `status.lasterror` is set and nothing is running.
- Add CDP scenario `settings-vault-sync` to `scripts/cdp/scenarios.mjs` and its `SCENARIOS` list, following
  `settings-radar-audit` for structure and `arrangePeekItemsNote` for reading the vault config. The final dev
  app's vault has no remote, so the arrange gives the app a throwaway vault with one, never touching the
  configured vault (under a plain `task dev` that may be the user's real one):
  - **arrange:** record `memory:vaultpath` from `getfullconfig`; make a temp vault dir and a temp remote dir
    (`mkdtempSync`); `git init --bare` the remote; `setconfig` `memory:vaultpath` to the temp vault (wavevault
    opens the configured root on every call, so no restart is needed); `vaultsetremote` with the remote's
    path. Return the temp paths and the previous value in ctx, so a throw part-way still tears down.
  - **assert:** open Settings, select the Vault section (`[data-section="memory"]`), wait for
    `[data-setting-row="memory.remote"]`. Step 1: `[data-testid="vault-sync-now"]` exists, is enabled and
    reads "Sync now" (`vaultstatus` over RPC has no `off`); scroll the row into view and shoot
    `cdp-shots/settings-vault-sync-idle.png` (the step that shows the Sync now button). Step 2: in one
    evaluate, click it, await one animation frame (the local in-flight flag renders before the RPC returns),
    then read the label and disabled state: "Syncing…" and disabled; shoot
    `cdp-shots/settings-vault-sync-syncing.png` (the step that shows Syncing…). Step 3: wait (up to 30 s) for
    the status line to read "Last synced just now" and the button to be enabled, with no error note in the
    row. Step 4: `vaultsetremote` to a path under the temp dir that does not exist, click Sync now, wait for
    the status line to start with "Sync failed:"; assert its computed color equals the `--color-error` token,
    the button is enabled again (retry allowed), and the row has no error note (the failure shows once, in the
    status line); shoot `cdp-shots/settings-vault-sync-failed.png` (the step that shows the failed state).
  - **teardown:** `vaultsetremote` `""` while the temp vault is still configured, `setconfig`
    `memory:vaultpath` back to the recorded value (null when it was unset), then remove both temp dirs.

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
  non-active rows), whether to show the one-account hint and the no-login note, the "No new login found"
  check result (the account count did not grow), and the status line after a successful switch: "Switched to
  <email>. New claude sessions use it; running ones pick it up at their next token check." The switched status
  line and the no-login note are covered by these tests only: the CDP scenario must not click Switch (it would
  rewrite the real `~/.claude`), and the final dev app runs with the user's real login.
- `frontend/app/view/agents/ratelimitstore.ts`: export a function that drops one provider's saved snapshot
  from the atom and localStorage (try/catch like `recordRateLimit`), with vitest cases in
  `frontend/app/view/agents/ratelimitstore.test.ts` (create it if absent): the provider's snapshot leaves both
  the atom and localStorage, other providers' snapshots stay, and a throwing localStorage does not throw. Call
  it for `claude` after a successful switch.
- `settingssurface.tsx`: a `ClaudeAccountSection` rendered from `SectionBody` for `claudeaccount`, laid out as
  `Main.dc.html` and `States.dc.html` draw it, using the existing `SettingRow` (stacked for Accounts), `Note`,
  and button classes; tokens only (selected row `bg-surface-selected border-edge-strong`, others
  `bg-surface-raised border-edge-mid`, Claude initial `bg-rt-claude-soft border-rt-claude-line
  text-rt-claude`, Active label `text-success` with a `bg-success` dot, expired line `text-warning`). List on
  mount; Switch and Remove call the Task 1 RPCs, then re-list; errors go to an error `Note` under the list.
  After a successful switch, show the model's switched status line under the list. Test ids:
  `data-testid="claude-account-row"` per account, with `data-active` on the active one and `data-account-uuid`
  on every row; `claude-account-switch`, `claude-account-remove`, `claude-account-check`,
  `claude-account-expired` (the amber line), `claude-account-hint` (one-account hint), `claude-account-nologin`
  (no-login note), `claude-account-error` (error note), `claude-account-nonew` ("No new login found").
- Add CDP scenario `settings-claude-account` (follow `settings-radar-audit`). The dev app reads the real
  `~/.claude`, so its live state is whatever the user has; the scenario seeds fake saved accounts into the dev
  app's own secret store (the isolated final store under Final, since `secrets.enc` lives in the config dir
  `ARC_DEV_DATA_DIR` moves) to show the other states. It never clicks Switch.
  - **arrange:** `setsecrets` two fake accounts named and shaped exactly as the spec says, with uuids no real
    account has (e.g. `00000000-0000-4000-8000-0000000a0001` and `...0002`, emails `seed-valid@example.com`
    and `seed-expired@example.com`, an org and plan, `lastusedts` a few hours ago): the valid one with
    `refreshTokenExpiresAt` a day ahead, the expired one a day past. Return their secret names in ctx.
  - **assert:** open Settings, select `[data-section="claudeaccount"]`. Step 1: the Accounts row shows a row
    with `data-active` or the no-login note, and the Check now button. Step 2: the valid seed's row is not
    active, its meta line contains "last used", and it has enabled Switch and Remove buttons. Step 3: the
    expired seed's row shows the expired line with the spec's text in the warning color (computed color equals
    the `--color-warning` token), a disabled Switch and an enabled Remove. Scroll the list into view and shoot
    `cdp-shots/settings-claude-account.png` (the step that shows the section with active, other and expired
    rows). Step 4: click Check now; "No new login found" appears and no error note does. Step 5: click Remove
    on the valid seed's row; the row goes and no error note appears. Step 6: click Remove on the expired seed's
    row; it goes. Step 7: if exactly one row remains, the one-account hint shows; shoot
    `cdp-shots/settings-claude-account-one.png` (the step that shows the hint; under Final with a live login
    the isolated store then holds only the captured live account).
  - **teardown:** `setsecrets` both seed names to null (deleting a missing secret is a no-op).
