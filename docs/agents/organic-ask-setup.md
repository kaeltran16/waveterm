# Organic AskUserQuestion — Wave panel integration

When a Claude Code agent calls its built-in `AskUserQuestion` tool, this hook
intercepts the call, routes the question into Wave's Agents panel, blocks until
the human answers there, and returns the answer to the agent. The terminal
prompt never renders; the agent resumes as if the user typed the answer inline.

## How it works

A Claude Code PreToolUse hook fires before `AskUserQuestion` executes. The hook
script (`docs/agents/ask-hook.js`) calls `wsh ask` with the question payload,
which blocks until the Agents panel receives an answer. The hook then returns
that answer to Claude Code as a `permissionDecision: "deny"` response with the
answer text as the reason — the contract CC uses to inject a human reply without
showing the interactive prompt.

On any failure (not running inside a Wave block, `wsh` unavailable, RPC error,
etc.) the hook prints nothing and exits 0, which causes CC to fall back to the
normal terminal prompt. It is safe to leave the hook registered unconditionally.

The hook logic is versioned in this repo. Only the registration snippet below
lives outside it.

## Setup

### 1. Register the hook

Add to your project's `.claude/settings.json` **or** your user-level
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<ABSOLUTE-PATH-TO>/docs/agents/ask-hook.js\"",
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

`timeout` is in seconds. 3600 (1 hour) gives the human time to respond before
CC gives up and times out the hook.

The `command` must be an absolute path to the in-repo hook script. Examples:

- **Windows:** `node "C:\\Users\\you\\waveterm\\docs\\agents\\ask-hook.js"`
- **POSIX:** `node "/home/you/waveterm/docs/agents/ask-hook.js"`

The `command` runs through your system shell, so `node` must be on `PATH`.

**Claude Code loads hooks at startup.** After editing `settings.json`, restart the
`claude` session (or start a new one) — a running session won't pick up the new hook.

### 2. Open the Agents panel in Wave

Launch your agent from a Wave terminal block. The Agents panel surfaces the
question automatically when the hook fires.

## Behavior notes

- Fires even when the agent runs with `--dangerously-skip-permissions`.
- The answer surfaces in the agent's transcript framed as an `Error:`-prefixed
  line — that is just how CC renders a `deny` reason. It is expected; the model
  reads it correctly as the human's reply and continues.
- If multiple questions are batched in a single `AskUserQuestion` call, the full
  array is forwarded to `wsh ask` as-is.
- **Non-goal:** bare prose questions — where the agent ends its turn with a
  question in text without calling `AskUserQuestion` — are not caught. Only
  explicit `AskUserQuestion` tool calls are intercepted.
