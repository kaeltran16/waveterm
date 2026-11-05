# Surface review on real data

A review pass uses one area of the app on a copy of the packaged Arc's store and reads the code behind it, to
find what fixtures and code reading alone miss. The Brief's 11-04 review (`3a462a716`) is the model: ten
findings, all landed, each covered by a CDP scenario.

## The snapshot app

```
node scripts/cdp/snapshot-dev.mjs
```

Each start makes a fresh copy under `%LOCALAPPDATA%\arc-snap` and runs `task dev` on it, on the main dev
app's ports (CDP `:9222`, Vite `:5174`); it refuses while another dev app holds them. Ctrl-C stops it.

| Copied from `%LOCALAPPDATA%\dev.arc.app` | How |
|---|---|
| `data/db/waveterm.db`, `filestore.db` | `VACUUM INTO`, a consistent read while Arc writes |
| `data/jarvis`, `data/memhygiene` | copied |
| `config/` | copied; `memory:vaultpath` points at the vault copy |
| the vault | copied without `.git`, so nothing commits or pushes |

Not copied: the WebView2 profile (a fresh one under the copy), and `~/.claude`, which Sessions and Usage read
live.

`ARC_SNAPSHOT=1` makes wavesrv:

- skip the boot work that reaches outside the copy: cleanup-debt retry, vault sync, run and brainstorm resume,
  the watchdog, the loose-end and memory-hygiene sweeps, and remote mode (`cmd/server/main-server.go`);
- start a block's process only when its cwd is inside `arc-snap\scratch` (`pkg/blockcontroller`): every other
  cwd in the copy is a real checkout;
- refuse Jira writes; reads and the search POST go through (`pkg/jira/client.go`);
- run agent sync (launch-time steering and skills) and skill adoption as dry runs, since both would write the
  real harness homes in `~` (`wshserver_agentsync.go`).

A refused process start is logged in `arc-snap\data\waveapp.log` (`snapshot store: not starting a process`),
but the UI does not show it yet: the terminal opens on its old scrollback, or a launched agent reads
"working".

Not guarded: actions that call a model directly (a run's judge, a consult, a brainstorm judge) spend tokens,
and agents launched in the snapshot write their transcripts to the real `~/.claude/projects`. With the watchdog
off, runs stay frozen as they were copied, so a review sees a run's state but not its progress.

## What a snapshot cannot show

- **The user's live agents.** They are processes in the packaged Arc, so the roster starts empty: Live, Jump
  and every live-agent state come only from agents the pass launches itself.
- **Live runs.** No copied run has a lead or workers. A run's workers get worktrees outside `scratch`, which
  the guard refuses, so run cards are reviewed from the code unless a run can be made to work in the scratch
  project (untested).

## A pass

One agent per area, on a fresh snapshot. The areas and their status are the initiative "Surface review on
real data".

1. **List every feature from the code**, not from the screen: the area's bindings in
   `frontend/app/store/keybindings/bindings.ts`, every button, menu and context menu in its components, the
   states its model can be in, and its scenarios in `scripts/cdp/scenarios-*.mjs`.
2. **Use each feature over CDP on the real data** (`scripts/cdp/attach.mjs`: `goto`, `ev`, `rpc`, `shot`),
   and ask of each:
   - Does it show something without helping act on it?
   - Did using it mean going elsewhere or remembering something?
   - Is a label, count or number wrong, or meaningless to the user?
   - Does it look right by `DESIGN.md`? Check colors against the `@theme` tokens (a raw color opts out of
     every theme), spacing rhythm, alignment, hierarchy, and consistency with sibling surfaces. Check clipping,
     overlap and wrapping at both 1000x700 and 1600x950. A finding of this kind is `visual` and needs a
     screenshot; name the token or `DESIGN.md` rule it breaks.
3. **Read each feature's code** and report:
   - bugs and unhandled states;
   - states the code handles that no UI reaches;
   - features the UI offers that the code half-supports;
   - places where the UI and the code disagree.

   A usage finding with a cause in the code names the `file:line`.
4. **Stay inside the copy.**
   - Launch agents only through the app's New agent flow, with a cwd under `arc-snap\scratch` (a throwaway git
     repo there, registered as a project in the copy), on Haiku or Sonnet, at most 3.
   - The first launch in a new scratch folder stops at Claude's folder-trust prompt, which only its terminal
     can answer.
   - Never send to an agent the pass did not launch, and close the ones it did before reporting.
   - Never use `wsh` from the reviewer's shell: it talks to the packaged Arc, not the snapshot.
   - Run no CDP scenario that writes fixtures outside the copy (the `scenarios-sessions*` ones write into
     `~/.claude/projects`).
   - The app is one window: two reviewers cannot drive it at once. A second pass can do steps 1 and 3 while
     the first drives it.

## The report

Written to `cdp-shots/review/<area>/report.md`, with its screenshots beside it (gitignored). A subagent cannot
write the report file, so it returns the report as text and the session that dispatched it saves it:

- **Features:** every feature from step 1, each marked tried, or skipped with the reason.
- **Findings:** each with the question it fails or the code defect, what was seen (a screenshot or the code),
  the cause's `file:line` when known, and a suggested fix.

The user picks which findings to fix; they land in one commit per area, each with a CDP scenario. A declined
or deferred finding goes to `docs/deferred.md`.
