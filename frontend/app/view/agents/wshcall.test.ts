// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    firstWshCall,
    isCardKey,
    parseWshCalls,
    printsOnlyWsh,
    WSH_BOOL_FLAGS,
    wshJsonOutput,
    wshKey,
    type WshKey,
} from "./wshcall";

const keyOf = (cmd: string) => firstWshCall(cmd)?.key ?? null;

describe("wshKey", () => {
    const table: [string, WshKey][] = [
        ["wsh effort show e1", "effort-show"],
        ["wsh effort list", "effort-list"],
        ["wsh effort create Title", "effort-create"],
        ["wsh effort advance e1", "effort-advance"],
        ["wsh effort chunk status e1 3 done", "chunk-status"],
        ["wsh effort chunk add e1 title", "chunk-add"],
        ["wsh effort chunk note e1 3 text", "chunk-note"],
        ["wsh runs show r1", "runs-show"],
        ["wsh runs attention", "runs-attention"],
        ["wsh runs start plan.md", "runs-start"],
        ["wsh runs answer a1 yes", "runs-answer"],
        ["wsh jarvis dag status", "dag-status"],
        ["wsh jarvis dag submit plan.md", "dag-submit"],
        ["wsh jarvis dag planreview pass", "dag-planreview"],
        ["wsh jarvis dag review t-1 pass", "dag-review"],
        ["wsh jarvis dag final pass", "dag-final"],
        ["wsh jarvis dag answer a1 x", "dag-answer"],
        ["wsh jarvis dag tell t-1 x", "dag-tell"],
        ["wsh jarvis dag amend plan.md", "dag-amend"],
        ["wsh jarvis dag retry t-1", "dag-retry"],
        ["wsh jarvis dag forward a1", "dag-forward"],
        ["wsh jarvis dag escalate a1", "dag-escalate"],
        ["wsh jarvis dag merge t-1", "dag-merge"],
        ["wsh jarvis dag skip t-1", "dag-skip"],
        ["wsh jarvis dag sendback t-1 x", "dag-sendback"],
        ["wsh jarvis complete", "jarvis-complete"],
        ["wsh agents list", "agents-list"],
        ["wsh agents send tab hi", "agents-send"],
        ["wsh agents read tab", "agents-read"],
        ["wsh note add text", "note-add"],
        ["wsh jira show ABC-1", "jira-show"],
        ["wsh jira attachments SIEM-1748", "jira-attachments"],
        ["wsh brainstorm judge", "brainstorm-judge"],
        ["wsh ui reveal x", "ui-reveal"],
    ];
    it.each(table)("%s -> %s", (cmd, key) => {
        expect(keyOf(cmd)).toBe(key);
    });

    const changes = [
        ...["rename", "project", "ticket", "status", "unarchive", "link", "unlink", "delete", "reopen"].map(
            (v) => `wsh effort ${v} e1`
        ),
        ...["rename", "move", "remove", "stage", "owner", "attach", "detach"].map((v) => `wsh effort chunk ${v} e1 3`),
        ...["cancel", "end-final", "rerun-final", "land", "ack"].map((v) => `wsh runs ${v} r1`),
        "wsh jarvis dag cancel",
        "wsh jarvis dag goalpost x",
        "wsh note delete n1",
        "wsh brainstorm check",
        "wsh ui do x",
    ];
    it.each(changes)("%s -> other-change", (cmd) => {
        expect(keyOf(cmd)).toBe("other-change");
    });

    it("effort reopen is effort-level, its chunk a positional", () => {
        const first = firstWshCall("wsh effort reopen e1 3");
        expect(first?.key).toBe("other-change");
        expect(first?.call.path).toEqual(["effort", "reopen"]);
        expect(first?.call.args).toEqual(["e1", "3"]);
    });

    it("an unknown verb is null", () => {
        expect(wshKey(parseWshCalls("wsh effort frobnicate e1")[0])).toBeNull();
        expect(wshKey(parseWshCalls("wsh constructor")[0])).toBeNull();
        expect(firstWshCall("wsh frob")).toBeNull();
    });

    // a help call changes nothing, so it draws as the Bash step it is, never as "Amended" or "Plan submitted"
    it.each([
        "wsh jarvis dag amend --help 2>&1 | head -15",
        "wsh jarvis dag submit --help",
        "wsh effort chunk note -h",
        "wsh effort chunk --help 2>&1 | sed -n 1,30p; wsh effort chunk note --help 2>&1 | sed -n 1,20p",
        "wsh jarvis dag retry --help 2>&1 | head -20; wsh jarvis dag tell --help 2>&1 | head -12",
    ])("a help call has no key: %s", (cmd) => {
        expect(firstWshCall(cmd)).toBeNull();
    });

    it("a help call beside a real one keys the real one", () => {
        expect(keyOf("wsh jarvis dag submit --help; wsh jarvis dag submit --plan p.md")).toBe("dag-submit");
    });

    it("separates views from cards", () => {
        expect(isCardKey("effort-show")).toBe(false);
        expect(isCardKey("dag-status")).toBe(false);
        expect(isCardKey("jira-attachments")).toBe(false);
        expect(isCardKey("chunk-status")).toBe(true);
        expect(isCardKey("other-change")).toBe(true);
    });
});

