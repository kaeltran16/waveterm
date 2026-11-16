import { describe, expect, it } from "vitest";
import type { AgentActionEntry, AgentEntry } from "./agentsviewmodel";
import { layoutTranscript, stepTitle, type LayoutItem } from "./transcriptlayout";

const T0 = 1_000_000;
const S = 1000;

const user = (text: string, ts?: number): AgentEntry => ({ kind: "user", text, ts });
const prose = (text: string, ts?: number): AgentEntry => ({ kind: "message", text, ts });
const read = (target: string, ts?: number): AgentActionEntry => ({
    kind: "action",
    verb: "read",
    target,
    outcome: "ok",
    ts,
});
function bash(
    command: string,
    o: { ts?: number; exit?: number; pending?: boolean; description?: string } = {}
): AgentActionEntry {
    const base: AgentActionEntry = { kind: "action", verb: "ran", target: o.description ?? command, command, ts: o.ts };
    if (o.pending) {
        return { ...base, pending: true, startedTs: o.ts };
    }
    const exit = o.exit ?? 0;
    return {
        ...base,
        outcome: exit === 0 ? "ok" : "fail",
        durationMs: 200,
        detail: { kind: "bash", command, output: "", exit },
    };
}
function edit(path: string, adds: number, dels: number, verb = "edited"): AgentActionEntry {
    return {
        kind: "action",
        verb,
        target: path,
        detail: { kind: "edit", files: [{ path, badge: "M", adds, dels, lines: [] }] },
    };
}

const kinds = (items: LayoutItem[]) => items.map((i) => i.kind);
const stepsItems = (items: LayoutItem[]) =>
    items.filter((i): i is Extract<LayoutItem, { kind: "steps" }> => i.kind === "steps");

const CHUNK_DONE = 'wsh effort chunk status "$E" 3 done --note "retry fixed"';

describe("layoutTranscript folds", () => {
    const turn: AgentEntry[] = [
        user("fix it", T0),
        read("a.ts", T0 + 2 * S),
        read("b.ts", T0 + 3 * S),
        bash("npm test", { ts: T0 + 4 * S }),
        read("c.ts", T0 + 5 * S),
        prose("done", T0 + 41 * S),
    ];

    it("folds a finished turn's four steps with the time from the prompt to the reply", () => {
        const items = layoutTranscript(turn, { active: false });
        expect(kinds(items)).toEqual(["user", "steps", "message"]);
        const [stretch] = stepsItems(items);
        expect(stretch.startIndex).toBe(1);
        expect(stretch.steps.map((s) => s.index)).toEqual([1, 2, 3, 4]);
        expect(stretch.fold?.durationMs).toBe(41 * S);
    });

    it("keeps a two-step stretch a box", () => {
        const items = layoutTranscript([user("go", T0), read("a.ts", T0 + S), read("b.ts", T0 + 2 * S), prose("ok")], {
            active: false,
        });
        expect(stepsItems(items)[0].fold).toBeNull();
    });

    it("keeps the live turn's stretches open while active and folds them once it is not", () => {
        const live = turn.slice(0, 5);
        expect(stepsItems(layoutTranscript(live, { active: true }))[0].fold).toBeNull();
        expect(stepsItems(layoutTranscript(live, { active: false }))[0].fold).not.toBeNull();
    });

    it("folds an earlier turn while the agent works on a later one", () => {
        const entries = [...turn, user("again", T0 + 50 * S), read("d.ts"), read("e.ts"), read("f.ts")];
        const [earlier, current] = stepsItems(layoutTranscript(entries, { active: true }));
        expect(earlier.fold).not.toBeNull();
        expect(current.fold).toBeNull();
    });

    it("folds a stretch with no times or commands, its duration unknown", () => {
        // a Codex projection: no ts, no command
        const codex: AgentEntry[] = [
            user("go"),
            { kind: "action", verb: "ran", target: "ls", outcome: "ok" },
            { kind: "action", verb: "ran", target: "cat a", outcome: "ok" },
            { kind: "action", verb: "edited", target: "a.py" },
            prose("ok"),
        ];
        const [stretch] = stepsItems(layoutTranscript(codex, { active: false }));
        expect(stretch.fold).not.toBeNull();
        expect(stretch.fold?.durationMs).toBeUndefined();
        expect(stretch.steps.map((s) => s.wsh)).toEqual([null, null, null]);
    });

    it("ends the duration at the last step's end when nothing follows", () => {
        const entries = [
            user("go", T0),
            bash("a", { ts: T0 + S }),
            bash("b", { ts: T0 + 2 * S }),
            bash("c", { ts: T0 + 3 * S }),
        ];
        const [stretch] = stepsItems(layoutTranscript(entries, { active: false }));
        expect(stretch.fold?.durationMs).toBe(3 * S + 200);
    });

    it("sums a mixed stretch's +/- and failures and names its kinds in first-appearance order", () => {
        const entries: AgentEntry[] = [
            user("go"),
            bash("node test.js", { exit: 1 }),
            read("a.js"),
            edit("retry.js", 3, 1),
            bash("node test.js"),
            read("b.js"),
            edit("retry.js", 2, 0),
            bash("git commit"),
            prose("ok"),
        ];
        const fold = stepsItems(layoutTranscript(entries, { active: false }))[0].fold!;
        expect(fold.adds).toBe(5);
        expect(fold.dels).toBe(1);
        expect(fold.failed).toBe(1);
        // inserted values in first-appearance order: 3 commands, 2 files read, the one edited file named
        const commands = fold.phrase.indexOf("3");
        const files = fold.phrase.indexOf("2");
        const named = fold.phrase.indexOf("retry.js");
        expect(commands).toBeGreaterThanOrEqual(0);
        expect(files).toBeGreaterThan(commands);
        expect(named).toBeGreaterThan(files);
        expect(fold.phrase).not.toContain("a.js");
    });
});

