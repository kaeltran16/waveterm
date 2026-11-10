# API key login beside the Claude account switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Effort:** effort:8a0d9bfc-803b-4fdf-a36f-7169b621f7a0
**Spec:** `docs/superpowers/specs/2026-11-09-claude-api-login-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/secretstore ./pkg/jarvis ./pkg/wavebase ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs settings-claude-account settings-claude-apikey`

**Goal:** One saved Anthropic API key in Settings > Claude account that the user can switch claude sessions to and back, with every Claude quota display reading "API key" while it is active.

**Architecture:** The key lives in the secret store under one fixed name. Switching on writes an `apiKeyHelper` into Claude Code's user `settings.json` naming `~/.arc/bin/wsh.exe claude-api-key --config-dir <this Arc's config dir>`. That subcommand decrypts `secrets.enc` itself (no wavesrv) and prints the key. Switching to any Claude.ai account removes the helper first and puts it back if the account switch fails. The frontend keeps one `claudeApiKeyActiveAtom`. It feeds `mergeRateLimitWindows`, so the app-bar meters, the Usage surface and the pet all follow it.

**Tech Stack:** Go (pkg/jarvis, pkg/secretstore, wsh cobra), wshrpc + `task generate`, React 19 + jotai + Tailwind, vitest, CDP scenarios.

## Global Constraints

- Claude Code facts this plan relies on (code.claude.com/docs/en/settings-reference#apikeyhelper and /settings, read 2026-11-09):
  - On Windows Claude Code runs `apiKeyHelper` through `cmd`.
  - The value is cached for 5 minutes and re-run after a 401 or 403.
  - A helper set in user settings needs no approval (only project and local settings wait for workspace trust).
  - Claude Code watches settings files and hot-reloads `apiKeyHelper`, so **running sessions also switch**. The spec only promises new sessions. That stays true, but the status copy must not claim that running sessions keep the old credential.
- Secret name: `claudeapikey`. It must not start with `claudeacct_`, so `ListClaudeAccounts` never reads it as an account.
- Helper subcommand: `claude-api-key`, flag `--config-dir`. Helper value, exactly: `"<stable wsh>" claude-api-key --config-dir "<wavebase.GetWaveConfigDir()>"`.
- Settings file: `<CLAUDE_CONFIG_DIR>/settings.json`, else `~/.claude/settings.json`. Every other key is kept, and the file is written atomically (`fileutil.AtomicWriteFile`) with 2-space indent.
- Copy, verbatim: row title `API key · ends in …<last4>`, meta `pay per token`, display label `API key`, settings row title `API key`.
- No auto-switch. No `forgetRateLimit("claude")` when switching to or from the API key. Switching to a Claude.ai account that is not the live login still forgets it.
- No new design tokens. Reuse the classes the account rows use (`frontend/app/view/agents/settingssurface.tsx:1240-1320`).
- The dev app shares `~/.claude/settings.json` with the user's packaged Arc. **No step in this plan clicks Switch on the API key in a run.** The only scenario that does (`settings-claude-apikey-switch`) refuses to start unless the dev app's settings path is outside `~/.claude`.

## Review Focus

1. **A broken or odd `settings.json`** (invalid JSON, or `apiKeyHelper` set to `null`, a number, or a foreign command). Expected: invalid JSON → the switch fails, the error names the path, and nothing is written. `null` → treated as absent. A non-string or foreign value → refused, and the error names the value. A missing file → created holding only the helper. Tests are in Task 2.
2. **A pasted key with whitespace or a trailing newline.** Expected: trimmed before validation and storage, so `last4` and the stored value match the key. Test in Task 2.
3. **Offline, or the API slow, at Save.** Expected: an error naming the cause ("could not reach the Anthropic API: ..."), and nothing stored. The client timeout must be longer than the validation timeout, or the user sees EC-TIME. Tests in Task 2; the timeout constant is in Task 5.
4. **The account switch fails after the helper was removed.** Expected: the helper is put back, and the API key stays active. Test in Task 2.
5. **A helper written by the other Arc instance** (dev vs packaged: a different `--config-dir`, or the versioned wsh fallback path). Expected: it counts as Arc's. It shows as active, is removed on an account switch, and Switch rewrites it to this instance's command. Test in Task 2.

---

### Task 1: Secret store: read a secrets file directly, flush on demand
**Depends on:** none
**Files:** `pkg/secretstore/secretstore.go`, `pkg/secretstore/secretstore_test.go`

**Interfaces:**
- Produces: `secretstore.ReadSecretFile(configDir, name string) (string, bool, error)`. It reads `<configDir>/secrets.enc` without touching the in-memory store or `wavebase`. A missing file returns `("", false, nil)`. A file that cannot be decrypted or parsed returns an error naming the path.
- Produces: `secretstore.Flush() error`. It writes the in-memory secrets to disk now. It returns nil when the store was never initialized.

- [ ] **Step 1: Write the failing tests** in `secretstore_test.go`, reusing `useConfigDir`:
  - `TestFlushWritesBeforeDebounce`: `SetSecret("a","1")`, then `Flush()`, then immediately `ReadSecretFile(dir,"a")` → `("1", true, nil)`.
  - `TestReadSecretFileMissing`: an empty temp dir → `("", false, nil)`.
  - `TestReadSecretFileCorrupt`: write garbage bytes to `secrets.enc` → the error message contains the file path.
  - `TestReadSecretFileIgnoresWriteTs`: name `WriteTsKey` → `ok == false`.
- [ ] **Step 2: Run** `go test ./pkg/secretstore -run 'TestFlush|TestReadSecretFile'`. Expected: FAIL (undefined).
- [ ] **Step 3: Implement.**
  - Refactor `readSecretsFromFile` into `readSecretsFile(path string)`. It is shared by the store and `ReadSecretFile`.
  - Add a package `writeMu sync.Mutex` that serializes the whole `writeSecretsToFile`. A `Flush` and the debounce timer would otherwise race on the same `.tmp` file.
  - `Flush` calls `writeSecretsToFile` when `initialized`.
- [ ] **Step 4: Run** `go test ./pkg/secretstore`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(secretstore): read a secrets file directly and flush on demand`.