describe("shell variable ids", () => {
    it.each([
        ['E=2bd27b27 && wsh effort chunk add $E "x"'],
        ['E=2bd27b27 && wsh effort chunk add ${E} "x"'],
        ['E=2bd27b27; wsh effort chunk add "$E" x'],
        ['export E=2bd27b27 && wsh effort chunk add $E "x"'],
        ["E=2bd27b27\nwsh effort chunk add $E x"],
        ["E=2bd27b27 wsh effort chunk add $E x"],
        ["P=2bd27b27; E=$P; wsh effort chunk add $E x"],
    ])("expands an earlier assignment: %s", (cmd) => {
        const first = firstWshCall(cmd);
        expect(first?.call.args).toEqual(["2bd27b27", "x"]);
        expect(first?.key).toBe("chunk-add");
    });

    it("a later assignment does not reach back", () => {
        const first = firstWshCall("wsh effort chunk add $E x; E=2bd27b27");
        expect(first?.key).toBe("other-change");
    });

    it.each([
        ['wsh effort chunk add $E "x"'],
        ["wsh effort chunk add ${E} x"],
        ["E=`wsh effort create T` && wsh effort chunk add $E x"],
        ["E=$(wsh effort create T) && wsh effort chunk add $E x"],
        ['E="$(wsh effort create T)" && wsh effort chunk add $E x'],
        ["E='a`b' && wsh effort chunk add $E x"],
    ])("an unresolved id is the generic change row: %s", (cmd) => {
        // the last call: a command substitution's own wsh call is parsed as a call too
        expect(wshKey(parseWshCalls(cmd).at(-1))).toBe("other-change");
    });

    it("an unresolved id on a view call yields no wsh key", () => {
        expect(firstWshCall("wsh effort show $E")).toBeNull();
        expect(firstWshCall("wsh runs show ${R}")).toBeNull();
        expect(firstWshCall("E=ok && wsh effort show $E")?.key).toBe("effort-show");
    });

    it("a commit substitution leaves jarvis complete resolved: the sha is shown, never fetched", () => {
        expect(firstWshCall("wsh jarvis complete --commit $(git rev-parse HEAD) --report C:/tmp/r.md")?.key).toBe(
            "jarvis-complete"
        );
        expect(firstWshCall("wsh jarvis complete --commit $SHA --report C:/tmp/r.md")?.key).toBe("jarvis-complete");
    });

    it("an unresolved fetch flag value is unresolved too", () => {
        expect(firstWshCall("wsh jarvis dag status --runid $R")).toBeNull();
        expect(firstWshCall("wsh jarvis dag review t-1 pass --channel=$C")?.key).toBe("other-change");
    });

    it("a single-quoted $ stays literal and resolved", () => {
        const first = firstWshCall("wsh effort chunk add '$E' x");
        expect(first?.key).toBe("chunk-add");
        expect(first?.call.args).toEqual(["$E", "x"]);
        expect(firstWshCall("E=abc && wsh effort chunk add 'a$E'\"$E\" x")?.call.args).toEqual(["a$Eabc", "x"]);
        expect(firstWshCall("wsh effort show '`id`'")?.key).toBe("effort-show");
    });

    it("a double-quoted $ still expands", () => {
        const first = firstWshCall('E=abc && wsh effort chunk add "$E" x');
        expect(first?.key).toBe("chunk-add");
        expect(first?.call.args).toEqual(["abc", "x"]);
    });

    it.each([
        ['wsh effort chunk note abc 3 --note "costs $5"', "chunk-note"],
        ["wsh effort chunk status abc 3 done --note=$N", "chunk-status"],
        ['wsh effort advance abc --note "$(date)"', "effort-advance"],
        ['wsh note add --body "see $HOME"', "note-add"],
    ])("a display-only flag holding $ leaves the call resolved (case %#)", (cmd, key) => {
        expect(keyOf(cmd)).toBe(key);
    });

    it("an id positional holding an unexpanded $X is unresolved", () => {
        expect(keyOf('wsh effort chunk note $X 3 --note "costs $5"')).toBe("other-change");
        expect(keyOf("wsh effort chunk add a$X x")).toBe("other-change");
    });
});

