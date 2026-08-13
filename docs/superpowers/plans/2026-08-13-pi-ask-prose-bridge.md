# Pi Ask Prose Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a pi agent inside a Wave block settles with a bare-prose question (no `ask_user_question` tool call), project the same asking card the tool path produces — parsed chips + free-text input — and deliver answers by typing text into the block terminal.

**Architecture:** The pi extension (`pi/extensions/waveterm-ask.ts`) tracks the finalized last assistant message (`message_end`) and classifies it at true turn end (`agent_settled`) via a new pure module `waveterm-prose-core.ts`; on a hit it projects through the existing ask pipeline (`wsh ask --prose` → `AskCommand` → `agent:ask` event → AnswerBar). Answers arrive via the existing `AnswerAgentCommand` → `DeliverAnswer`, with a new prose branch that types text + Enter (no picker arrows — prose has no native picker). A `prose` flag threads through `CommandAskData` → `PendingAsk` → `AgentAskData` so the FE submits chip labels as text answers. Card cleared on the next `agent_start`.

**Tech Stack:** pi extensions (TS, pi event API), Go (`pkg/wshrpc`, `pkg/agentask`, `pkg/baseds`, `cmd/wsh`), React/jotai cockpit FE, vitest + Go tests. Spec: `docs/superpowers/specs/2026-08-13-pi-ask-prose-bridge-design.md`.

## Global Constraints

- `pi/extensions/*.ts` is the source of truth; `cmd/wsh/cmd/pi-*-extension.ts` are **generated** by `task sync:piartifacts` — never hand-edit the `cmd/wsh/cmd/pi-*` copies.
- `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go` are **generated** by `task generate` — never hand-edit them.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json` (bare `npx tsc` stack-overflows on this repo). Baseline is clean — any error is yours.
- Bare `go test ./pkg/...` fails to build 6 packages (sqlite-vec CGO header). Set `CGO_CFLAGS` with a **Windows-style** path (`C:/Users/...`, not `/c/Users/...`):
  `export CGO_CFLAGS="-O2 -g -IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc"` (use the worktree's own path if in a worktree).
- Commits only with explicit user approval (AGENTS.md). Commit scope: only the files this plan touched — check `git status --short` unscoped first; other sessions share this tree.
- Comments explain "why", never "what". No new design tokens / SCSS.
- If executing in a worktree: `task build:backend` builds into the **worktree's** `dist/bin`; the running dev app spawns from the main repo's `dist/bin` — rebuild in the main repo before live verification.
- Never run `prettier --write` on `scripts/**/*.mjs` (2-space reindent gotcha) — not touched here, listed for safety.

---

### Task 1: Prose classifier core

**Files:**
- Create: `pi/extensions/waveterm-prose-core.ts`
- Create: `pi/extensions/waveterm-prose-core.test.ts`

**Interfaces:**
- Consumes: nothing (pure TS, no imports — house pattern for `*core.ts` modules).
- Produces: `detectProseQuestion(lastAssistantText: string): ProseQuestion | null` and types `ProseQuestion = { question: string; options?: ProseOption[] }`, `ProseOption = { label: string; description?: string }`. Consumed by Task 5.

- [ ] **Step 1: Write the failing test** — `pi/extensions/waveterm-prose-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectProseQuestion } from "./waveterm-prose-core";

