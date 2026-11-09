# API key login beside the Claude account switcher

## Intent

When a Claude.ai account's quota (5-hour or weekly) is running out, switch new claude sessions to an Anthropic
API key so work keeps going, with the same one click as switching Claude.ai accounts. The switch is always the
user's click; Arc never switches on its own.

## What exists today

- `pkg/jarvis/claudeaccount.go`, `pkg/wshrpc/wshrpctypes_claudeaccount.go`, `pkg/wshrpc/wshserver/wshserver_claudeaccount.go`:
  `ClaudeAccountsCommand`, `ClaudeAccountSwitchCommand`, `ClaudeAccountRemoveCommand`. Saved Claude.ai logins
  live in `pkg/secretstore` as `claudeacct_<uuid>`; a switch writes `claudeAiOauth` into
  `<config dir>/.credentials.json` and `oauthAccount` into `~/.claude.json` under `lockClaudeConfig`.
  Spec: `docs/superpowers/specs/2026-10-10-claude-account-switch-design.md`.
- Settings UI: `frontend/app/view/agents/settingssurface.tsx` (rows `claudeaccount.accounts`,
  `claudeaccount.add`), model `frontend/app/view/agents/claudeaccountmodel.ts`.
- Usage donuts: `frontend/app/view/agents/ratelimitstore.ts` keeps the last 5h/weekly snapshot per provider.
- Secrets: `pkg/secretstore/secretstore.go` keeps every secret in `secrets.enc` under
  `wavebase.GetWaveConfigDir()`, DPAPI-encrypted to the Windows user (`crypt_windows.go`).
- `wsh install-agent-hooks` (`cmd/wsh/cmd/wshcmd-installhooks.go`) already edits `~/.claude/settings.json`,
  keeping every other key, and writes hook commands with wsh's absolute path.
- Nothing in Arc reads or sets `ANTHROPIC_API_KEY` or `apiKeyHelper` today. There is no wsh command that prints
  a secret.

### How Claude Code picks a credential (code.claude.com/docs/en/iam)