describe("layoutTranscript wsh calls", () => {
    it("draws a successful change call as a card that splits the stretch", () => {
        const entries = [user("go"), read("a"), read("b"), bash(CHUNK_DONE), read("c"), prose("ok")];
        const items = layoutTranscript(entries, { active: false });
        expect(kinds(items)).toEqual(["user", "steps", "card", "steps", "message"]);
        const card = items[2] as Extract<LayoutItem, { kind: "card" }>;
        expect(card.index).toBe(3);
        expect(card.step.wsh?.key).toBe("chunk-status");
        expect(card.step.wsh?.call.args).toEqual(["$E", "3", "done"]);
        expect(card.step.wsh?.call.flags.note).toBe("retry fixed");
    });

    it("keeps a failed change call a failed step", () => {
        const items = layoutTranscript([user("go"), read("a"), bash(CHUNK_DONE, { exit: 1 }), read("c")], {
            active: false,
        });
        expect(kinds(items)).toEqual(["user", "steps"]);
        const step = stepsItems(items)[0].steps[1];
        expect(step.status).toBe("fail");
        expect(step.wsh?.key).toBe("chunk-status");
    });

    it("keeps a change call marked is_error without a detail a failed step", () => {
        const failed: AgentActionEntry = {
            kind: "action",
            verb: "ran",
            target: CHUNK_DONE,
            command: CHUNK_DONE,
            outcome: "fail",
        };
        expect(kinds(layoutTranscript([failed], { active: false }))).toEqual(["steps"]);
    });

    it("keeps a pending change call a running step", () => {
        const items = layoutTranscript([user("go"), bash(CHUNK_DONE, { pending: true, ts: T0 })], { active: true });
        expect(kinds(items)).toEqual(["user", "steps"]);
        expect(stepsItems(items)[0].steps[0].status).toBe("running");
    });

    it("keeps a read-only call a step with its view key", () => {
        const items = layoutTranscript([bash("wsh effort show e1 --json")], { active: false });
        expect(stepsItems(items)[0].steps[0].wsh?.key).toBe("effort-show");
    });
});

