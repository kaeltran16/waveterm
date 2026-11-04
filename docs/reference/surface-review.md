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
- refuse Jira writes; reads and the search POST go through (`pkg/jira/client.go`).

Not guarded: actions that call a model directly (a run's judge, a consult, a brainstorm judge) spend tokens.
With the watchdog off, runs stay frozen as they were copied, so a review sees a run's state but not its
progress.

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
3. **Read each feature's code** and report:
   - bugs and unhandled states;
   - states the code handles that no UI reaches;
   - features the UI offers that the code half-supports;
   - places where the UI and the code disagree.

   A usage finding with a cause in the code names the `file:line`.
4. **Stay inside the copy.** Launch agents and runs only with a cwd under `arc-snap\scratch`. Never send to an
   existing agent. Never use `wsh`: it talks to the packaged Arc, not the snapshot.

## The report

Written to `cdp-shots/review/<area>/report.md`, with its screenshots beside it (gitignored):

- **Features:** every feature from step 1, each marked tried, or skipped with the reason.
- **Findings:** each with the question it fails or the code defect, what was seen (a screenshot or the code),
  the cause's `file:line` when known, and a suggested fix.

The user picks which findings to fix; they land in one commit per area, each with a CDP scenario. A declined
or deferred finding goes to `docs/deferred.md`.