describe("parseWshCalls", () => {
    it("splits path, args and flags", () => {
        expect(parseWshCalls(`wsh effort chunk status "e1" 3 done --note "a && b"`)).toEqual([
            { path: ["effort", "chunk", "status"], args: ["e1", "3", "done"], flags: { note: "a && b" } },
        ]);
    });

    it("keeps quoted args with spaces whole", () => {
        const [call] = parseWshCalls(`wsh agents send tab 'hello there' "and \\"you\\""`);
        expect(call.args).toEqual(["tab", "hello there", 'and "you"']);
    });

    it("reads --note=x and --note x alike", () => {
        expect(parseWshCalls("wsh effort chunk note e1 3 --note=x")[0].flags).toEqual({ note: "x" });
        expect(parseWshCalls("wsh effort chunk note e1 3 --note x")[0].flags).toEqual({ note: "x" });
    });

    it.each([
        ["cd C:/x && wsh runs show r1", ["runs", "show"]],
        ["A=1 wsh runs show r1", ["runs", "show"]],
        ["A=1 B='x y' wsh runs show r1", ["runs", "show"]],
        ["C:/bin/wsh.exe runs show r1", ["runs", "show"]],
        ["./wsh runs show r1", ["runs", "show"]],
        ["wsh runs show r1 2>&1 | head -5", ["runs", "show"]],
        ["if true; then wsh runs show r1; fi", ["runs", "show"]],
        ["for x in a; do wsh runs show r1; done", ["runs", "show"]],
    ])("finds the call in %s", (cmd, path) => {
        const calls = parseWshCalls(cmd);
        expect(calls).toHaveLength(1);
        expect(calls[0].path).toEqual(path);
        expect(calls[0].args).toEqual(["r1"]);
    });

    it.each([
        ["wsh jarvis complete --hold-land report.md", "hold-land", ["report.md"]],
        ["wsh agents send --wait tab-1 hi", "wait", ["tab-1", "hi"]],
        ["wsh jarvis dag merge --continue t-3", "continue", ["t-3"]],
        ["wsh runs cancel --yes r1", "yes", ["r1"]],
    ])("a boolean flag never takes the next word: %s", (cmd, flag, args) => {
        const [call] = parseWshCalls(cmd);
        expect(call.flags[flag]).toBe(true);
        expect(call.args).toEqual(args);
    });

    it("every boolean flag leaves the next word a positional", () => {
        for (const flag of WSH_BOOL_FLAGS) {
            expect(parseWshCalls(`wsh runs show --${flag} r1`)[0]).toEqual({
                path: ["runs", "show"],
                args: ["r1"],
                flags: { [flag]: true },
            });
        }
    });

    it("two calls joined by && are two calls; firstWshCall takes the first keyed one", () => {
        const cmd = "wsh frob x && wsh effort show e1 && wsh runs show r1";
        expect(parseWshCalls(cmd).map((c) => c.path)).toEqual([["frob"], ["effort", "show"], ["runs", "show"]]);
        const first = firstWshCall(cmd);
        expect(first?.key).toBe("effort-show");
        expect(first?.call.args).toEqual(["e1"]);
    });

    it.each([
        `echo "wsh runs start"`,
        "grep wsh file",
        "echo wsh runs start",
        "cat <<'EOF'\nwsh runs start plan.md\nEOF",
        "cat <<-EOF > out.txt\n\twsh runs start plan.md\n\tEOF",
        "# wsh runs start\nls",
    ])("no call in %s", (cmd) => {
        expect(parseWshCalls(cmd)).toEqual([]);
        expect(firstWshCall(cmd)).toBeNull();
    });

    it("a call after a heredoc body still counts", () => {
        expect(keyOf("cat <<'EOF' > x\nwsh runs start\nEOF\nwsh runs show r1")).toBe("runs-show");
    });

    it("firstWshCall of nothing is null", () => {
        expect(firstWshCall(undefined)).toBeNull();
        expect(firstWshCall("")).toBeNull();
    });
});

