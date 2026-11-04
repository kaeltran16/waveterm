# Claude Code mods and Arc's skills

How the Claude Code mods and Arc's own skills travel from this repo into every agent launch. In all cases
the repo folder named below is the source; the build and launch overwrite every copy.

## The three mods

`task sync:claudemod` (run by every dev and backend build) copies each mod, minus tests, into
`cmd/wsh/cmd/`, where `wsh` embeds it. `wsh install-agent-hooks` writes it to `~/.arc/<name>` and lists
that folder in `env.CLAUDE_CODE_PLUGIN_DIRS` of `~/.claude/settings.json`, so every claude launch loads it.

| Source | Embed | Installed to | Role |
| --- | --- | --- | --- |
| `claude/arc-mod/` | `claude-mod` | `~/.arc/claude-mod` | The arc mod. Pure logic in `hooks/*-core.ts`, tested by vitest. Check with `claude plugin validate claude/arc-mod`. |
| `claude/arc-view-mod/` | `claude-view-mod` | `~/.arc/claude-view-mod` | Draws the transcript rows of prompts the arc mod submits. |
| `claude/arc-skim-mod/` | `claude-skim-mod` | `~/.arc/claude-skim-mod` | Highlights a reply's must-read sentences (based on ttqteo/claude-skim). |

- **arc-view-mod must stay its own plugin:** Claude Code never runs a plugin's `ui.render` hook on a row
  that plugin raised. `claude plugin test` does not apply that rule, so judge a drawn row in a live session.
- **arc-skim-mod's options:** two `/config` rows (`arc-skim.highlight`, `arc-skim.dim`), read from the
  options the engine loads the mod with, since `$.config.list()` at a parallel session start can miss a
  plugin's rows. Arc's Settings > Skim writes the same `pluginConfigs` entry in `~/.claude/settings.json`
  (`pkg/claudemod`), and Claude Code reloads the mod with the new options in every running session.

## Arc's skills

Arc's own skills live in `skills/` (brainstorm, cockpit, design, initiatives, notes, runs), embedded into
`wavesrv` by `skills/skills.go`. Every agent-sync apply (each agent launch) seeds them into the vault's
skills root, which then projects them into each harness's skills dir, except Claude Code's:
`task sync:claudemod` also copies them into the arc mod, so Claude Code lists them as `arc:<skill>` and
agent-sync keeps them out of `~/.claude/skills`.

- A skill's `.arc/` delta directory in the vault is kept, but does not reach the plugin copies.
- **Renaming a shipped skill:** add the old name to `retiredShipped` (`pkg/agentsync/skills.go`), since
  nothing else marks a vault copy as Arc's.
- `pi/skills/arc-dev` belongs to the pi package and stays there.
