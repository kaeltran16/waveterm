# Obsidian Session-End Logger — Design + Implementation

## What

A `SessionEnd` hook that automatically appends a structured summary of each Claude Code session to today's Obsidian daily note. Zero manual trigger words required.

## Design

### Hook

Add a second entry to `SessionEnd` in `~/.claude/settings.json`. The existing `agent_status_reporter.py` entry stays untouched:

```json
{
  "type": "command",
  "command": "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\kael02\\.claude\\scripts\\session-end-log.mjs\""
}
```

### Script: `~/.claude/scripts/session-end-log.mjs`

**Input env vars:**
- `CLAUDE_TRANSCRIPT_PATH` — path to the session JSONL
- `CLAUDE_CWD` — working directory at session start (fallback for project name)

**Extraction logic:**
| Field | Source |
|---|---|
| Time | Local HH:MM at hook fire |
| Project | Last segment of `cwd` from first transcript entry with that field |
| Branch | First `gitBranch` field found in any transcript entry |
| Duration | `timestamp` diff: first entry → last entry, formatted as `Xm` |
| Task | Text of first `human`-type message, trimmed to 100 chars |
| Changed | Unique `file_path` values from `Edit`/`Write` tool_use inputs (max 5, then `+N more`) |
| Outcome | Last non-empty `text` content block from the last `assistant` entry, trimmed to 120 chars |

**Output format** appended under `## Session Log` in `YYYY-MM-DD.md`:

```markdown
- HH:MM — **project (branch)** · Xm · task-trimmed-to-100-chars
  - Changed: `file1.ts`, `file2.ts`
  - Outcome: last assistant closing sentence
```

If no files were changed, the `Changed` line is omitted. If the transcript is unreadable (empty, corrupt), the hook exits silently — never errors.

**Daily note path:** `C:\Users\kael02\IdeaProjects\obsidian\Work\YYYY-MM-DD.md`

The `## Session Log` section is created if absent. The daily note file is created if absent.

### No-op conditions

The script skips writing if:
- The session has zero human messages (e.g., subagent sessions, hook-only sessions)
- The transcript file is missing or empty

## Implementation

1. Create `C:\Users\kael02\.claude\scripts\session-end-log.mjs`
2. Edit `~/.claude/settings.json` — add the node hook to `SessionEnd`
3. Manual smoke-test: run the script directly against a known transcript path
