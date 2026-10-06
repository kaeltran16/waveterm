---
name: cockpit-runs
description: Use when you need to start an Arc run (quick, or orchestrator from a goal or a plan file), check on or cancel a run, or see what is waiting on the user — via `wsh runs`; or message a live agent tab and read its answer — via `wsh agents`.
---

# Arc runs from the command line

`wsh runs` does what the cockpit's + Run launcher and run sheet do. `wsh runs <cmd> --help` has every flag.

- `wsh runs start "<goal>"` or `wsh runs start --plan <plan.md>`: a plan implies an orchestrator run.
  `--effort <id> --chunk <label|n>` attaches it to an initiative chunk (ids from `wsh effort list`).
- `wsh runs list` shows this project's top-level runs; `--tasks` adds the runs that work one task of another.
- `wsh runs show <run-id>` shows status, route, commits, the task digest and the sealed report.
- `wsh runs answer <run-id> '<answers-json>'` answers the run's own pending question (a lead's AskUserQuestion), which `wsh runs show` prints with numbered options.
- `wsh runs cancel <run-id>` cancels a run.
- `wsh runs attention` lists everything waiting on the user, across every project.

Message a live agent (claude or pi) with `wsh agents`:

- `wsh agents list` shows the live agent tabs, with a tab prefix and each one's state.
- `wsh agents send <tab> "<text>"` hands the agent a prompt; `--file <path>` reads the text from a file, `--wait` blocks until it has answered.
- `wsh agents read <tab>` prints the agent's last answer.

Rules:
- A launch can take minutes. If `start` reports no reply, the run may have started anyway:
  `wsh runs list` first, and start it again only when it is not there. A retry is a second full run.
- The project is the git repository you are in; a worktree resolves to its main checkout. It must be
  a project in the cockpit already, otherwise pass `--channel <id>`.
- The lead route is the project's saved route unless you pass `--runtime`/`--model`. Pass one only
  when the user asked for it.
- `cancel` stops live workers, so it asks for `--yes` when there are any. Cancel only a run the user
  asked you to stop. A finished run cannot be cancelled.
- Steer one task of a run (asks, approve, retry, merge, message a worker) with `wsh jarvis dag <cmd>
  --channel <id> --runid <run-id>`. A lead spawning a child of its own run uses `wsh jarvis run`.
- For follow-up work on something a finished run did, look for that run's agent in `wsh agents list`
  first. When its tab is live, send it the follow-up and read the answer; start a new run only when
  no live agent holds that context. The target answers in its own turn and the sender reads it, so a
  target does not send a message back.
- Starting a run does not call for showing it: the user sees it in the cockpit already, and a reveal
  takes them off the surface they are working on. Run `wsh ui reveal run:<id>` only when the user asks
  to see the run.