### Task 2: Backend: API key save, switch on/off, account switch removes the helper
**Depends on:** Task 1 (uses secretstore.Flush)
**Files:** `pkg/jarvis/claudeapikey.go`, `pkg/jarvis/claudeapikey_test.go`, `pkg/jarvis/claudeaccount.go`, `pkg/jarvis/claudeaccount_test.go`, `pkg/wavebase/wavebase.go`, `cmd/wsh/cmd/wshcmd-installhooks.go`, `cmd/wsh/cmd/wshcmd-installhooks_test.go`, `pkg/wshrpc/wshrpctypes_claudeaccount.go`, `pkg/wshrpc/wshserver/wshserver_claudeaccount.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces, in `pkg/jarvis/claudeapikey.go`:
  - `const ClaudeApiKeySecretName = "claudeapikey"` and `const ClaudeApiKeyHelperCmd = "claude-api-key"`. Task 3 uses both.
  - `SaveClaudeApiKey(ctx context.Context, key string) error`, `SwitchToClaudeApiKey() error`, `RemoveClaudeApiKey() error`.
- Produces, in `pkg/wavebase/wavebase.go`: `StableWshPath(home string) string`. This moves `stableWshPath` out of `wshcmd-installhooks.go`, and its callers and tests switch to it.
- Produces, on the wire (generated TS types follow):
  - `ClaudeAccountsRtnData.ApiKey *ClaudeApiKeyInfo json:"apikey,omitempty"`, always set by the server.
  - `ClaudeApiKeyInfo{Saved bool "saved"; Last4 string "last4"; Active bool "active"; SettingsPath string "settingspath"}`.
  - `ClaudeAccountInfo.Live bool json:"live,omitempty"`: the account is the Claude.ai login in `.credentials.json`, whether or not the API key is active. `Active` becomes `Live && !ApiKey.Active`.
  - Commands, added to `ClaudeAccountCommands`: `ClaudeApiKeySaveCommand(ctx, CommandClaudeApiKeyData{Key string "key"}) error`, `ClaudeApiKeySwitchCommand(ctx) error`, `ClaudeApiKeyRemoveCommand(ctx) error`. Wire names are `claudeapikeysave`, `claudeapikeyswitch`, `claudeapikeyremove`.

Package vars, so tests never touch real files or the network:
- `claudeSettingsPath`: `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`.
- `claudeHelperWsh`: `wavebase.StableWshPath(home)`.
- `claudeHelperConfigDir`: `wavebase.GetWaveConfigDir()`.
- `anthropicAPIBase = "https://api.anthropic.com"`.
- `validateClaudeApiKey func(ctx, key) error`.
- `claudeAccountStore` gains `Flush() error`. The fake in `claudeaccount_test.go` returns nil.

- [ ] **Step 1: Write the failing tests** in `claudeapikey_test.go`. Each test uses temp paths through the package vars and the fake store.
  - `TestSaveClaudeApiKeyTrimsValidatesStores`: key `"  sk-ant-x-abcd\n"` → the validator sees `"sk-ant-x-abcd"`, the store holds it, and `ListClaudeAccounts().ApiKey` = `{Saved:true, Last4:"abcd", Active:false}`.
  - `TestSaveClaudeApiKeyRefused`: the validator returns `errors.New("invalid x-api-key")` → the error contains it, and nothing is stored. An empty or blank key → an error, and the validator is not called.
  - `TestDefaultValidatorAgainstServer` (httptest, `anthropicAPIBase` swapped):
    - The request is `GET /v1/models?limit=1` with headers `x-api-key` and `anthropic-version: 2023-06-01`.
    - 200 → nil.
    - 401 with body `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}` → an error containing `invalid x-api-key`.
    - A closed server → an error containing `could not reach the Anthropic API`.
  - `TestSwitchToApiKeyKeepsOtherKeys`: start from settings `{"model":"opus","hooks":{"Stop":[]}}`. Switch, then `json.Unmarshal` the file → the same keys plus `apiKeyHelper` equal to `"<wsh>" claude-api-key --config-dir "<dir>"`. Switch back through `SwitchClaudeAccount(<live uuid>)` → the file decodes `reflect.DeepEqual` to the original.
  - `TestSwitchToApiKeyMissingSettingsFile`: no file → created holding only `apiKeyHelper`.
  - `TestSwitchToApiKeyInvalidSettings`: `{not json` → an error naming the path, and the file is unchanged.
  - `TestSwitchToApiKeyRefusesForeignHelper`: `"apiKeyHelper":"/bin/vault-key"` → the error contains `/bin/vault-key`, and the file is unchanged. A number value → refused. `null` → treated as absent, and the switch succeeds.
  - `TestSwitchToApiKeyNeedsKeyAndWsh`: no saved key → an error. `claudeHelperWsh` pointing at a missing file → an error naming it.
  - `TestOtherArcHelperCountsAsArcs`: settings hold `"C:\\x\\wsh-0.9.1-windows.x64.exe" claude-api-key --config-dir "C:\\other"` → `ApiKey.Active` is true. Switch rewrites it to this instance's command. `SwitchClaudeAccount` removes it.
  - `TestApiKeyActiveHidesAccountActive`: a live login plus Arc's helper → that account has `Live:true, Active:false`.
  - `TestAccountSwitchFailureRestoresHelper`: the helper is active, and the credentials path is a directory, so the write fails → `SwitchClaudeAccount(other)` errors, and `settings.json` still holds the helper.
  - `TestRemoveClaudeApiKey`: refused while active (the message says to switch to an account first). Otherwise the secret is gone and `Saved:false`.
- [ ] **Step 2: Run** `go test ./pkg/jarvis -run 'ClaudeApiKey|ApiKey|ArcHelper'`. Expected: FAIL (undefined).
- [ ] **Step 3: Implement** `claudeapikey.go`, and edit `claudeaccount.go`:
  - `isArcApiKeyHelper(cmd string) bool`: the first token (a leading double-quoted path is allowed) has a lowercase base name starting with `wsh`, and the next field is `claude-api-key`.
  - `readClaudeSettings` / `writeClaudeSettings` use `map[string]json.RawMessage` and the same perm handling as `writeClaudeCredentials`.
  - `removeArcApiKeyHelper() (restore func() error, err error)`: a no-op restore when no Arc helper is present.
  - `SaveClaudeApiKey`: validates with a 10 s context timeout, then `Set` + `Flush`.
  - In `SwitchClaudeAccount`, after the expired check and before the `live == target` early return, call `removeArcApiKeyHelper`. On every later failure, run its restore, and join its error the way the existing credentials restore does.
  - Every mutation holds `claudeAccountMu`.
- [ ] **Step 4: Wire RPC.** Add the types and commands in `wshrpctypes_claudeaccount.go` and the handlers in `wshserver_claudeaccount.go`, then run `task generate`.
- [ ] **Step 5: Run** `go test ./pkg/jarvis ./pkg/wavebase ./cmd/wsh/cmd` and `task check:ts` (timeout over 2 min). Expected: PASS, and tsc clean.
- [ ] **Step 6: Commit** `feat(claudeaccount): save an API key and switch claude to it via apiKeyHelper`.

### Task 3: wsh claude-api-key: print the saved key for Claude Code
**Depends on:** Task 1 (uses secretstore.ReadSecretFile), Task 2 (uses jarvis.ClaudeApiKeySecretName and ClaudeApiKeyHelperCmd)
**Chunk:** Backend: key in secret store, wsh key helper, switch on/off via apiKeyHelper
**Files:** `cmd/wsh/cmd/wshcmd-claudeapikey.go`, `cmd/wsh/cmd/wshcmd-claudeapikey_test.go`

**Interfaces:**
- Consumes: `secretstore.ReadSecretFile`, `jarvis.ClaudeApiKeySecretName`, `jarvis.ClaudeApiKeyHelperCmd`.
- Produces: a hidden cobra command `claude-api-key --config-dir <dir>` with no `PreRunE`, so it never opens an RPC connection. Its body is `claudeApiKeyRun(configDir string, out io.Writer) error`.

- [ ] **Step 1: Write the failing tests:**
  - `TestClaudeApiKeyPrintsKey`: point `wavebase.ConfigHome_VarCache` at a temp dir, `SetSecret(jarvis.ClaudeApiKeySecretName, "sk-ant-k")`, then `Flush`. `claudeApiKeyRun(dir, &buf)` → `buf.String() == "sk-ant-k"`.
  - `TestClaudeApiKeyNoneSaved`: an empty dir → the error contains `no Claude API key is saved` and the dir, and nothing is written to `out`.
  - `TestClaudeApiKeyNeedsConfigDir`: `""` → an error that names `--config-dir`.
- [ ] **Step 2: Run** `go test ./cmd/wsh/cmd -run 'TestClaudeApiKey'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The no-key message is: `no Claude API key is saved in Arc (<dir>); save one in Settings > Claude account, or switch back to a Claude.ai account`.
  - Print the key with no trailing newline.
  - RunE returns the error, so cobra writes it to stderr and the exit is non-zero.
- [ ] **Step 4: Run** `go test ./cmd/wsh/cmd -run 'TestClaudeApiKey|TestInstall'`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(wsh): claude-api-key prints the saved key for apiKeyHelper`.

### Task 4: Quota displays read "API key" while it is active
**Depends on:** Task 2 (uses the generated ClaudeAccountsRtnData.apikey)
**Chunk:** Quota display: API key state in donuts, rail meters, Usage surface, pet
**Files:** `frontend/app/view/agents/claudeapikeystore.ts`, `frontend/app/view/agents/claudeapikeystore.test.ts`, `frontend/app/view/agents/ratelimitstore.ts`, `frontend/app/view/agents/ratelimitstore.test.ts`, `frontend/app/view/agents/usagerail.ts`, `frontend/app/view/agents/usagerail.test.ts`, `frontend/app/view/agents/usagemeters.tsx`, `frontend/app/view/agents/usagesurface.tsx`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/jarvis/petsignals.ts`, `frontend/app/view/jarvis/petsignals.test.ts`, `frontend/app/view/jarvis/petview.tsx`, `frontend/app/cockpit/app-bar.tsx`

**Interfaces:**
- Produces, in `claudeapikeystore.ts`:
  - `claudeApiKeyActiveAtom: PrimitiveAtom<boolean>` (default false).
  - `syncClaudeApiKeyActive(data: ClaudeAccountsRtnData | null): void`. It sets the atom to `data.apikey?.active === true`. `null` leaves the atom as it is.
  - `loadClaudeApiKeyActive(): Promise<void>`. It calls `RpcApi.ClaudeAccountsCommand` and syncs. A failure is logged with context and leaves the atom unchanged.
- Produces, in `ratelimitstore.ts`:
  - `ProviderDonuts.apiKey?: boolean`.
  - `mergeRateLimitWindows(live, saved, now, claudeApiKey = false)`. When true, the claude entry is exactly `{ provider: "claude", fivehour: {}, week: {}, apiKey: true }`, present even with no live or saved reading, and it hides both live and saved claude windows.
- Produces, in `usagerail.ts`: `RailState` gains `"apikey"`. A donut with `apiKey` maps to it, and it sits in the `reporting` group.

- [ ] **Step 1: Write the failing tests:**
  - `ratelimitstore.test.ts`:
    - With `claudeApiKey` true, live claude usage at 80% plus a saved codex snapshot → claude `{fivehour:{}, week:{}, apiKey:true}`, and codex is unchanged.
    - With nothing live or saved → there is still a claude apiKey entry.
    - `topProviderUsage` over those donuts → codex, or `undefined` when claude is the only provider.
  - `usagerail.test.ts`: an apiKey donut → a row with `state: "apikey"` in group `reporting`.
  - `petsignals.test.ts`: `claudeApiKey: true` with live claude at 90% → `rateLimit` is `undefined`.
  - `claudeapikeystore.test.ts`: `syncClaudeApiKeyActive({loggedin:true, accounts:[], apikey:{saved:true,last4:"abcd",active:true,settingspath:""}})` → the atom is true. `null` → unchanged.
- [ ] **Step 2: Run** `npx vitest run frontend/app/view/agents/ratelimitstore.test.ts frontend/app/view/agents/usagerail.test.ts frontend/app/view/jarvis/petsignals.test.ts frontend/app/view/agents/claudeapikeystore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the store, the merge parameter and the rail state. Then wire the callers:
  - `planUsageAtom` in `agents.tsx` does `get(claudeApiKeyActiveAtom)`.
  - `usagesurface.tsx` and `petview.tsx` read it with `useAtomValue`.
  - `PetSources` gains `claudeApiKey: boolean`.
  - `app-bar.tsx` calls `fireAndForget(loadClaudeApiKeyActive)` once on mount.
- [ ] **Step 4: Render the state.**
  - `usagemeters.tsx`: an apiKey donut renders `<span data-usage-apikey>` reading `API key` (font-mono 11px, `text-muted`; provider dot when `multi`) in place of its bars. The button still renders when that is the only item.
  - `usagesurface.tsx`: `stateMeta` for `apikey` is `{ label: "API key", long: "pay per token", color: "var(--color-muted)" }`, `quotaFact` returns `"pay per token"`, and `quota` is `null`, so no bars and no projection.
- [ ] **Step 5: Run** the Step 2 tests, then `task check:ts`. Expected: PASS, and tsc clean.
- [ ] **Step 6: Commit** `feat(usage): quota displays read "API key" while claude uses one`.

### Task 5: Settings: the API key row, paste and save, Switch and Remove
**Depends on:** Task 2 (uses the claudeapikey* RPC commands and ClaudeAccountInfo.live), Task 4 (uses syncClaudeApiKeyActive from claudeapikeystore.ts)
**Chunk:** Settings: API key row, paste + validate, Switch/Remove
**Files:** `frontend/app/view/agents/claudeaccountmodel.ts`, `frontend/app/view/agents/claudeaccountmodel.test.ts`, `frontend/app/view/agents/settingssurface.tsx`, `frontend/app/view/agents/settingsmodel.ts`, `frontend/app/view/agents/settingsmodel.test.ts`, `scripts/cdp/scenarios-settings.mjs`, `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: `RpcApi.ClaudeApiKeySaveCommand / ClaudeApiKeySwitchCommand / ClaudeApiKeyRemoveCommand`, `syncClaudeApiKeyActive`.
- Produces, in `claudeaccountmodel.ts`:
  - `ClaudeApiKeyRow = { label: string; meta: string; active: boolean }`.
  - `ClaudeAccountView` gains `apiKey: ClaudeApiKeyRow | null` (null when no key is saved) and `apiKeyFirst: boolean` (true when it is active).
  - `ClaudeAccountRow` gains `removable: boolean` (`!live && !active`).
  - Constants: `CLAUDE_APIKEY_SAVE_TIMEOUT_MS = 20000` (above the server's 10 s validation) and `CLAUDE_APIKEY_SWITCHED = "Switched to the API key. Claude sessions use it from their next request, billed per token."`

- [ ] **Step 1: Write the failing tests** in `claudeaccountmodel.test.ts`:
  - `apikey {saved:true,last4:"abcd",active:false}` → `apiKey.label === "API key · ends in …abcd"`, `meta === "pay per token"`, `apiKeyFirst === false`.
  - Active → `apiKeyFirst === true`. Every non-expired account is `switchable`, including the one with `live:true`, and that account has `removable:false`.
  - `showNoLogin` is false while the API key is active. `showHint` is false while a key is saved.
  - In `settingsmodel.test.ts`, add `["claudeaccount.apikey", "API key"]` after `"Add an account"`.
- [ ] **Step 2: Run** `npx vitest run frontend/app/view/agents/claudeaccountmodel.test.ts frontend/app/view/agents/settingsmodel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the model and the row.**
  - `settingsmodel.ts` gets the row `{ id: "claudeaccount.apikey", title: "API key", desc: "Paste a key from platform.claude.com. Arc checks it with the Anthropic API before saving it. On the key, claude bills per token and has no 5-hour or weekly limit; claude.ai connectors and Remote Control are unavailable until you switch back to an account.", key: "settings.json apiKeyHelper · secrets.enc", scope: "local" }`.
- [ ] **Step 4: Implement the UI** in `ClaudeAccountSection`:
  - The API key row reuses the account row's shell and buttons, with lucide `KeyRound` in place of the initial. Test ids: `claude-apikey-row` (with `data-active` when active), `claude-apikey-switch`, `claude-apikey-remove`. It renders before the account rows when `apiKeyFirst`, after them otherwise.
  - Remove on an account row shows only when `row.removable`.
  - The `claudeaccount.apikey` row holds `<input type="password" data-testid="claude-apikey-input">` and a `claude-apikey-save` button, disabled while the input is blank or a save runs. Save calls `ClaudeApiKeySaveCommand(TabRpcClient, { key }, { timeout: CLAUDE_APIKEY_SAVE_TIMEOUT_MS })`, clears the input on success, and re-lists.
  - API key Switch shows `CLAUDE_APIKEY_SWITCHED` and never calls `forgetRateLimit`. An account Switch calls `forgetRateLimit("claude")` only when `!row.live`.
  - Every `list()` result goes through `syncClaudeApiKeyActive`. Errors use the existing `claude-account-error` note.
- [ ] **Step 5: Add the scenarios** in `scenarios-settings.mjs` and register both in `scenarios.mjs`.
  - `settings-claude-apikey`, safe for Final, never clicks Switch:
    - arrange: `h.rpc("setsecrets", { claudeapikey: "sk-ant-seed-0000abcd" })`.
    - Step 1: the `claude-apikey-row` text contains `API key · ends in …abcd` and `pay per token`, it is not active, it comes after every `claude-account-row`, and Switch and Remove are enabled.
    - Step 2: `claude-apikey-input` has type `password`, and `claude-apikey-save` is disabled while it is empty.
    - Step 3: screenshot `cdp-shots/settings-claude-apikey.png`, plus the font floor step over the accounts row.
    - Step 4: Remove → the row is gone and there is no error note.
    - teardown: `setsecrets { claudeapikey: null }`.
  - `settings-claude-apikey-switch`, for a dev app started with a temp `CLAUDE_CONFIG_DIR`. Not in this plan's Final.
    - arrange first calls `h.rpc("claudeaccounts")` and throws `refusing: settings.json is the user's real <path>; start the dev app with CLAUDE_CONFIG_DIR set to a temp dir` when `apikey.settingspath` case-insensitively equals `join(os.homedir(), ".claude", "settings.json")`.
    - It then seeds the key and one account (as `settings-claude-account` does) and clicks the API key Switch.
    - It asserts: the row is first with `data-active`; the account shows Switch; `[data-usage-meters] [data-usage-apikey]` reads `API key`; and the Usage surface's claude card pill reads `API key`.
    - It then switches to the seeded account and asserts the API key row is back to not active.
- [ ] **Step 6: Run** the Step 2 tests, `task check:ts`, and `npx eslint` and `npx prettier --check` on the touched `frontend/` files. Expected: all pass. The Final line runs `settings-claude-apikey` on the merged result.
- [ ] **Step 7: Commit** `feat(settings): API key row beside the Claude accounts`.

---

**After the run (initiative chunk "Verify in dev app on a temp CLAUDE_CONFIG_DIR", by hand):**
1. Start a dev app whose wavesrv sees `CLAUDE_CONFIG_DIR=<temp>`, and run `task verify:ui -- settings-claude-apikey-switch`.
2. Save a real key and switch to it. Then start a claude session with the same `CLAUDE_CONFIG_DIR` and confirm that `/status` shows the helper as the credential.
3. Switch back and confirm the session returns to the login.