describe("detectProseQuestion", () => {
    it("returns null for a settled turn with no question", () => {
        expect(detectProseQuestion("The build failed because X.\n\nAll done.")).toBeNull();
    });

    it("returns null when the last paragraph does not end with a question mark", () => {
        expect(detectProseQuestion("Should I try X? Anyway, all done.")).toBeNull();
    });

    it("detects a plain trailing question with no options", () => {
        const r = detectProseQuestion("The build failed because X.\n\nDoes A sound right, or do you want B/C?");
        expect(r?.question).toBe("Does A sound right, or do you want B/C?");
        expect(r?.options).toBeUndefined();
    });

    it("extracts Approach-style option paragraphs into chips", () => {
        const text = [
            "Approach A: Backend default for agent-session blocks.",
            "Approach B: Launcher-side opt-in.",
            "Approach C: A plus background retention sweep.",
            "",
            "Does A sound right, or do you want B/C?",
        ].join("\n");
        const r = detectProseQuestion(text);
        expect(r?.question).toBe("Does A sound right, or do you want B/C?");
        expect(r?.options).toEqual([
            { label: "Approach A", description: "Backend default for agent-session blocks." },
            { label: "Approach B", description: "Launcher-side opt-in." },
            { label: "Approach C", description: "A plus background retention sweep." },
        ]);
    });

    it("extracts A)-style list lines into chips", () => {
        const text = "A) red\nB) green\nC) blue\n\nWhich one?";
        const r = detectProseQuestion(text);
        expect(r?.question).toBe("Which one?");
        expect(r?.options).toEqual([
            { label: "A", description: "red" },
            { label: "B", description: "green" },
            { label: "C", description: "blue" },
        ]);
    });

    it("extracts dash bullets into chips", () => {
        const text = "- red\n- green\n\nPick one?";
        const r = detectProseQuestion(text);
        expect(r?.options).toEqual([{ label: "red" }, { label: "green" }]);
    });

    it("returns no chips for a single option", () => {
        const r = detectProseQuestion("A) only one\n\nQuestion?");
        expect(r?.question).toBe("Question?");
        expect(r?.options).toBeUndefined();
    });

    it("caps options at 4", () => {
        const lines = ["A) one", "B) two", "C) three", "D) four", "E) five", "", "Which?"];
        expect(detectProseQuestion(lines.join("\n"))?.options).toHaveLength(4);
    });

    it("ignores list-like lines inside fenced code blocks", () => {
        const text = ["Pick one?", "", "```", "- fake option A", "- fake option B", "```"].join("\n");
        const r = detectProseQuestion(text);
        expect(r?.question).toBe("Pick one?");
        expect(r?.options).toBeUndefined();
    });

    it("misses a question followed by a trailing code fence (pinned v1 limitation)", () => {
        const r = detectProseQuestion("Does this work?\n\n```\ncode\n```");
        expect(r).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run pi/extensions/waveterm-prose-core.test.ts`
Expected: FAIL with "Cannot find module './waveterm-prose-core'".

- [ ] **Step 3: Implement the classifier** — `pi/extensions/waveterm-prose-core.ts`:

```ts
// Pure helpers for the prose-question bridge. No external imports so the repo's vitest
// can cover it. The default export is a no-op: pi auto-loads every file in the extensions
// directory, and this module is a dependency, not an extension.

export interface ProseOption {
    label: string;
    description?: string;
}

export interface ProseQuestion {
    question: string;
    options?: ProseOption[];
}

// Fences are stripped only for the option scan: "- item" lines inside code would otherwise
// read as choices. The question candidate deliberately uses the RAW text (see below).
const FENCE_RE = /```[\s\S]*?```/g;

// paragraphs splits on blank lines and returns non-empty, trimmed paragraphs.
function paragraphs(text: string): string[] {
    return text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
}

// optionScan collects 2-4 chip candidates: "Approach A:"-style paragraph headers (label
// "Approach A", description = the rest of the paragraph), "A)" / "B." / "C:" lines, and
// "- " bullets. De-duplicated by label, capped at 4.
function optionScan(text: string): ProseOption[] {
    const cleaned = text.replace(FENCE_RE, "");
    const options: ProseOption[] = [];
    const seen = new Set<string>();
    const push = (o: ProseOption) => {
        if (seen.has(o.label) || options.length >= 4) {
            return;
        }
        seen.add(o.label);
        options.push(o);
    };
    for (const p of cleaned.split(/\n\s*\n/)) {
        const m = /^([A-Za-z]+)\s+([A-Z]):\s*(.*)$/s.exec(p.trim());
        if (m) {
            push({ label: `${m[1]} ${m[2]}`, description: m[3].trim() || undefined });
        }
    }
    for (const line of cleaned.split("\n")) {
        const t = line.trim();
        const m = /^([A-Z])[).:]\s*(.+)$/.exec(t);
        if (m) {
            push({ label: m[1], description: m[2] });
        } else if (t.startsWith("- ")) {
            push({ label: t.slice(2) });
        }
    }
    return options;
}

// detectProseQuestion classifies the final assistant text of a settled turn. v1 rule: the
// LAST paragraph of the RAW text must end with "?" (a trailing code fence therefore misses
// — pinned limitation). Options ride along when 2-4 are found anywhere in the message.
export function detectProseQuestion(lastAssistantText: string): ProseQuestion | null {
    const ps = paragraphs(lastAssistantText);
    if (ps.length === 0) {
        return null;
    }
    const question = ps[ps.length - 1];
    if (!question.endsWith("?")) {
        return null;
    }
    const options = optionScan(lastAssistantText);
    return { question, options: options.length >= 2 ? options : undefined };
}

export default function wavetermProseCore(): void {
    // no-op dependency module
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run pi/extensions/waveterm-prose-core.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit** (with user approval — AGENTS.md)

```bash
git add pi/extensions/waveterm-prose-core.ts pi/extensions/waveterm-prose-core.test.ts
git commit -m "feat(pi): prose question classifier core"
```

---

### Task 2: Backend `prose` flag plumbing

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_ask.go` (`CommandAskData`)
- Modify: `pkg/agentask/agentask.go` (`PendingAsk`)
- Modify: `pkg/baseds/baseds.go` (`AgentAskData`)
- Modify: `pkg/wshrpc/wshserver/wshserver_ask.go` (`AskCommand`)
- Modify: `cmd/wsh/cmd/wshcmd-ask.go` (`--prose` flag)
- Test: `pkg/wshrpc/wshserver/wshserver_ask_test.go`
- Generated (via `task generate`, never hand-edited): `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `CommandAskData.Prose bool` (json `prose`), `PendingAsk.Prose bool`, `AgentAskData.Prose bool` (json `prose,omitempty`), `wsh ask --prose` flag. Consumed by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing test** — append to `pkg/wshrpc/wshserver/wshserver_ask_test.go`:

```go
func TestAskCommandThreadsProse(t *testing.T) {
	ws := &WshServer{}
	oref := waveobj.MakeORef("block", uuid.NewString()).String()
	agentask.GlobalRegistry = agentask.MakeRegistry()
	data := askData(oref, false)
	data.Prose = true
	if _, err := ws.AskCommand(context.Background(), data); err != nil {
		t.Fatalf("ask: %v", err)
	}
	pending, ok := agentask.GlobalRegistry.Get(oref)
	if !ok || !pending.Prose {
		t.Fatalf("want prose pending ask, got %+v (ok=%v)", pending, ok)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from the repo root, with the CGO_CFLAGS from Global Constraints):
`go test ./pkg/wshrpc/wshserver/ -run TestAskCommandThreadsProse`
Expected: FAIL to compile — `data.Prose` undefined.

- [ ] **Step 3: Add the field to `CommandAskData`** — `pkg/wshrpc/wshrpctypes_ask.go`, after the `Wait` field:

```go
	// Prose marks a projected bare-prose question (pi prose bridge): the answer is typed
	// into the block terminal as text (no native picker to drive with arrow keys).
	Prose bool `json:"prose,omitempty"`
```

- [ ] **Step 4: Add the field to `PendingAsk`** — `pkg/agentask/agentask.go`, after `Ts`:

```go
	// Prose mirrors CommandAskData.Prose: delivery types text instead of picker keystrokes.
	Prose bool
```

- [ ] **Step 5: Add the field to `AgentAskData`** — `pkg/baseds/baseds.go`, after `Cleared`:

```go
	// Prose marks a projected bare-prose question (pi prose bridge); the FE submits chip
	// labels as text answers instead of picker indexes.
	Prose bool `json:"prose,omitempty"`
```

- [ ] **Step 6: Thread it through `AskCommand`** — `pkg/wshrpc/wshserver/wshserver_ask.go`. In the `GlobalRegistry.Set` call add `Prose: data.Prose,` after `Ts: ts,`, and in the `publishAgentAsk` call add `Prose: data.Prose,` after `Ts: ts,`.

- [ ] **Step 7: Add the `--prose` flag to `wsh ask`** — `cmd/wsh/cmd/wshcmd-ask.go`. Add a package-level `var askProse bool`; in `init()` after the `--questions-json` flag line:

```go
	askCmd.Flags().BoolVar(&askProse, "prose", false, "mark the ask as a projected prose question (pi prose bridge)")
```

In `askRun`, change the `AskCommand` call to add `Prose: askProse,` after `Wait: askWait,`.

- [ ] **Step 8: Regenerate bindings**

Run: `task generate`
Expected: no errors; `git status` shows `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go` modified (prose field appears in the TS `CommandAskData` type). `AgentAskData` in `frontend/types/gotypes.d.ts` now has `prose?: boolean;`.

- [ ] **Step 9: Run the tests**

Run: `go test ./pkg/wshrpc/wshserver/ ./pkg/agentask/ ./cmd/wsh/...` (with CGO_CFLAGS)
Expected: PASS, including the new `TestAskCommandThreadsProse`. Note: `go test ./cmd/wsh/...` needs `task build:backend` equivalents? No — `go test` compiles packages directly; the generated `wshclient.go` change compiles fine.

Also run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean (baseline is clean; the new optional fields break nothing).

- [ ] **Step 10: Commit** (with user approval)

```bash
git add pkg/wshrpc/wshrpctypes_ask.go pkg/agentask/agentask.go pkg/baseds/baseds.go pkg/wshrpc/wshserver/wshserver_ask.go pkg/wshrpc/wshserver/wshserver_ask_test.go cmd/wsh/cmd/wshcmd-ask.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts pkg/wshrpc/wshclient/wshclient.go
git commit -m "feat(agentask): thread prose flag through ask pipeline"
```

---

### Task 3: Prose delivery branch

**Files:**
- Modify: `pkg/agentask/encode.go` (add `proseTextKeys`)
- Modify: `pkg/agentask/deliver.go` (add `deliverProseAnswer`, branch in `DeliverAnswer`)
- Test: `pkg/agentask/deliver_test.go`, `pkg/agentask/encode_test.go`

**Interfaces:**
- Consumes: `PendingAsk.Prose` (Task 2), existing `sendInput` seam, `KeystrokeDelay`, `typeBytes`, `validateFreeText`, `enter` (all already in `pkg/agentask`).
- Produces: `deliverProseAnswer(pending PendingAsk, answers []baseds.AgentAnswerItem) ([][]byte, error)` — the keys `DeliverAnswer` injects for prose asks.

- [ ] **Step 1: Write the failing tests** — append to `pkg/agentask/deliver_test.go`:

```go
func prosePending() PendingAsk {
	return PendingAsk{AskId: "p1", BlockId: "b1", Prose: true, Questions: oneQuestion()}
}

func TestDeliverAnswer_ProseTypesText(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", prosePending())
	var got [][]byte
	orig := sendInput
	sendInput = func(blockId string, data []byte) error { got = append(got, data); return nil }
	defer func() { sendInput = orig }()

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{Text: "B"}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	// prose: raw text + enter, NO arrow prefix
	if len(got) != 2 || string(got[0]) != "B" || got[1][0] != enter {
		t.Fatalf("want [B, enter], got %q", got)
	}
}

func TestDeliverAnswer_ProseResolvesIndexToLabel(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", prosePending())
	var got [][]byte
	orig := sendInput
	sendInput = func(blockId string, data []byte) error { got = append(got, data); return nil }
	defer func() { sendInput = orig }()

	delivered, err := DeliverAnswer("tab:t1", "", []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}})
	if err != nil || !delivered {
		t.Fatalf("want (true,nil), got (%v,%v)", delivered, err)
	}
	if len(got) != 2 || string(got[0]) != "B" {
		t.Fatalf("want typed label B, got %q", got)
	}
}

func TestDeliverAnswer_ProseRejectsInvalidAnswers(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("tab:t1", prosePending())
	cases := [][]baseds.AgentAnswerItem{
		{{Text: ""}},                    // empty text, no index
		{{Text: "a\x01b"}},              // control char
		{{SelectedIndexes: []int{9}}},   // out of range
		{{SelectedIndexes: []int{0, 1}}}, // multi-select shape
		{},                             // no answers
	}
	for _, answers := range cases {
		GlobalRegistry = MakeRegistry()
		GlobalRegistry.Set("tab:t1", prosePending())
		if _, err := DeliverAnswer("tab:t1", "", answers); err == nil {
			t.Fatalf("want error for answers %+v", answers)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/agentask/ -run 'TestDeliverAnswer_Prose'`
Expected: FAIL to compile — `deliverProseAnswer` undefined (or: prose asks fall into `EncodeAnswer` and `encodeSingleQuestion` rejects `Text` + `SelectedIndexes` mixes / produces arrows — either way the assertions fail).

- [ ] **Step 3: Add `proseTextKeys`** — `pkg/agentask/encode.go`, after `freeTextKeys`:

```go
// proseTextKeys types a prose answer verbatim into the block terminal: no picker exists
// for a projected prose question, so unlike freeTextKeys there is no arrow prefix — just
// the text and an enter to submit it as the next user message.
func proseTextKeys(text string) [][]byte {
	keys := make([][]byte, 0, len([]rune(text))+1)
	keys = append(keys, typeBytes(text)...)
	return append(keys, []byte{enter})
}
```

- [ ] **Step 4: Add `deliverProseAnswer` and branch `DeliverAnswer`** — `pkg/agentask/deliver.go`. Add after `DeliverAnswer`:

```go
// deliverProseAnswer encodes a prose ask's answer as plain terminal text. Prose asks have
// no native picker, so an index answer resolves to the option label and the text is typed
// verbatim (text + enter). Error semantics match EncodeAnswer: no keystrokes are produced
// on failure, so the caller can restore the pending ask and retry safely.
func deliverProseAnswer(pending PendingAsk, answers []baseds.AgentAnswerItem) ([][]byte, error) {
	if len(pending.Questions) != 1 {
		return nil, fmt.Errorf("prose ask expects exactly one question, got %d", len(pending.Questions))
	}
	if len(answers) != 1 {
		return nil, fmt.Errorf("prose ask expects exactly one answer, got %d", len(answers))
	}
	a := answers[0]
	text := a.Text
	if text == "" {
		if len(a.SelectedIndexes) != 1 {
			return nil, fmt.Errorf("prose answer must be text or a single option index")
		}
		idx := a.SelectedIndexes[0]
		opts := pending.Questions[0].Options
		if idx < 0 || idx >= len(opts) {
			return nil, fmt.Errorf("selected index %d out of range (%d options)", idx, len(opts))
		}
		text = opts[idx].Label
	}
	if err := validateFreeText(text); err != nil {
		return nil, err
	}
	return proseTextKeys(text), nil
}
```

Then in `DeliverAnswer`, replace the encode block:

```go
	keys, err := EncodeAnswer(pending.Questions, answers)
```

with:

```go
	var keys [][]byte
	if pending.Prose {
		keys, err = deliverProseAnswer(pending, answers)
	} else {
		keys, err = EncodeAnswer(pending.Questions, answers)
	}
```

(Keep the waiter lookup above exactly as-is — prose never registers a waiter, so it is a miss and falls through.)

- [ ] **Step 5: Add the `proseTextKeys` unit test** — append to `pkg/agentask/encode_test.go`:

```go
func TestProseTextKeysTypesVerbatimNoArrows(t *testing.T) {
	keys := proseTextKeys("B")
	if len(keys) != 2 || string(keys[0]) != "B" || keys[1][0] != enter {
		t.Fatalf("want [B enter], got %q", keys)
	}
}
```

- [ ] **Step 6: Run the tests**

Run: `go test ./pkg/agentask/`
Expected: PASS — new prose tests plus the existing suite (claim semantics, CC arrow path regression, waiter path).

- [ ] **Step 7: Commit** (with user approval)

```bash
git add pkg/agentask/encode.go pkg/agentask/encode_test.go pkg/agentask/deliver.go pkg/agentask/deliver_test.go
git commit -m "feat(agentask): prose answer delivery types text into the terminal"
```

---

### Task 4: Frontend prose awareness

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (`AgentAsk` + `prose`; `withAsk`; `buildAskAnswers`)
- Modify: `frontend/app/view/agents/agents.tsx` (`submitAnswer` call site)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

**Interfaces:**
- Consumes: generated `AgentAskData.prose?: boolean` (Task 2), existing `withAsk`, `buildAskAnswers`.
- Produces: `AgentAsk.prose?: boolean` on the VM; `buildAskAnswers(questions, selections, texts?, prose?)` with a prose branch. Consumed by the AnswerBar path (unchanged) and `agents.tsx`.

- [ ] **Step 1: Write the failing tests** — append to `frontend/app/view/agents/agentsviewmodel.test.ts`:

```ts
describe("buildAskAnswers prose", () => {
    const q = (): AgentAskQuestion => ({ question: "q", options: [{ label: "a" }, { label: "b" }] });

    it("submits the chip label as text", () => {
        expect(buildAskAnswers([q()], { 0: new Set([1]) }, {}, true)).toEqual([{ text: "b" }]);
    });

    it("lets typed text win over a chip", () => {
        expect(buildAskAnswers([q()], { 0: new Set([1]) }, { 0: "  custom  " }, true)).toEqual([
            { text: "custom" },
        ]);
    });

    it("emits empty text for an unanswered prose question", () => {
        expect(buildAskAnswers([q()], {}, {}, true)).toEqual([{ text: "" }]);
    });

    it("keeps index answers when prose is off", () => {
        expect(buildAskAnswers([q()], { 0: new Set([1]) })).toEqual([{ selectedindexes: [1] }]);
    });
});

describe("withAsk prose", () => {
    it("maps the prose flag onto the VM ask", () => {
        const vm = agentVMFromInput({ id: "t1", name: "pi", state: "idle" } as never);
        const out = withAsk(vm, { oref: "block:x", askid: "a1", prose: true, questions: [] } as never, 0);
        expect(out.ask?.prose).toBe(true);
    });
});
```

Note: check the existing `agentVMFromInput` factory signature in this test file first (it may take a partial `LiveAgentInput`; if `as never` fights the type, mirror how the existing `withAsk` tests construct the VM — grep `describe("withAsk"` in the test file and reuse its fixture).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: FAIL — `buildAskAnswers` ignores the 4th arg (chips become `selectedindexes`), and `prose` is not on the VM ask type.

- [ ] **Step 3: Implement** — `frontend/app/view/agents/agentsviewmodel.ts`:

1. In `export interface AgentAsk`, add after `replySuggestions`:

```ts
    prose?: boolean; // projected prose question (pi bridge): chips submit as text answers
```

2. In `withAsk`, inside the returned `ask:` object, add after `oref: ask.oref,`:

```ts
            prose: ask.prose,
```

3. Change `buildAskAnswers` (line ~608) to:

```ts
export function buildAskAnswers(
    questions: AgentAskQuestion[],
    selections: Record<number, Set<number>>,
    texts: Record<number, string> = {},
    prose = false
): AgentAnswerItem[] {
    return questions.map((_, qi) => {
        const text = (texts[qi] ?? "").trim();
        if (text !== "") {
            return { text };
        }
        if (prose) {
            // prose cards have no native picker: a chip click means "type this label".
            const idxs = Array.from(selections[qi] ?? []);
            if (idxs.length !== 1) {
                return { text: "" };
            }
            return { text: questions[qi].options?.[idxs[0]]?.label ?? "" };
        }
        return { selectedindexes: Array.from(selections[qi] ?? []).sort((a, b) => a - b) };
    });
}
```

4. In `frontend/app/view/agents/agents.tsx` `submitAnswer`, change the RPC call line to pass the flag:

```ts
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers: buildAskAnswers(qs, sel, txt, agent.ask?.prose ?? false) }));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (existing suites + the new prose suites).

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 5: Commit** (with user approval)

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts frontend/app/view/agents/agents.tsx
git commit -m "feat(cockpit): prose asks submit chip labels as text answers"
```

---

### Task 5: Extension wiring

**Files:**
- Modify: `pi/extensions/waveterm-ask.ts` (full rewrite — it is small; the installer copies it wholesale)

**Interfaces:**
- Consumes: `detectProseQuestion` (Task 1), `buildAskPayload` (existing, `waveterm-ask-core.ts`), `wsh ask --prose` (Task 2).
- Produces: the prose bridge behavior — `message_end` capture, `agent_settled` projection, `agent_start` clear. The generated `cmd/wsh/cmd/pi-ask-extension.ts` copy is refreshed in Task 6.

- [ ] **Step 1: Rewrite `pi/extensions/waveterm-ask.ts`** with the existing mirror plus the prose bridge (full file):

```ts
// pi extension: the Wave ask mirror (workstream F) + prose-question bridge (2026-08-13).
// Installed by `wsh install-agent-hooks` into ~/.pi/agent/extensions/waveterm-ask.ts with
// __WSH_PATH__ substituted for the absolute wsh path.
//
// Part 1 — ask mirror: does NOT register a tool and does NOT block. The
// @juicesharp/rpiv-ask-user-question package owns the single `ask_user_question` tool and
// its TUI questionnaire is the answer surface (registering a second `ask_user_question`
// would make pi hard-fail on the duplicate name). On `tool_call` we push the questions to
// the panel with a NON-waiting `wsh ask` (the card renders; no waiter is registered), and
// on `tool_result` we clear it with `wsh ask --clear`. Answering in the panel then takes
// the existing backend keystroke-injection path (pkg/agentask deliver.go): the panel click
// types down-arrows/enter into this block's terminal, driving the rpiv questionnaire to
// select the answer itself. Answering in the TUI completes the questionnaire directly and
// the clear hides the card.
//
// Part 2 — prose bridge: a turn that SETTLES with a bare-prose question (no tool call)
// projects the same card via `wsh ask --prose`; answers are typed as text into the
// terminal (no picker exists). The card clears on the next `agent_start` — answered,
// typed-in-terminal, or ignored, every outcome ends it.
//
// Outside a Wave block nothing runs at all.
import { buildAskPayload } from "./waveterm-ask-core";
import { detectProseQuestion } from "./waveterm-prose-core";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

// toolCallIds with a live panel mirror, so tool_result clears exactly the ask this call raised.
const mirroredToolCalls = new Set<string>();

// Prose-bridge turn state (one extension instance per pi process):
//   lastAssistantText — text blocks of the most recent finalized assistant message
//     (`message_end` fires for user/toolResult messages too; only assistant ones count).
//   turnUsedAskTool — the settled turn called ask_user_question: skip prose projection,
//     the tool already produced a card (a trailing "does that work?" flourish must not
//     double-card).
//   proseCardLive — a prose card is projected; the next agent_start clears it exactly once.
let lastAssistantText: string | null = null;
let turnUsedAskTool = false;
let proseCardLive = false;

// textBlocksOf joins the text content blocks of a finalized message. thinking/toolCall
// blocks never carry the question the human must read.
function textBlocksOf(message: any): string {
    if (!Array.isArray(message?.content)) {
        return "";
    }
    return message.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
}

function clearProseCard(pi: any, wshPath: string): void {
    if (!proseCardLive) {
        return;
    }
    proseCardLive = false;
    pi.exec(wshPath, ["ask", "--clear"]).catch(() => {});
}

function projectProseCard(pi: any, wshPath: string): void {
    if (turnUsedAskTool || !lastAssistantText) {
        return;
    }
    const q = detectProseQuestion(lastAssistantText);
    if (!q) {
        return;
    }
    const payload = buildAskPayload([{ question: q.question, options: q.options ?? [] }]);
    proseCardLive = true;
    // fire-and-forget so a slow wsh never blocks pi's settle; a failed projection just
    // leaves the question in the terminal (the pre-bridge behavior).
    pi.exec(wshPath, ["ask", "--prose", "--questions-json", payload]).catch(() => {
        proseCardLive = false;
    });
}

export function registerAskMirror(pi: any, wshPath: string): void {
    pi.on("tool_call", (event: any) => {
        if (event?.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
            return undefined;
        }
        turnUsedAskTool = true;
        // Bare pi outside a Wave block: no panel to mirror to.
        if (!process.env.WAVETERM_BLOCKID) {
            return undefined;
        }
        const questions = event?.input?.questions;
        if (!Array.isArray(questions) || questions.length === 0) {
            return undefined;
        }
        mirroredToolCalls.add(event.toolCallId);
        const payload = buildAskPayload(questions);
        // fire-and-forget so the mirror can never delay the questionnaire; the card landing a
        // beat after the TUI prompt is fine (it is an attention surface, not the answer one).
        pi.exec(wshPath, ["ask", "--questions-json", payload]).catch(() => {
            mirroredToolCalls.delete(event.toolCallId);
        });
        return undefined; // rpiv's questionnaire runs and owns the tool result
    });
    pi.on("tool_result", (event: any) => {
        if (!mirroredToolCalls.has(event.toolCallId)) {
            return;
        }
        mirroredToolCalls.delete(event.toolCallId);
        pi.exec(wshPath, ["ask", "--clear"]).catch(() => {});
    });
    pi.on("message_end", (event: any) => {
        if (event?.message?.role === "assistant") {
            lastAssistantText = textBlocksOf(event.message);
        }
    });
    pi.on("agent_settled", () => {
        projectProseCard(pi, wshPath);
        lastAssistantText = null;
        turnUsedAskTool = false;
    });
    pi.on("agent_start", () => {
        clearProseCard(pi, wshPath);
        lastAssistantText = null;
        turnUsedAskTool = false;
    });
    pi.on("session_shutdown", () => {
        clearProseCard(pi, wshPath);
        lastAssistantText = null;
        turnUsedAskTool = false;
    });
}

export default function wavetermAsk(pi: any): void {
    registerAskMirror(pi, "__WSH_PATH__");
}
```

- [ ] **Step 2: Typecheck the extension**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: clean. (The extension is included in the FE tsconfig via the pi/ paths — if it is not covered by the project tsconfig, verify with `npx tsc --noEmit pi/extensions/waveterm-ask.ts --skipLibCheck --moduleResolution bundler --module esnext --target es2022` as a fallback syntax gate.)

- [ ] **Step 3: Commit** (with user approval)

```bash
git add pi/extensions/waveterm-ask.ts
git commit -m "feat(pi): project prose questions as asking cards at turn settle"
```

---

### Task 6: Provisioning (sync + installhooks + package.json)

**Files:**
- Modify: `Taskfile.yml` (`sync:piartifacts` task, around :181-205)
- Modify: `cmd/wsh/cmd/wshcmd-installhooks.go` (embed + template var + install write)
- Modify: `pi/package.json` (`pi.extensions` array)
- Generated: `cmd/wsh/cmd/pi-prose-core-extension.ts` (via sync)

**Interfaces:**
- Consumes: `pi/extensions/waveterm-prose-core.ts` (Task 1), updated `pi/extensions/waveterm-ask.ts` (Task 5).
- Produces: the generated `pi-prose-core-extension.ts` copy, embedded into `wsh` and written to `~/.pi/agent/extensions/` by `install-agent-hooks`, and the `pi/package.json` extension entry — the bridge actually loads in a running pi.

- [ ] **Step 1: Add the sync copy** — `Taskfile.yml`, inside `sync:piartifacts` (mirror the existing `waveterm-ask-core.ts` line, :191):

```yaml
            - cmd: cp pi/extensions/waveterm-prose-core.ts cmd/wsh/cmd/pi-prose-core-extension.ts
```

And add to the task's `sources:` list (after the `waveterm-ask-core.ts` line, :198) and `generates:` list (after `pi-ask-core-extension.ts`, :205):

```yaml
            - pi/extensions/waveterm-prose-core.ts
```

```yaml
            - cmd/wsh/cmd/pi-prose-core-extension.ts
```

(Check the exact list shapes around :181-205 and mirror them — `sources` and `generates` are the file lists that drive Task's up-to-date fingerprint.)

- [ ] **Step 2: Embed + install the new core** — `cmd/wsh/cmd/wshcmd-installhooks.go`:

1. After the existing embed lines (~:296):

```go
//go:embed pi-prose-core-extension.ts
var piProseCoreExtensionTemplate string
```

2. In `installPiAskExtension`, after the `waveterm-ask-core.ts` write (after :430):

```go
	if err := os.WriteFile(filepath.Join(dir, "waveterm-prose-core.ts"), []byte(piProseCoreExtensionTemplate), 0o644); err != nil {
		return fmt.Errorf("writing waveterm-prose-core.ts: %w", err)
	}
```

- [ ] **Step 3: Add the package entry** — `pi/package.json`, in `pi.extensions` after `"./extensions/waveterm-ask-core.ts"`:

```json
            "./extensions/waveterm-prose-core.ts"
```

- [ ] **Step 4: Run the sync and verify**

Run: `task sync:piartifacts`
Expected: creates `cmd/wsh/cmd/pi-prose-core-extension.ts` and updates `cmd/wsh/cmd/pi-ask-extension.ts` (Task 5's wiring). Verify the generated ask file matches the source:
`diff <(sed 's/__WSH_PATH__/X/g' pi/extensions/waveterm-ask.ts) <(sed 's/__WSH_PATH__/X/g' cmd/wsh/cmd/pi-ask-extension.ts)` → identical; same check for prose-core.

- [ ] **Step 5: Build + test**

Run: `task build:backend`
Expected: builds; the new embed compiles. Then run `go test ./cmd/wsh/...` (with CGO_CFLAGS) and `go vet ./cmd/wsh/...` — expected PASS/clean.

- [ ] **Step 6: Commit** (with user approval)

```bash
git add Taskfile.yml cmd/wsh/cmd/wshcmd-installhooks.go cmd/wsh/cmd/pi-ask-extension.ts cmd/wsh/cmd/pi-prose-core-extension.ts pi/package.json
git commit -m "feat(pi): provision prose bridge core into pi extensions"
```

---

### Task 7: Full verification + live round-trip

**Files:** none (verification only).

- [ ] **Step 1: Full unit suites**

Run:
```bash
npx vitest run
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
export CGO_CFLAGS="-O2 -g -IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc"
go test ./pkg/agentask/... ./pkg/wshrpc/wshserver/ ./cmd/wsh/...
```
Expected: all PASS / clean. Baseline was clean before this plan; any failure is from these tasks.

- [ ] **Step 2: Reinstall hooks + restart pi**

Run: `wsh install-agent-hooks` (via the freshly built `dist/bin/wsh`), then restart any pi session in Wave (pi loads extensions at startup).
Expected: `~/.pi/agent/extensions/waveterm-prose-core.ts` exists; pi session starts without extension load errors.

- [ ] **Step 3: Live round-trip checklist** (needs `task dev` running + a pi session in a Wave block; requires user participation or a second pi session):

- [ ] End a turn with "Does A sound right, or do you want B/C?" preceded by `Approach A:` / `Approach B:` / `Approach C:` paragraphs → the cockpit shows an asking card with three chips + text input; the agent appears in the asking roster.
- [ ] Click a chip → the answer text arrives in the pi session as the next user message; the card clears.
- [ ] A turn ending with a statement (no `?`) → no card.
- [ ] A turn that calls `ask_user_question` → exactly one card (the tool's), no prose double-card.
- [ ] Dismiss (✕) on a prose card → card clears; nothing is typed into the terminal.

- [ ] **Step 4: Report + summarize** — report results to the user with the commit list and any residual risks (e.g. classifier false negatives from the pinned fence limitation).

---

## Self-Review

**Spec coverage:**
- §4 classifier rules → Task 1 (all rules + pinned fence limitation + code-fence option guard).
- §5 extension wiring (message_end/agent_settled/agent_start/session_shutdown, AUQ guard, fire-and-forget, WAVETERM_BLOCKID no-op) → Task 5.
- §6 wshrpc prose flag (CommandAskData, PendingAsk, AgentAskData, AskCommand, wsh --prose, task generate) → Task 2.
- §7 delivery (deliverProseAnswer: single question/answer, text-or-index resolution, validateFreeText, proseTextKeys no-arrows, KeystrokeDelay via existing loop, waiter path untouched) → Task 3.
- §8 FE (AgentAsk.prose, withAsk mapping, buildAskAnswers prose branch, agents.tsx call site, answerbar untouched) → Task 4.
- §9 lifecycle table → Task 5 (clear-on-agent_start) + Task 7 checklist (dismiss, no-question turn, AUQ single card).
- §11 testing (vitest classifier, Go delivery, FE buildAskAnswers, provisioning sync, live round-trip) → Tasks 1/3/4/6/7.
- §12 sequencing (classifier → plumbing → delivery → FE → wiring → provisioning → live) → Tasks 1-7 in order.

**Placeholder scan:** no TBD/TODO; every code step contains full code. The `as never` cast in Task 4's withAsk test is flagged with a fallback instruction rather than left vague.

**Type consistency:** `ProseQuestion`/`ProseOption` (Task 1) match `buildAskPayload`'s input shape `{question, options: [{label, description}]}` (options required in the payload call — `q.options ?? []`); `detectProseQuestion` → Task 5 uses `q.question`/`q.options`. `CommandAskData.Prose`/`PendingAsk.Prose`/`AgentAskData.Prose` all `bool` (json `prose`), threaded in Task 2 steps 3-7 and read in Tasks 3 (`pending.Prose`) / 4 (`ask.prose`) / 5 (`--prose` flag → `data.Prose`). `deliverProseAnswer(pending, answers)` signature matches its Task 3 definition and call site. `buildAskAnswers(qs, sel, txt, prose)` 4-arg signature matches the agents.tsx call. `proseTextKeys` returns `[][]byte` with `enter` last, asserted in both tests.
