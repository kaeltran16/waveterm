import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brainstormLine } from "../../../frontend/app/view/agents/brainstormmodel";
import { canvasHandoffLine } from "../../../frontend/app/view/agents/canvasmarks";
import { buildCommentPrompt } from "../../../frontend/app/view/agents/commentprompt";
import type { CommentBatch } from "../../../frontend/app/view/agents/diffcomments";
import { handoffLine } from "../../../frontend/app/view/code/codehandoff";
import { reviewHandoffLine } from "../../../frontend/app/view/code/codereview";
import type { Card } from "./prompt-core";
import { cardHeader, parseRunPrompt, parseStreamPrompt, planTaskTitle, pointerPath } from "./prompt-core";
import { parseWake } from "./wake-core";

// the engine's own texts, written by pkg/orchestrate's TestViewModFixtures from the Go builders
function fixture(name: string): string {
    return readFileSync(fileURLToPath(new URL(`../testdata/${name}.txt`, import.meta.url)), "utf8");
}

// a row's text as the engine hands it to the hook: a live session cut a 9,120-character prompt at 6,608 and
// marked the cut, so the tests read less than that
const ROW_TEXT_CHARS = 6000;
const CUT_MARK = "\n[truncated for display]";

function rowText(name: string): string {
    const text = fixture(name);
    return text.length <= ROW_TEXT_CHARS ? text : text.slice(0, ROW_TEXT_CHARS) + CUT_MARK;
}

function field(c: Card | null, label: string): string | undefined {
    return c?.fields.find((f) => f.label === label)?.value;
}

const SPEC = "C:/work/app/docs/superpowers/specs/2026-11-04-coach-design.md";
const PLAN = "C:/work/app/docs/superpowers/plans/2026-11-04-coach.md";
const GOAL = "Build Interview practice app. Make a new dir for this project";

