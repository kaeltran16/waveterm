# Arc

An agent cockpit for driving and supervising coding agents. Arc began as a fork of
[Wave Terminal](https://github.com/wavetermdev/waveterm) and keeps its terminal, layout, and
`wshrpc` foundations, but the desktop shell has been rebuilt on Tauri and the UI has been
rebuilt around agent supervision rather than terminal multiplexing.

**Status: personal project, not accepting contributions.** No releases, no download page, no
support channel. Windows-only.

## What it does

Arc surfaces the coding agents running on your machine — live transcript narration, answering
agent questions in place, run/outcome tracking, repo radar, and a memory layer — in a single
focused pane. External Claude Code agents report in through hooks and reporters that live
outside this repo (under `~/.claude`); see `docs/agents/`.

## Layout

Three layers, all part of the running app:

| Layer | Where | What |
| --- | --- | --- |
| Tauri shell | `src-tauri/` (Rust) | Native host; spawns `wavesrv`, owns the borderless window |
| Backend | `cmd/`, `pkg/` (Go) | `wavesrv` object store + HTTP + websocket RPC; `wsh` CLI helper |
| Frontend | `frontend/` (React 19, Vite, Tailwind 4, jotai) | The cockpit UI |

## Building

Requires [Task](https://taskfile.dev), Go, Rust, Node, and the [Zig](https://ziglang.org/)
compiler (CGO static linking).

```sh
task init          # first-time setup
task dev           # run the dev app
task build:backend && npm run build   # packaged build -> NSIS installer
```

`CLAUDE.md` is the working reference for build commands, architecture, and gotchas — it is
kept current, and is more reliable than this file for day-to-day work.

## Documentation

- `CLAUDE.md` — architecture, build flow, gotchas
- `docs/` — design specs, plans, and reference notes (see `docs/README.md`)

## License

Apache-2.0, inherited from Wave Terminal. Upstream copyright is retained in `NOTICE`;
dependency licenses are listed in [ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md).
