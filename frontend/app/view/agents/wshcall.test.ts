// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { firstWshCall, isCardKey, parseWshCalls, WSH_BOOL_FLAGS, wshJsonOutput, wshKey, type WshKey } from "./wshcall";

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

    it("an unresolved flag value is unresolved too", () => {
        expect(firstWshCall("wsh effort chunk note e1 3 --note $N")?.key).toBe("other-change");
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