describe("parseRunPrompt", () => {
    it("reads a quick run's goal and principles", () => {
        const c = parseRunPrompt(rowText("quick"));
        expect(cardHeader(c!)).toBe("quick run · 2 principles");
        expect(field(c, "goal")).toBe("fix the flaky parser test");
        expect(c?.isAbridged).toBe(true);
    });

    it("reads a lead planning from an approved spec", () => {
        const c = parseRunPrompt(rowText("lead-design"));
        expect(cardHeader(c!)).toBe("run lead · design approved · 2 principles");
        expect(field(c, "goal")).toBe(GOAL);
        expect(field(c, "spec")).toBe(SPEC);
        expect(field(c, "prototype")).toBeUndefined();
    });

    it("reads a lead planning from a prototype alone, autonomous", () => {
        const c = parseRunPrompt(rowText("lead-design-prototype"));
        expect(cardHeader(c!)).toBe("run lead · design approved · autonomous");
        expect(field(c, "prototype")).toBe("C:/work/app/.superpowers/design/coach/coach.dc.html");
        expect(field(c, "spec")).toBeUndefined();
    });

    it("reads a lead working a goal, asking or autonomous", () => {
        expect(cardHeader(parseRunPrompt(rowText("lead-goal"))!)).toBe("run lead · from the goal · 2 principles");
        const auto = parseRunPrompt(rowText("lead-goal-autonomous"));
        expect(cardHeader(auto!)).toBe("run lead · from the goal · autonomous · 2 principles");
        expect(field(auto, "goal")).toBe(GOAL);
    });

    it("reads a lead started after its plan from the rules' opening", () => {
        const c = parseRunPrompt(rowText("plan-lead"));
        expect(cardHeader(c!)).toBe("run lead · plan submitted · 2 principles");
        expect(field(c, "run")).toBe("run-1234");
        expect(field(c, "spec")).toBe(SPEC);
        expect(field(c, "plan")).toBe(PLAN);
        expect(field(c, "effort")).toBe("effort:eff-9");
        expect(rowText("plan-lead")).toContain(CUT_MARK);
    });

    it("reads a replacement lead as any lead started after its plan, the part that says so being cut", () => {
        const c = parseRunPrompt(rowText("plan-lead-replacement"));
        expect(cardHeader(c!)).toBe("run lead · plan submitted");
        expect(field(c, "spec")).toBeUndefined();
        expect(field(c, "plan")).toBe(PLAN);
    });

    it("reads a task worker and names its plan task for the title", () => {
        const c = parseRunPrompt(rowText("worker"));
        expect(cardHeader(c!)).toBe("task 3 worker");
        expect(field(c, "plan")).toBe(PLAN);
        expect(field(c, "spec")).toBe(SPEC);
        expect(field(c, "check")).toBe("npm run lint");
        expect(c?.planTask).toEqual({ path: PLAN, n: "3" });
    });

    it("leaves a plan-less worker's title out when the plan header stands before it", () => {
        const c = parseRunPrompt(rowText("worker-dag"));
        expect(cardHeader(c!)).toBe("task t-2 worker");
        expect(field(c, "task")).toBeUndefined();
        expect(c?.planTask).toBeUndefined();
    });

    it("takes a plan-less worker's title from its text when nothing stands before it", () => {
        const text = fixture("worker-dag").replace(
            "The plan's header applies to every task:\nNever edit docs/.\n\nKeep the store in one file.\n\n",
            ""
        );
        expect(field(parseRunPrompt(text), "task")).toBe("add fmtDate");
    });

    it("reads a task reviewer", () => {
        const c = parseRunPrompt(rowText("reviewer"));
        expect(cardHeader(c!)).toBe("task t-3 reviewer");
        expect(field(c, "task")).toBe("Question bank store");
        expect(field(c, "change")).toBe("git diff abc1234..def5678");
        expect(field(c, "plan")).toBe(PLAN);
        expect(field(c, "spec")).toBe(SPEC);
    });

    it("reads both plan reviewers", () => {
        const full = parseRunPrompt(rowText("plan-reviewer"));
        expect(cardHeader(full!)).toBe("plan reviewer");
        expect(field(full, "spec")).toBe(SPEC);
        expect(field(full, "plan")).toBe(PLAN);
        expect(cardHeader(parseRunPrompt(rowText("plan-reviewer-second"))!)).toBe("plan reviewer · second of two");
    });

    it("reads the final verifier", () => {
        const c = parseRunPrompt(rowText("verifier"));
        expect(cardHeader(c!)).toBe("final verifier");
        expect(field(c, "tree")).toBe("C:/work/app-final");
        expect(field(c, "change")).toBe("git diff abc1234..0123456789abcdef");
        expect(field(c, "plan")).toBe(PLAN);
    });

    it("reads the brainstorm's builder check and judge", () => {
        const check = parseRunPrompt(rowText("builder-check"));
        expect(cardHeader(check!)).toBe("builder check");
        expect(field(check, "design")).toBe(SPEC);
        const judge = parseRunPrompt(rowText("judge"));
        expect(cardHeader(judge!)).toBe("brainstorm judge · 2 approaches");
        expect(field(judge, "decision")).toBe("Where do the questions come from?");
    });

    it("reads both design sessions", () => {
        const b = parseRunPrompt(rowText("design-brainstorm"));
        expect(cardHeader(b!)).toBe("design session · brainstorm");
        expect(field(b, "goal")).toBe("Build Interview practice app");
        expect(cardHeader(parseRunPrompt(rowText("design-canvas"))!)).toBe("design session · mockup");
    });

    it("leaves text that is no run prompt alone", () => {
        expect(parseRunPrompt("Goal: ship it")).toBeNull();
        expect(parseRunPrompt("fix the parser")).toBeNull();
        expect(parseRunPrompt("Work by these principles:\n- be brief\n\nthen do whatever")).toBeNull();
    });
});

describe("pointerPath", () => {
    it("names the file a long prompt was put in", () => {
        // pkg/jarvis launchPrompt
        const line =
            "Your instructions are in the file C:\\Users\\me\\AppData\\Local\\dev.arc.app\\data\\jarvis\\prompts\\s-1.md (too long for a command line). Read the whole file now and follow it exactly, as if it were this message.";
        expect(pointerPath(line)).toBe("C:\\Users\\me\\AppData\\Local\\dev.arc.app\\data\\jarvis\\prompts\\s-1.md");
        expect(pointerPath("Your instructions are in the file x.md")).toBeNull();
    });
});

describe("planTaskTitle", () => {
    it("finds the task's heading", () => {
        const plan =
            "# Coach\n\n### Task 2: Store\n\nbody\n\n### Task 3: Question bank store\n\n**Depends on:** none\n";
        expect(planTaskTitle(plan, "3")).toBe("Question bank store");
        expect(planTaskTitle(plan, "4")).toBeUndefined();
    });
});

