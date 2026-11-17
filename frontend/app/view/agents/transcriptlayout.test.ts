import { describe, expect, it } from "vitest";
import type { AgentActionEntry, AgentEntry } from "./agentsviewmodel";
import { layoutTranscript, stepRows, stepTitle, type LayoutItem, type Step } from "./transcriptlayout";

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

type TurnItem = Extract<LayoutItem, { kind: "turn" }>;
const kinds = (items: LayoutItem[]) => items.map((i) => i.kind);
const turns = (items: LayoutItem[]) => items.filter((i): i is TurnItem => i.kind === "turn");
// every stretch, those inside a folded turn included
const stepsItems = (items: LayoutItem[]): Extract<LayoutItem, { kind: "steps" }>[] =>
    items.flatMap((i) => (i.kind === "steps" ? [i] : i.kind === "turn" ? stepsItems(i.items) : []));
const at = (items: LayoutItem[]) => items.map((i) => ("index" in i ? i.index : i.startIndex));

const CHUNK_DONE = 'E=2bd27b27 && wsh effort chunk status "$E" 3 done --note "retry fixed"';

describe("layoutTranscript folds", () => {
    const turn: AgentEntry[] = [
        user("fix it", T0),
        read("a.ts", T0 + 2 * S),
        read("b.ts", T0 + 3 * S),
        bash("npm test", { ts: T0 + 4 * S }),
        read("c.ts", T0 + 5 * S),
        prose("done", T0 + 41 * S),
    ];

    it("folds a finished turn's steps with the time from the prompt to the reply", () => {
        const items = layoutTranscript(turn, { active: false });
        expect(kinds(items)).toEqual(["user", "turn", "message"]);
        const [folded] = turns(items);
        expect(folded.startIndex).toBe(1);
        expect(stepsItems(items)[0].steps.map((s) => s.index)).toEqual([1, 2, 3, 4]);
        expect(folded.fold.durationMs).toBe(41 * S);
    });

    it("folds a single-step turn", () => {
        const items = layoutTranscript([user("go", T0), read("a.ts", T0 + S), prose("ok", T0 + 2 * S)], { active: false });
        expect(kinds(items)).toEqual(["user", "turn", "message"]);
    });

    it("keeps the live turn's stretches open while active and folds them once it is not", () => {
        const live = turn.slice(0, 5);
        expect(kinds(layoutTranscript(live, { active: true }))).toEqual(["user", "steps"]);
        expect(kinds(layoutTranscript(live, { active: false }))).toEqual(["user", "turn"]);
    });

    it("folds an earlier turn while the agent works on a later one", () => {
        const entries = [...turn, user("again", T0 + 50 * S), read("d.ts"), prose("looking"), read("e.ts")];
        expect(kinds(layoutTranscript(entries, { active: true }))).toEqual([
            "user",
            "turn",
            "message",
            "user",
            "steps",
            "message",
            "steps",
        ]);
    });

    it("folds a finished turn's interim work into one fold and leaves the final reply out", () => {
        const thought = (text: string): AgentEntry => ({ kind: "thought", text });
        const entries: AgentEntry[] = [
            user("go", T0),
            prose("looking", T0 + S),
            read("a.ts", T0 + 2 * S),
            thought("hm"),
            read("b.ts", T0 + 3 * S),
            prose("found it", T0 + 4 * S),
            bash(CHUNK_DONE, { ts: T0 + 5 * S }),
            bash("npm test", { ts: T0 + 6 * S }),
            prose("done", T0 + 9 * S),
        ];
        const items = layoutTranscript(entries, { active: false, thoughts: true });
        expect(kinds(items)).toEqual(["user", "turn", "message"]);
        expect(at(items)).toEqual([0, 1, 8]);
        const [folded] = turns(items);
        expect(kinds(folded.items)).toEqual(["message", "steps", "message", "card", "steps"]);
        expect(at(folded.items)).toEqual([1, 2, 5, 6, 7]);
        expect(stepsItems(folded.items)[0].thoughts).toEqual([{ index: 3, text: "hm" }]);
        expect(folded.fold.durationMs).toBe(9 * S);
    });

    it("folds everything when no reply follows the last step", () => {
        const items = layoutTranscript([user("go"), prose("looking"), read("a.ts")], { active: false });
        expect(kinds(items)).toEqual(["user", "turn"]);
        expect(kinds(turns(items)[0].items)).toEqual(["message", "steps"]);
    });

    it("draws a turn of prose only as it is", () => {
        const thought: AgentEntry = { kind: "thought", text: "hm" };
        const items = layoutTranscript([user("hi"), prose("a"), thought, prose("b")], { active: false, thoughts: true });
        expect(kinds(items)).toEqual(["user", "message", "thought", "message"]);
    });

    it("keeps a queued message, an interrupt and a compaction outside, one fold per side", () => {
        const queued: AgentEntry = { kind: "user", text: "also this", queued: true };
        const compaction: AgentEntry = { kind: "compaction", trigger: "auto" };
        const entries: AgentEntry[] = [
            user("go"),
            read("a"),
            queued,
            read("b"),
            { kind: "interrupted" },
            read("c"),
            compaction,
            prose("between"),
            read("d"),
            prose("done"),
        ];
        const items = layoutTranscript(entries, { active: false });
        expect(kinds(items)).toEqual([
            "user",
            "turn",
            "user",
            "turn",
            "interrupted",
            "turn",
            "compaction",
            "turn",
            "message",
        ]);
        expect(at(turns(items)[3].items)).toEqual([7, 8]);
    });

    it("splits a finished turn at a permission mark that falls between its items", () => {
        const entries: AgentEntry[] = [user("go"), read("a"), prose("mid"), bash("npm test"), prose("done")];
        const items = layoutTranscript(entries, { active: false, marks: [{ afterEntry: 3, text: "Yes: npm test" }] });
        expect(kinds(items)).toEqual(["user", "turn", "turn", "message"]);
        expect(at(turns(items)[0].items)).toEqual([1, 2]);
        expect(at(turns(items)[1].items)).toEqual([3]);
    });

    it("starts a new turn at an Arc message and never folds it", () => {
        const entries: AgentEntry[] = [user("go"), read("a"), user("wake: task t-2 landed"), read("b"), prose("ok")];
        expect(kinds(layoutTranscript(entries, { active: false }))).toEqual(["user", "turn", "arc", "turn", "message"]);
    });

    it("starts a turn with a tool output card open in the rendered view, never one of only wsh cards", () => {
        const image: AgentActionEntry = { ...read("shot.png"), images: [{ mediaType: "image/png", data: "iVBOR" }] };
        const withImage = [user("go"), image, prose("ok")];
        const cardsOnly = [user("go"), bash(CHUNK_DONE), prose("ok")];
        expect(turns(layoutTranscript(withImage, { active: false, renderers: true }))[0].open).toBe(true);
        expect(turns(layoutTranscript(withImage, { active: false }))[0].open).toBe(false);
        expect(turns(layoutTranscript(cardsOnly, { active: false, renderers: true }))[0].open).toBe(false);
    });

    it("names Skill calls in the phrase", () => {
        const skill = (name: string): AgentActionEntry => ({ kind: "action", verb: "skill", target: name, outcome: "ok" });
        const phrase = (entries: AgentEntry[]) => turns(layoutTranscript(entries, { active: false }))[0].fold.phrase;
        expect(phrase([user("go"), skill("brainstorming"), prose("ok")])).toBe("used a skill");
        expect(phrase([user("go"), skill("a"), skill("b"), prose("ok")])).toBe("used 2 skills");
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
        const items = layoutTranscript(codex, { active: false });
        expect(turns(items)[0].fold.durationMs).toBeUndefined();
        expect(stepsItems(items)[0].steps.map((s) => s.wsh)).toEqual([null, null, null]);
    });

    it("ends the duration at the last step's end when nothing follows", () => {
        const entries = [
            user("go", T0),
            bash("a", { ts: T0 + S }),
            bash("b", { ts: T0 + 2 * S }),
            bash("c", { ts: T0 + 3 * S }),
        ];
        expect(turns(layoutTranscript(entries, { active: false }))[0].fold.durationMs).toBe(3 * S + 200);
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
        const fold = turns(layoutTranscript(entries, { active: false }))[0].fold;
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

    it("draws a call refused before it ran as blocked and leaves it out of the failed count", () => {
        const refused: AgentActionEntry = {
            ...bash("task build > log"),
            outcome: "blocked",
            detail: { kind: "bash", command: "task build > log", output: "Refused by Arc", exit: null },
        };
        const items = layoutTranscript([user("go"), refused, bash("node test.js", { exit: 1 }), prose("ok")], {
            active: false,
        });
        expect(stepsItems(items)[0].steps.map((s) => s.status)).toEqual(["blocked", "fail"]);
        expect(turns(items)[0].fold.failed).toBe(1);
    });
});

describe("layoutTranscript wsh calls", () => {
    it("draws a successful change call as a card that splits the stretch", () => {
        const entries = [user("go"), read("a"), read("b"), bash(CHUNK_DONE), read("c"), prose("ok")];
        const items = layoutTranscript(entries, { active: true });
        expect(kinds(items)).toEqual(["user", "steps", "card", "steps", "message"]);
        const card = items[2] as Extract<LayoutItem, { kind: "card" }>;
        expect(card.index).toBe(3);
        expect(card.step.wsh?.key).toBe("chunk-status");
        expect(card.step.wsh?.call.args).toEqual(["2bd27b27", "3", "done"]);
        expect(card.step.wsh?.call.flags.note).toBe("retry fixed");
    });

    it("keeps a failed change call a failed step", () => {
        const items = layoutTranscript([user("go"), read("a"), bash(CHUNK_DONE, { exit: 1 }), read("c")], {
            active: true,
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
        expect(kinds(layoutTranscript([failed], { active: true }))).toEqual(["steps"]);
    });

    it("keeps a pending change call a running step", () => {
        const items = layoutTranscript([user("go"), bash(CHUNK_DONE, { pending: true, ts: T0 })], { active: true });
        expect(kinds(items)).toEqual(["user", "steps"]);
        expect(stepsItems(items)[0].steps[0].status).toBe("running");
    });

    it("keeps a read-only call a step with its view key", () => {
        const items = layoutTranscript([bash("wsh effort show e1 --json")], { active: true });
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

    it("carries a command's output onto its item", () => {
        const items = layoutTranscript([{ kind: "command", name: "/mcp", output: "Connected" }], { active: true });
        expect(items[0]).toMatchObject({ kind: "command", name: "/mcp", output: "Connected" });
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
        // the live turn, so nothing folds them
        const items = layoutTranscript(entries, { active: true });
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

    it("keeps a ! shell run between two steps of a turn as its own item, never folded into the Worked line", () => {
        const entries: AgentEntry[] = [
            user("go", T0),
            read("a", T0 + S),
            read("b", T0 + 2 * S),
            { kind: "shell", command: "git status", stdout: "clean", stderr: "", ts: T0 + 3 * S },
            read("c", T0 + 4 * S),
            read("d", T0 + 5 * S),
            prose("done", T0 + 6 * S),
        ];
        const items = layoutTranscript(entries, { active: false });
        expect(kinds(items)).toEqual(["user", "turn", "shell", "turn", "message"]);
        expect(items[2]).toEqual({ kind: "shell", command: "git status", stdout: "clean", stderr: "", ts: T0 + 3 * S, index: 3 });
    });

    it("flags only the last wake as latest", () => {
        const entries = [
            user("wake: task t-1 landed", T0),
            prose("ok", T0 + S),
            user("wake: task t-2 landed", T0 + 2 * S),
            prose("ok", T0 + 3 * S),
        ];
        const arcs = layoutTranscript(entries, { active: false }).filter(
            (i): i is Extract<LayoutItem, { kind: "arc" }> => i.kind === "arc"
        );
        expect(arcs.map((a) => a.latest)).toEqual([false, true]);
    });

    it("never flags a brief as the latest wake", () => {
        const items = layoutTranscript([user("Build task 2"), prose("ok")], {
            active: false,
            ctx: { role: { kind: "worker" } as any },
        });
        expect(items[0]).toMatchObject({ kind: "arc", latest: false });
    });

    it("carries a notice flag and draws a queued message as a user item", () => {
        const entries: AgentEntry[] = [
            user("go"),
            { kind: "notification", summary: "shell finished", notice: true },
            { kind: "user", text: "also check b", queued: true },
        ];
        const items = layoutTranscript(entries, { active: true });
        expect(items[1]).toMatchObject({ kind: "notification", notice: true });
        expect(items[2]).toMatchObject({ kind: "user", text: "also check b" });
    });

    it("flags only the last reply as latest", () => {
        const items = layoutTranscript([prose("a"), user("b"), prose("c")], { active: false });
        expect(items.filter((i) => i.kind === "message").map((i) => (i as any).latest)).toEqual([false, true]);
    });
});

describe("layoutTranscript thoughts", () => {
    const thought = (text: string, ts?: number): AgentEntry => ({ kind: "thought", text, ts });
    const turn: AgentEntry[] = [
        user("fix it", T0),
        thought("look first", T0 + 30 * S),
        read("a.ts", T0 + 30 * S),
        thought("then the test", T0 + 31 * S),
        read("b.ts", T0 + 32 * S),
        bash("npm test", { ts: T0 + 33 * S }),
        thought("all green", T0 + 40 * S),
        prose("done", T0 + 41 * S),
    ];

    it("skips thoughts unless the host asks for them, and they move neither the stretch nor its time", () => {
        const items = layoutTranscript(turn, { active: false });
        expect(kinds(items)).toEqual(["user", "turn", "message"]);
        const [stretch] = stepsItems(items);
        expect(stretch.thoughts).toBeUndefined();
        expect(turns(items)[0].fold.durationMs).toBe(41 * S);
    });

    it("draws a stretch's thoughts inside it, so the stretch still folds and counts only its steps", () => {
        const items = layoutTranscript(turn, { active: false, thoughts: true });
        expect(kinds(items)).toEqual(["user", "turn", "message"]);
        const [stretch] = stepsItems(items);
        expect(stretch.startIndex).toBe(1);
        expect(stretch.thoughts).toEqual([
            { index: 1, text: "look first" },
            { index: 3, text: "then the test" },
            { index: 6, text: "all green" },
        ]);
        expect(turns(items)[0].fold.phrase).toBe("read 2 files, ran 1 command");
        expect(turns(items)[0].fold.durationMs).toBe(41 * S);
    });

    it("a thought with no step beside it stands alone", () => {
        const items = layoutTranscript([user("hi"), thought("pondering"), prose("hello")], { active: false, thoughts: true });
        expect(items[1]).toEqual({ kind: "thought", text: "pondering", index: 1 });
    });

    it("a thought before a wsh change card stands alone before it", () => {
        const card = bash(CHUNK_DONE);
        const items = layoutTranscript([user("go"), thought("marking it"), card], { active: true, thoughts: true });
        expect(kinds(items)).toEqual(["user", "thought", "card"]);
    });

    it("merges consecutive standalone thoughts into one holding both texts", () => {
        const items = layoutTranscript([user("hi"), thought("first"), thought("second"), prose("hello")], {
            active: false,
            thoughts: true,
        });
        expect(kinds(items)).toEqual(["user", "thought", "message"]);
        expect(items[1]).toEqual({ kind: "thought", text: "first\n\nsecond", index: 1 });
    });

    it("merges consecutive thoughts inside a step box, and keeps two with a step between them", () => {
        const entries = [
            user("go"),
            read("a.ts"),
            thought("one"),
            thought("two"),
            read("b.ts"),
            thought("three"),
            read("c.ts"),
            prose("done"),
        ];
        const [stretch] = stepsItems(layoutTranscript(entries, { active: false, thoughts: true }));
        expect(stretch.thoughts).toEqual([
            { index: 2, text: "one\n\ntwo" },
            { index: 5, text: "three" },
        ]);
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

    it("titles a hard-to-read command with no description, the command still in mono", () => {
        const script = "python - <<'EOF'\nprint(1)\nEOF";
        expect(stepTitle(bash(script))).toMatchObject({ title: "Ran a Python script", mono: script });
        expect(stepTitle(bash("ls -la"))).toMatchObject({ title: "", mono: "ls -la" });
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

describe("stepRows", () => {
    const PNG = { mediaType: "image/png", data: "iVBOR" };
    let next = 0;
    const step = (
        action: AgentActionEntry,
        status: Step["status"] = action.pending ? "running" : action.outcome === "fail" ? "fail" : "ok"
    ): Step => ({
        index: next++,
        action,
        wsh: null,
        status,
    });
    const imageRead = (target: string, o: { pending?: boolean; fail?: boolean } = {}): Step =>
        step(
            o.pending
                ? { kind: "action", verb: "read", target, pending: true }
                : { ...read(target), outcome: o.fail ? "fail" : "ok", images: [PNG] }
        );
    const shape = (steps: Step[]) =>
        stepRows(steps).map((r) =>
            r.kind === "images" ? `images:${r.steps.length}` : r.kind === "thought" ? `thought:${r.text}` : `step:${r.step.action.target}`
        );

    it("puts each thought between the steps around it, splitting an image group", () => {
        const steps = [imageRead("a.png"), imageRead("b.png"), step(bash("ls"))];
        const [a, b, ls] = steps.map((s) => s.index);
        const thoughts = [
            { index: a - 0.5, text: "first" },
            { index: b - 0.5, text: "mid" },
            { index: ls + 0.5, text: "last" },
        ];
        const rows = stepRows(steps, thoughts).map((r) => (r.kind === "thought" ? `thought:${r.text}` : r.kind === "images" ? "images" : `step:${r.step.action.target}`));
        expect(rows).toEqual(["thought:first", "step:a.png", "thought:mid", "step:b.png", "step:ls", "thought:last"]);
    });

    it("groups three consecutive image reads into one row", () => {
        const steps = [imageRead("a.png"), imageRead("b.png"), imageRead("c.png")];
        const rows = stepRows(steps);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({ kind: "images", steps });
    });

    it("keeps a lone image read a plain step", () => {
        expect(shape([step(bash("ls")), imageRead("a.png"), step(bash("pwd"))])).toEqual([
            "step:ls",
            "step:a.png",
            "step:pwd",
        ]);
    });

    it("splits around a pending image read and never groups one", () => {
        expect(shape([imageRead("a.png"), imageRead("b.png", { pending: true }), imageRead("c.png")])).toEqual([
            "step:a.png",
            "step:b.png",
            "step:c.png",
        ]);
    });

    it("breaks a run at a non-image read or a failed read", () => {
        expect(
            shape([
                imageRead("a.png"),
                imageRead("b.png"),
                step(read("notes.md")),
                imageRead("c.png"),
                imageRead("d.png", { fail: true }),
                imageRead("e.png"),
                imageRead("f.png"),
            ])
        ).toEqual(["images:2", "step:notes.md", "step:c.png", "step:d.png", "images:2"]);
    });

    it("never groups text-file reads", () => {
        expect(shape([step(read("a.ts")), step(read("b.ts")), step(read("c.ts"))])).toEqual([
            "step:a.ts",
            "step:b.ts",
            "step:c.ts",
        ]);
    });
});

describe("layoutTranscript user bubbles", () => {
    const png = { mediaType: "image/png", data: "iVBORw0KGgo=" };
    const bubble = (e: AgentEntry) => layoutTranscript([e], { active: false })[0];

    it("a pasted image replaces its placeholder", () => {
        expect(bubble({ kind: "user", text: "see [Image #1]", images: [png] })).toEqual({
            kind: "user",
            text: "see",
            index: 0,
            images: [png],
        });
        expect(bubble({ kind: "user", text: "first\n[Image #1]\nsecond", images: [png] })).toMatchObject({
            text: "first\nsecond",
        });
    });

    it("a placeholder with no image stays", () => {
        expect(bubble(user("see [Image #1]"))).toEqual({ kind: "user", text: "see [Image #1]", index: 0 });
    });

    it("a trailing attachments block becomes image paths and file paths", () => {
        const text = [
            "check these",
            "",
            "Attachments (read these files):",
            "- C:\\tmp\\shot.PNG",
            "- C:\\tmp\\notes.txt",
            "- /home/u/missing.png",
        ].join("\n");
        expect(bubble(user(text))).toEqual({
            kind: "user",
            text: "check these",
            index: 0,
            imagePaths: ["C:\\tmp\\shot.PNG", "/home/u/missing.png"],
            filePaths: ["C:\\tmp\\notes.txt"],
        });
    });

    it("an attachments header followed by prose is the user's own text", () => {
        const text = "Attachments (read these files):\nplease list them";
        expect(bubble(user(text))).toEqual({ kind: "user", text, index: 0 });
    });
});