Highest first: cloud provider vars, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper` output,
`CLAUDE_CODE_OAUTH_TOKEN`, Anthropic profiles, then the `/login` subscription OAuth. So an `apiKeyHelper`
outranks the Claude.ai login, and removing it falls back to the login. While an API key is the credential,
claude.ai connectors, `/schedule` and Remote Control are unavailable; locally configured MCP servers still
work. API usage is billed per token on the Console account and has no 5h/weekly limit.

## Behaviour

### The key

- The user creates a key at platform.claude.com and pastes it in Settings. Arc does not capture a Console
  `/login` (it would sign out the Claude.ai login).
- One key at a time, stored in the secret store under one fixed secret name (builder picks the name).
  Saving again replaces it.
- Save validates the key with one request to the Anthropic API before storing it; a refused key shows the
  API's error and is not stored.
- Removing the key while it is active is refused, as for the active account.

### Switching to the API key

- Writes `apiKeyHelper` into `~/.claude/settings.json` (`<config dir>/settings.json` when `CLAUDE_CONFIG_DIR`
  is set), keeping every other key, by atomic write. Its value is a wsh command with wsh's absolute path, as
  install-agent-hooks writes hooks.
- That wsh command reads `secrets.enc` directly and DPAPI-decrypts it (no wavesrv needed, so it also works for
  claude started outside Arc or while Arc is closed), then prints the key to stdout. It exits non-zero with a
  clear message on stderr when no key is saved or the file can't be read.
- `.credentials.json` and `~/.claude.json` are not touched: the Claude.ai login stays in place underneath.
- A helper counts as Arc's when its command is a wsh running Arc's key-printing subcommand, whichever Arc
  instance (dev or packaged) wrote it: it shows as active and is removed on an account switch. *(Agent's call.)*
- Saving or replacing the key flushes the secret store to `secrets.enc` before returning, so the helper never
  reads a stale file through the store's debounced writer. Replacing the key while it is active needs no
  switch: the helper prints the new key the next time Claude Code runs it. *(Agent's call.)*
- If `settings.json` already holds a different `apiKeyHelper` (not Arc's), the switch is refused with an error
  naming it. *(Agent's call.)*
- Every claude session started after the switch uses the key. Claude Code also hot-reloads `apiKeyHelper` from
  `settings.json`, so running sessions may switch too; Arc promises only new sessions, and no copy claims that
  running sessions keep the old credential.

### Switching back

Switching to any Claude.ai account first removes Arc's `apiKeyHelper` from `settings.json`, then switches the
account as today. Switching to the account that is already the live login just removes the helper. If the
account switch then fails, the helper is put back, so a failed switch leaves the API key active, following the
restore pattern the account switch already uses for `.credentials.json`. *(Agent's call.)*

### Active state

- The API key is active when `settings.json` holds Arc's `apiKeyHelper`. The account list reports it; while it
  is active no Claude.ai account is reported active.
- The helper names the shared, versionless `~/.arc/bin/wsh.exe` (`stableWshPath`), as hooks do, so it
  survives app updates: the key (`secrets.enc` in the config dir), the helper setting and that wsh all live
  outside the install folder.
- Known limits, not handled: a shell with `ANTHROPIC_API_KEY` set outranks the helper and ignores the switch;
  if Arc is uninstalled while the API key is active, claude fails until the setting is removed. Until a
  packaged Arc ships this feature, launching an older packaged Arc while the API key is active replaces
  `~/.arc/bin/wsh.exe` with a wsh that lacks the subcommand, and new claude sessions fail until you switch
  back from a build that has it. Accepted for that window.

## UI

### Settings > Claude account

- The API key is one more row in the Accounts list, after the Claude.ai accounts: a key icon in place of the
  initial, "API key · ends in …abcd", "pay per token", then Remove and Switch in the same right-hand slot as
  the account rows.
- When active it moves to the top, on the selected background, with the green dot and "Active" (no Remove),
  and every Claude.ai account shows Switch.
- An "API key" row under Add an account holds a masked field and Save. With a key saved, the field replaces it.
- Errors from save, switch or remove show as the existing error note under the list.

### Usage donuts

While the API key is active, the Claude usage donuts show "API key" in place of the 5-hour and weekly quota
rings.

*(Agent's call, from the builder check:)* the same Claude quota data feeds the agents rail meters
(`agents.tsx` -> `usagemeters.tsx`), the Usage surface (`usagesurface.tsx`) and the Jarvis pet
(`petsignals.ts`, `topProviderUsage`). Apply the API state once, where that data is merged for the Claude
provider, so all three follow: the rail and Usage surface show "API key", and the pet treats Claude as having
no quota reading. While the API key is active, live 5h/weekly readings from sessions still on the OAuth login
are hidden too. Switching to or from the API key does not call `forgetRateLimit("claude")`: the saved snapshot
still describes the Claude.ai login underneath. Switching to a different Claude.ai account forgets it, as
today.

## Not in scope

No auto-switch. No spend or token-cost tracking. One API key, not several. No Console `/login` capture. No
per-agent credential: the switch is machine-wide, like the account switch. No control over when a running
session picks up the switch.

## Left to the builder

- Confirm against the Claude Code docs whether `apiKeyHelper` output needs a one-time approval like
  `ANTHROPIC_API_KEY`, and when Claude Code re-runs the helper.
- How the wsh helper finds `secrets.enc` for the dev vs packaged config dir (`dev.arc.app-dev` vs
  `dev.arc.app`): the helper must read the store of the Arc that wrote it.
- The wshrpc shape (extend the existing claude account commands or add new ones), then `task generate`.
- Which request validates the key on Save.
- Tests: switching on and off leaves `settings.json` otherwise byte-for-byte equivalent in content; switching
  to an account removes the helper; an existing foreign `apiKeyHelper` refuses the switch; the wsh helper
  prints the key and fails with a clear message when none is saved.
- Verify the Settings rows and the donut state in the live dev app (CDP), with a scenario that opens them.
  The dev app shares `~/.claude/settings.json` with the user's packaged Arc, so start the dev app for this
  verification with `CLAUDE_CONFIG_DIR` pointing at a temporary directory: a switch in dev must never touch the
  user's real claude sessions. *(Agent's call.)* Final does this itself: `final-verify.mjs --isolate-claude-config`
  starts its throwaway dev app with `CLAUDE_CONFIG_DIR` inside its store.