describe("parseStreamPrompt", () => {
    it("reads another agent's message", () => {
        const c = parseStreamPrompt(fixture("agent-message"));
        expect(cardHeader(c!)).toBe("message · from design lead");
        expect(c?.body).toEqual(["rename the helper", "and rerun the tests"]);
    });

    it("reads a child run's end", () => {
        const done = parseStreamPrompt(fixture("child-done"));
        expect(cardHeader(done!)).toBe("child run · done");
        expect(field(done, "goal")).toBe("split the channel blob into per-run records");
        expect(field(done, "change")).toBe("3 files +40/-2");
        expect(cardHeader(parseStreamPrompt(fixture("child-cancelled"))!)).toBe("child run · cancelled");
    });

    it("reads every brainstorm line the pane and the engine send", () => {
        for (const text of [
            fixture("builder-questions"),
            fixture("judged"),
            fixture("judge-failed"),
            brainstormLine({ kind: "confirm", part: "storage" })!,
        ]) {
            const c = parseStreamPrompt(text);
            expect(c?.role).toBe("brainstorm");
            expect(c?.body).toEqual([text.slice("brainstorm: ".length)]);
        }
    });

    it("reads a canvas mark and a code handoff", () => {
        const mark = parseStreamPrompt(
            canvasHandoffLine(".superpowers/design/coach/feedback/003.png", "Practice", {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
                note: "tighter list",
            })
        );
        expect(cardHeader(mark!)).toBe("canvas mark");
        expect(field(mark, "board")).toBe("Practice");
        expect(field(mark, "note")).toBe("tighter list");
        expect(field(mark, "picture")).toBe(".superpowers/design/coach/feedback/003.png");
        const code = parseStreamPrompt(
            handoffLine({ rel: "pkg/coach/bank.go", startLine: 4, endLine: 9, note: "why a map?" })
        );
        expect(cardHeader(code!)).toBe("look at");
        expect(field(code, "file")).toBe("pkg/coach/bank.go:4-9");
        expect(field(code, "note")).toBe("why a map?");
        expect(field(parseStreamPrompt(handoffLine({ rel: "pkg/coach/bank.go" })), "note")).toBeUndefined();
    });

    it("reads a batch of diff comments as their places", () => {
        const refs = { original: { kind: "ref", ref: "main" }, modified: { kind: "worktree" } } as const;
        const comment = (path: string, start: number, note: string) => ({
            id: path,
            path,
            side: "modified",
            start,
            end: start,
            quote: ["x"],
            refs,
            note,
            at: 0,
        });
        const batch = {
            source: { kind: "agent", label: "loom" },
            at: 0,
            comments: [comment("a.go", 4, "why 8?"), comment("b.go", 7, "keep it")],
        } as unknown as CommentBatch;
        const c = parseStreamPrompt(buildCommentPrompt(batch, "live"));
        expect(cardHeader(c!)).toBe("review comments · 2 comments");
        expect(field(c, "on")).toBe("your changes (worktree against main)");
        expect(c?.body).toEqual(["a.go:4", "b.go:7"]);
        const code = parseStreamPrompt(reviewHandoffLine("C:/work/app/.arc/review.md"));
        expect(field(code, "file")).toBe("C:/work/app/.arc/review.md");
    });

    it("reads the notes a passed task leaves for later tasks", () => {
        const later = parseStreamPrompt(fixture("for-later"));
        expect(cardHeader(later!)).toBe("note for your task · from t-3 · For later tasks");
        expect(later?.body).toEqual(["the bank's Load takes a context now"]);
        const note = parseStreamPrompt(fixture("review-note"));
        expect(cardHeader(note!)).toBe("note for your task · from t-3's reviewer");
        expect(note?.body).toEqual(["keep the empty-bank message"]);
    });

    it("reads the workflow scan's picks line", () => {
        expect(cardHeader(parseStreamPrompt(fixture("workflow-picks"))!)).toBe("workflow scan");
    });

    it("leaves the human's own words alone", () => {
        expect(parseStreamPrompt(brainstormLine({ kind: "answer", text: "the second one" })!)).toBeNull();
        expect(parseStreamPrompt("rename the helper")).toBeNull();
    });
});

describe("the autonomous wakes", () => {
    it("read as notes, not alerts", () => {
        const on = parseWake(fixture("autonomous-on"));
        expect(on?.events[0].kind).toBe("note");
        expect(on?.events[0].headline).toBe("approvals for this run are now autonomous and the human is away");
        const off = parseWake(fixture("autonomous-off"));
        expect(off?.events[0].kind).toBe("note");
        expect(off?.events[0].headline).toBe("approvals for this run are back to Ask me");
    });

    it("are wakes only from their first line: a lead's prompt that ends on one is no wake", () => {
        expect(parseWake(fixture("wake"))).not.toBeNull();
        expect(parseWake(fixture("plan-lead"))).toBeNull();
    });
});