describe("layoutTranscript statuses and Arc messages", () => {
    it("marks a pending action followed by an interruption stopped", () => {
        const items = layoutTranscript([bash("npm run release", { pending: true }), { kind: "interrupted" }], {
            active: false,
        });
        expect(stepsItems(items)[0].steps[0].status).toBe("stopped");
    });

    it("turns a wake into an arc item with the idle gap before it", () => {
        const entries = [
            prose("waiting", T0),
            { kind: "interrupted" } as AgentEntry,
            user("wake: task t-2 landed", T0 + 90 * S),
        ];
        const items = layoutTranscript(entries, { active: false });
        const arc = items[2] as Extract<LayoutItem, { kind: "arc" }>;
        expect(arc.kind).toBe("arc");
        expect(arc.message.kind).toBe("wake");
        expect(arc.ts).toBe(T0 + 90 * S);
        expect(arc.idleMs).toBe(90 * S);
    });

    it("reads the first prompt as a brief only when the host gives a run role", () => {
        const entries = [user("Build task 2"), prose("ok")];
        expect(kinds(layoutTranscript(entries, { active: false }))[0]).toBe("user");
        const withRole = layoutTranscript(entries, { active: false, ctx: { role: { kind: "worker" } as any } });
        expect(withRole[0]).toMatchObject({ kind: "arc", message: { kind: "brief" } });
    });

    it("passes events through as standalone items that break a stretch", () => {
        const entries: AgentEntry[] = [
            { kind: "command", name: "/review", args: "PR #402" },
            read("a"),
            { kind: "compaction", trigger: "manual", preTokens: 415334, postTokens: 22859, summary: "kept" },
            read("b"),
            { kind: "notification", summary: "worker finished", status: "completed", result: "report" },
            { kind: "interrupted" },
        ];
        const items = layoutTranscript(entries, { active: false });
        expect(kinds(items)).toEqual(["command", "steps", "compaction", "steps", "notification", "interrupted"]);
        expect(items[0]).toEqual({ kind: "command", name: "/review", args: "PR #402", isSkill: undefined, index: 0 });
        expect(items[2]).toEqual({
            kind: "compaction",
            trigger: "manual",
            preTokens: 415334,
            postTokens: 22859,
            summary: "kept",
            index: 2,
        });
        expect(items[4]).toEqual({
            kind: "notification",
            summary: "worker finished",
            status: "completed",
            result: "report",
            index: 4,
        });
        expect(items[5]).toEqual({ kind: "interrupted", index: 5 });
    });

    it("flags only the last reply as latest", () => {
        const items = layoutTranscript([prose("a"), user("b"), prose("c")], { active: false });
        expect(items.filter((i) => i.kind === "message").map((i) => (i as any).latest)).toEqual([false, true]);
    });
});

describe("stepTitle", () => {
    it("titles a Bash call by its description with the command in mono", () => {
        expect(stepTitle(bash("node test.js", { description: "Run the test" }))).toMatchObject({
            title: "Run the test",
            mono: "node test.js",
        });
    });

    it("shows the command alone when there is no description", () => {
        expect(stepTitle(bash("node test.js"))).toMatchObject({ mono: "node test.js" });
        expect(stepTitle(bash("node test.js")).title).not.toContain("node test.js");
    });

    it("keeps the verb and target for a call with no command", () => {
        const t = stepTitle({ kind: "action", verb: "ran", target: "ls" });
        expect(t.mono).toBe("ls");
        expect(t.title).not.toBe("");
    });

    it("puts the file in the title of a read or edit and the pattern in mono for a search", () => {
        expect(stepTitle(read("retry.js")).subject).toBe("retry.js");
        expect(stepTitle(edit("retry.js", 1, 1)).subject).toBe("retry.js");
        expect(stepTitle({ kind: "action", verb: "grep", target: "retry(" }).mono).toBe("retry(");
    });
});
