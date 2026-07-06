# Skeleton Loading Tracker

Tracks cockpit surfaces that use the shared skeleton primitive for honest first-load states.

| Surface | Status | Notes |
| --- | --- | --- |
| Cockpit | Skipped | Live agent cards already have booting, working, asking, and empty states. Skeletons would obscure real process state. |
| Agent | Skipped | The center pane is a live terminal or transcript surface; use explicit terminal/status states instead. |
| Sessions | Implemented | First-load archive scan uses a list-shaped skeleton. |
| Diff | Implemented | Changed-file sidebar and selected diff pane use skeletons while git data loads. |
| Activity | Deferred | Needs a loaded-vs-empty atom before skeletons can be honest; `activityEventsAtom` currently starts as `[]`. |
| Channels | Deferred | Channel list/messages use existing loading text; add only if load delay is visible and state distinguishes loaded-empty. |
| Runs | Deferred | Run state uses explicit phase statuses; skeleton only fits initial channel-run load if needed. |
| Usage | Deferred | Needs a loaded flag; `usageStatsAtom` currently starts as an empty stats object and preserves last-good data on refresh errors. |
| Memory | Implemented | First-load vault scan uses list/detail skeletons. |
| Settings | Skipped | Settings are config-backed and should stay immediately readable; per-control pending states are enough. |

## Rules

- Skeletons are for `not loaded yet`, not for `loaded empty`.
- Do not use skeletons for live agent work, streaming transcript content, or long-running process state.
- Keep the primitive theme-token based; no raw colors and no new dependency.
- Future additions should first expose an honest loaded state if the surface cannot currently distinguish loading from empty.