describe("printsOnlyWsh", () => {
    // census specimens 45, 50, 63 (wsh's own output) and 108 (a sed after the wsh call prints the file)
    const s45 =
        'E=b758746d-5105-4456-b80a-d73acc8ccffb && \\\nwsh effort chunk status $E "Compare /swarm with the engine on the resource-management replay" done --note "Report: ~/arc-bench/plan-skill-2026-11-17/arc-vs-swarm.md (raw data in swarm-final/, mutation/). Swarm hit account quota at 24 min: 10 files +1.4k, nothing wired, no verifier added (its skill says 1 per 2-4 workers), workers moved to Sonnet against its own model rule. Arc arms f371fd9d/23076bcc: full spec in ~95 min, \\$25-27 list, Final first try. jobobject mutation: swarm 0.65 (82), plan 1.00 (21), writing-plans 0.79 (38). No contamination either side. Swarm tree committed as found: b535aaf44 on bench/resource-swarm." >/dev/null && \\\nwsh effort chunk note $E "Decide: bench delegated cheap-model exploration before the lead plans?" --note "The swarm coordinator handed code mapping to one explorer (19 turns, ~4 min) and briefed workers from its report; first implementers at 9 min vs 16-19 for Arc. Lead exploration is 66% of plan-phase cost (\\$3.40/run, 46 turns; memory lead-plan-phase-cost-breakdown), which already says cheaper-model exploration trades quality and needs a bench. The swarm run never finished, so it shows the shape, not plan quality." >/dev/null && \\\nwsh effort chunk note $E "Decide: keep a worker\'s conversation when escalating its model?" --note "Swarm switched two quota-stopped workers to another model with their conversations kept; both finished. Arc\'s dag escalate --model starts a fresh worker. Rare in Arc: 7 \'last turn failed\' wakes in 30 days over 1,006 worker spawns (packaged store, 11-18). Low priority." >/dev/null && \\\nwsh effort chunk status $E "Decide: rerun a full swarm once Antigravity quota resets (~11-25)?" deferred --note "Account quota exhausted 11-18 10:16 (resets in ~167h). A finished run is the only way to see verifiers, integration and merges, which this run never reached. Setup to reuse: worktree from d82662791 with the spec copied in, prompt in swarm-prompt.txt, preset Turbo (Auto\'s sandbox denies git in a linked worktree), App launched with --remote-debugging-port=9333." >/dev/null && \\\nwsh effort chunk status $E "Decide: bench delegated cheap-model exploration before the lead plans?" active >/dev/null && wsh effort show $E 2>&1 | head -30';
    const s50 =
        "wsh effort chunk note effort:25e5eb18-863e-4e80-b585-60124822822b 1 --note \"Design approved 2026-11-16: docs/superpowers/specs/2026-11-16-slim-superpowers-design.md (brainstorm .superpowers/brainstorm/slim-superpowers). Engine plugin-off override lands first; then Arc's own brainstorm skill, arc:plan + Arc's copy of writing-plans behind a per-run Settings choice (whole contract per skill), superpowers off. Bench gets its own plan after a couple of weeks of use.\" 2>&1 | tail -1";
    const s63 =
        'E=effort:f2ce52d6-4889-4be7-8258-39348ddd83bf; wsh effort chunk add $E "Decide: the transcript\'s Mockup card drops its live board for one row: topic, boards, updated, Open canvas, Mark (proposed)" --at 6 && wsh effort chunk note $E "Decide: the transcript\'s Mockup card drops its live board for one row: topic, boards, updated, Open canvas, Mark (proposed)" --note "11-18: MockupCard (renderedbsboards.tsx, da2e7e071) predates the pane; with the Canvas tab open the same board renders live twice and the poller reloads both. Its Open canvas and Mark already open the pane tab. Keep a row, not nothing: a canvas reveal does not open the tab, so the card is what tells the transcript a mockup appeared or was redrawn." && wsh effort chunk add $E "Decide: the brainstorm question card drops its boards block; option board chips open the pane at that board (proposed)" --at 7 && wsh effort chunk note $E "Decide: the brainstorm question card drops its boards block; option board chips open the pane at that board (proposed)" --note "11-18: the pane\'s Brainstorm tab renders the full BrainstormPane, boards included, so useQuestionBoards/LiveBoards in the question card duplicates it. The question and options stay in the transcript: the composer answers them." && wsh effort show $E';
    const s108 =
        'cd "C:/Users/kael02/IdeaProjects/SIEM/src/cyber_ai/cyber_anomaly_detector" && wsh effort chunk status 7ea571f2-62cc-4fee-878f-1e525cf6b86a "LLM 1: one verdict rubric (real = attack step shown, succeeded or not, however common; benign = identified, not an attack; cannot_tell = not identified) plus attack_result and scope enums on finish" active --note "11-18: user approved doing all five chunks; starting 1, 2, 4 together (all edit investigation_goal.py), then 3, then 5" >/dev/null; sed -n 130,246p src/services/hypothesis/investigation_goal.py';

    it.each([
        ["specimen 45", s45],
        ["specimen 50", s50],
        ["specimen 63", s63],
        ["a cd before the call", "cd repo && wsh effort show e1"],
        ["a stage filtering wsh's output", "wsh effort list 2>&1 | head -30"],
        ["a prefixed call", "time wsh effort show e1 > out.txt"],
    ])("true for %s", (_, cmd) => {
        expect(printsOnlyWsh(cmd)).toBe(true);
    });

    it.each([
        ["specimen 108", s108],
        ["a pipeline started by another command", "cat plan.md | wsh effort show e1"],
        ["a command after ;", "wsh effort show e1; ls"],
        ["a command after ||", "wsh effort show e1 || echo failed"],
        ["no wsh call", "cd repo && E=1"],
        ["an empty command", ""],
        ["no command", undefined],
    ])("false for %s", (_, cmd) => {
        expect(printsOnlyWsh(cmd)).toBe(false);
    });
});

describe("wshJsonOutput", () => {
    const cmd = "wsh effort show e1 --json";
    it("parses the output of a --json call that exited 0", () => {
        expect(wshJsonOutput<{ id: string }>(cmd, '{"id":"e1"}', 0)).toEqual({ id: "e1" });
    });
    it("is null without --json, on a nonzero or missing exit, or for bad JSON", () => {
        expect(wshJsonOutput("wsh effort show e1", '{"id":"e1"}', 0)).toBeNull();
        expect(wshJsonOutput(cmd, '{"id":"e1"}', 1)).toBeNull();
        expect(wshJsonOutput(cmd, '{"id":"e1"}', undefined)).toBeNull();
        expect(wshJsonOutput(cmd, "Effort e1: not json", 0)).toBeNull();
    });
});
