// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    finalDetailAbove,
    finalFailedNote,
    finalRowFocusId,
    finalStageActivity,
    finalStageId,
    finalStageRunId,
    finalStageView,
    finalStepBody,
    finalStepExit,
    finalStepOpens,
    finalStepOpensByDefault,
    isFinalStageId,
    KEPT_NOTE,
    outputTail,
    type FinalKept,
    type FinalStageView,
} from "./finalstage";

const S = 1000;
const NOW = 10_000_000;
const HUMAN = "ended by the human: the dev app never came up";

const task = (id: string, state = "done") => ({ id, state }) as TaskNode;
const sevenDone = ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6", "t-7"].map((id) => task(id));

function dag(final: Partial<FinalStage> | undefined, over: Partial<TaskGroup> = {}): TaskGroup {
    return {
        oid: "dag-1",
        runid: "lead-run",
        status: "finalizing",
        tasks: sevenDone,
        check: "go build ./cmd/wsh/...",
        verify: "node scripts/verify.mjs ./pkg/x",
        finalcmd: "node scripts/cdp/final-verify.mjs surface-smoke",
        final,
        ...over,
    } as TaskGroup;
}

let seq = 0;
function ev(step: string, ms: number, ok = true, round = 1, ts = NOW): RunEvent {
    seq++;
    return {
        id: `e-${seq}`,
        runid: "lead-run",
        channelid: "ch",
        ts,
        kind: "final-step",
        detail: JSON.stringify({ round, step, ms, ok }),
    };
}

const states = (v: FinalStageView) => v.steps.map((s) => s.state);
const tones = (v: FinalStageView) => v.steps.map((s) => s.tone);
const times = (v: FinalStageView) => v.steps.map((s) => s.ms);

describe("finalStageView, the States board", () => {
    it("tasks still running: no row, and the node waits on every task", () => {
        const tasks = [...sevenDone.slice(0, 4), task("t-5", "running"), task("t-6", "pending"), task("t-7", "ready")];
        const v = finalStageView(dag(undefined, { status: "running", tasks }), [], NOW);
        expect(v.visible).toBe(false);
        expect(v.subline).toBe("after 3 more tasks");
        expect(v.nodeMeta).toBe("waits on every task");
        expect(v.tone).toBe("wait");
        expect(tones(v)).toEqual(["wait", "wait", "wait", "wait", "wait"]);
        expect(v.waitsOn).toEqual(["t-5", "t-6", "t-7"]);
    });

    it("a run cancelled before the stage started: the node did not run", () => {
        const tasks = [...sevenDone.slice(0, 4), task("t-5", "skipped"), task("t-6", "pending")];
        const v = finalStageView(dag(undefined, { status: "cancelled", tasks }), [], NOW);
        expect(v.headline).toBe("did not run · run cancelled");
        expect(v.nodeMeta).toBe("did not run · run cancelled");
        expect(v.subline).toBe("did not run");
    });

    it("a running dag with tasks pending still waits on every task", () => {
        const tasks = [...sevenDone.slice(0, 6), task("t-7", "pending")];
        const v = finalStageView(dag(undefined, { status: "running", tasks }), [], NOW);
        expect(v.headline).toBe("waits on every task");
    });

    it("preparing the tree", () => {
        const final = { state: "checking", round: 1, step: "tree", stepts: NOW - 22 * S, startedts: NOW - 22 * S };
        const v = finalStageView(dag(final), [], NOW);
        expect(v.visible).toBe(true);
        expect(v.subline).toBe("Tree · 22s · step 1 of 5");
        expect(v.nodeMeta).toBe("round 1 · Tree · 22s");
        expect(v.tone).toBe("run");
        expect(tones(v)).toEqual(["run", "wait", "wait", "wait", "wait"]);
        expect(v.headline).toBe("round 1 · preparing the tree · 22s");
        expect(v.output).toBe("");
    });

    it("a command running", () => {
        const stepts = NOW - 192 * S;
        const final = { state: "checking", round: 1, step: "verify", stepts, output: "ok pkg/x\n", startedts: 1 };
        const events = [ev("tree", 41 * S, true, 1, stepts - 18 * S), ev("check", 18 * S, true, 1, stepts)];
        const v = finalStageView(dag(final), events, NOW);
        expect(v.subline).toBe("Verify · 3m 12s · step 3 of 5");
        expect(v.nodeMeta).toBe("round 1 · Verify · 3m 12s");
        expect(v.headline).toBe("round 1 · running Verify · 3m 12s");
        expect(v.tone).toBe("run");
        expect(tones(v)).toEqual(["pass", "pass", "run", "wait", "wait"]);
        expect(v.steps.map((s) => s.text)).toEqual([
            "passed 41s",
            "passed 18s",
            "running 3m 12s",
            "waiting",
            "waiting",
        ]);
        expect(v.running).toBe("verify");
        expect(v.stepIndex).toBe(3);
        expect(v.elapsedMs).toBe(192 * S);
        // the round's time is every step's so far: 41s, 18s and 3m 12s
        expect(v.stageMs).toBe((41 + 18 + 192) * S);
        expect(v.output).toBe("ok pkg/x\n");
        expect(v.next).toBe("next Final, then the verifier");
        expect(v.steps[2].command).toBe("node scripts/verify.mjs ./pkg/x");
    });

    it("verifier alongside", () => {
        const final = { state: "checking", round: 1, step: "check", stepts: NOW - 11 * S, verifierrunid: "v-run" };
        const v = finalStageView(dag(final, { finalcmd: "" }), [ev("tree", 30 * S)], NOW);
        expect(v.subline).toBe("Check · 11s · verifier alongside");
        expect(v.nodeMeta).toBe("round 1 · Check · verifier");
        expect(v.tone).toBe("run");
        expect(tones(v)).toEqual(["pass", "run", "wait", "run"]);
        expect(v.alongside).toBe(true);
        expect(v.running).toBe("check");
        expect(v.next).toBe("next Verify");
    });

    it("verifier reviewing", () => {
        const final = { state: "verifying", round: 2, verifierrunid: "v-run", startedts: NOW - 242 * S };
        const v = finalStageView(dag(final), [], NOW);
        expect(v.subline).toBe("verifier reviewing · 4m 02s");
        expect(v.nodeMeta).toBe("round 2 · verifier · 4m 02s");
        expect(v.headline).toBe("round 2 · verifier reviewing · 4m 02s");
        expect(v.tone).toBe("run");
        expect(tones(v)).toEqual(["pass", "pass", "pass", "pass", "run"]);
        expect(v.running).toBe("verifier");
        expect(v.stepIndex).toBe(5);
        expect(v.alongside).toBe(false);
        expect(v.next).toBe("");
    });

    it("failed", () => {
        const final = { state: "failed", round: 1, detail: "Final `x` failed (exit 1):\njarvis-peek steps 4 and 5" };
        const events = [ev("tree", 41 * S), ev("check", 18 * S), ev("verify", 300 * S), ev("final", 125 * S, false)];
        const v = finalStageView(dag(final, { status: "blocked" }), events, NOW);
        expect(v.visible).toBe(true);
        expect(v.subline).toBe("failed at Final · round 1");
        expect(v.nodeMeta).toBe("round 1 · failed at Final");
        expect(v.tone).toBe("fail");
        expect(tones(v)).toEqual(["pass", "pass", "pass", "fail", "wait"]);
        expect(v.steps[3].text).toBe("failed 2m 05s");
        expect(v.steps[4].text).toBe("not run");
    });

    it("fix round under way", () => {
        const tasks = [...sevenDone, task("t-8", "running"), task("t-9", "pending")];
        const v = finalStageView(dag({ state: "", round: 2 }, { status: "running", tasks }), [], NOW);
        expect(v.visible).toBe(true);
        expect(v.subline).toBe("round 2 after 2 fix tasks");
        expect(v.nodeMeta).toBe("round 2 waits on t-8, t-9");
        expect(v.tone).toBe("wait");
        expect(tones(v)).toEqual(["wait", "wait", "wait", "wait", "wait"]);
    });

    it("unverified", () => {
        const final = { state: "unverified", round: 2, verifierrunid: "v-run", unverified: ["verifier: no dev app"] };
        const v = finalStageView(dag(final, { status: "done" }), [], NOW);
        expect(v.subline).toBe("unverified · 1 reason");
        expect(v.nodeMeta).toBe("round 2 · unverified");
        expect(v.tone).toBe("warn");
        expect(tones(v)).toEqual(["pass", "pass", "pass", "pass", "warn"]);
        expect(v.unverified).toEqual(["verifier: no dev app"]);
    });

    it("passed", () => {
        const final = { state: "passed", round: 2, verifierrunid: "v-run", startedts: NOW - 400 * S };
        const events = [41, 18, 300, 263].map((s, i) => ev(["tree", "check", "verify", "final"][i], s * S, true, 2));
        const v = finalStageView(dag(final, { status: "done" }), events, NOW, { completedts: NOW - 160 * S });
        expect(v.subline).toBe("passed · 14m 22s");
        expect(v.nodeMeta).toBe("round 2 · passed · 14m 22s");
        expect(v.tone).toBe("pass");
        expect(tones(v)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
        expect(v.stageMs).toBe(862 * S);
    });
});

describe("finalStageView, the steps", () => {
    it("has a step per command the dag has, between Tree and Verifier", () => {
        const keys = (over: Partial<TaskGroup>) =>
            finalStageView(dag(undefined, over), [], NOW).steps.map((s) => s.key);
        expect(keys({})).toEqual(["tree", "check", "verify", "final", "verifier"]);
        expect(keys({ finalcmd: "" })).toEqual(["tree", "check", "verify", "verifier"]);
        expect(keys({ check: "", verify: "", finalcmd: "" })).toEqual(["verifier"]);
    });

    it("times a running step from stepts, and gives a step with no stepts no time", () => {
        const at = (stepts: number) =>
            finalStageView(dag({ state: "checking", round: 1, step: "check", stepts }), [], NOW);
        expect(at(NOW - 7 * S).steps[1].ms).toBe(7 * S);
        expect(at(0).steps[1].ms).toBeUndefined();
        expect(at(0).steps[1].text).toBe("running");
        expect(at(0).subline).toBe("Check · step 2 of 5");
    });

    it("reads the steps before the running one as passed, timed only by an event", () => {
        const final = { state: "final", round: 1, step: "final", stepts: NOW - S };
        const v = finalStageView(dag(final), [ev("check", 18 * S)], NOW);
        expect(states(v)).toEqual(["passed", "passed", "passed", "running", "waiting"]);
        expect(times(v).slice(0, 3)).toEqual([undefined, 18 * S, undefined]);
        expect(v.steps[0].text).toBe("passed");
    });

    it("a failed stage fails at the step whose event is not ok, keeping the detail whole", () => {
        const detail = "Verify `v` failed on the merged result (exit 1):\n" + "x".repeat(5000) + "\n  trailing  ";
        const events = [ev("tree", S), ev("check", S), ev("verify", S, false)];
        const v = finalStageView(dag({ state: "failed", round: 1, detail }), events, NOW);
        expect(states(v)).toEqual(["passed", "passed", "failed", "notrun", "notrun"]);
        expect(v.detail).toBe(detail);

        const allOk = [...events.slice(0, 2), ev("verify", S), ev("final", S)];
        const byVerifier = finalStageView(
            dag({ state: "failed", round: 1, detail: "defects", verifierrunid: "v-run" }),
            allOk,
            NOW
        );
        expect(states(byVerifier)).toEqual(["passed", "passed", "passed", "passed", "failed"]);
        expect(byVerifier.subline).toBe("failed at Verifier · round 1");
    });

    it("a Check that failed on the base leaves the Verifier to fail the stage", () => {
        const events = [ev("tree", S), ev("check", S, false)];
        const final = { state: "failed", round: 1, detail: "defects", verifierrunid: "v-run" };
        const v = finalStageView(dag(final, { verify: "", finalcmd: "" }), events, NOW);
        expect(states(v)).toEqual(["passed", "unverified", "failed"]);
        expect(v.subline).toBe("failed at Verifier · round 1");
    });

    it("with the round's events gone, a failed stage fails at the command its detail names", () => {
        const v = finalStageView(dag({ state: "failed", round: 1, detail: "Verify `v` failed (exit 1):\nx" }), [], NOW);
        expect(states(v)).toEqual(["passed", "passed", "failed", "notrun", "notrun"]);
    });

    it("a failed Tree step in an unverified stage reads unverified, and the rest not run", () => {
        const final = { state: "unverified", round: 1, unverified: ["the final stage could not check: no tree"] };
        const v = finalStageView(dag(final), [ev("tree", 3 * S, false)], NOW);
        expect(states(v)).toEqual(["unverified", "notrun", "notrun", "notrun", "notrun"]);
    });

    it("a Final command that exited 3 leaves the Verifier to run", () => {
        const events = [ev("tree", S), ev("check", S), ev("verify", S), ev("final", S, false)];
        const reviewing = finalStageView(dag({ state: "verifying", round: 1, verifierrunid: "v-run" }), events, NOW);
        expect(states(reviewing)).toEqual(["passed", "passed", "passed", "unverified", "running"]);

        const failed = finalStageView(
            dag({ state: "failed", round: 1, detail: "defects", verifierrunid: "v-run" }),
            events,
            NOW
        );
        expect(states(failed)).toEqual(["passed", "passed", "passed", "unverified", "failed"]);
    });

    it("a stage a human ended stops at the first step with no passing event", () => {
        const passing = [ev("tree", S), ev("check", S)];
        const expected = ["passed", "passed", "stopped", "notrun", "notrun"];

        const failed = finalStageView(dag({ state: "failed", round: 1, detail: HUMAN }), passing, NOW);
        expect(states(failed)).toEqual(expected);
        expect(failed.detail).toBe(HUMAN);
        expect(failed.steps[2].tone).toBe("warn");
        expect(failed.steps[2].text).toBe("stopped");
        expect(failed.tone).toBe("fail");

        const withEvent = [...passing, ev("verify", 95 * S, false)];
        const unverified = finalStageView(
            dag({ state: "unverified", round: 1, unverified: ["flaky", HUMAN] }),
            withEvent,
            NOW
        );
        expect(states(unverified)).toEqual(expected);
        expect(unverified.unverified).toEqual(["flaky", HUMAN]);
        expect(unverified.steps[2].text).toBe("stopped 1m 35s");
        expect(unverified.subline).toBe("unverified · 2 reasons");
    });

    it("tells a stage a human ended from one that ended by itself", () => {
        const passing = [ev("tree", S), ev("check", S)];
        expect(finalStageView(dag({ state: "failed", round: 1, detail: HUMAN }), passing, NOW).endedByYou).toBe(true);
        expect(
            finalStageView(dag({ state: "unverified", round: 1, unverified: ["flaky", HUMAN] }), passing, NOW)
                .endedByYou
        ).toBe(true);
        expect(
            finalStageView(dag({ state: "failed", round: 1, detail: "Verify `x` exited 1" }), passing, NOW).endedByYou
        ).toBe(false);
        expect(
            finalStageView(dag({ state: "unverified", round: 1, unverified: ["flaky"] }), passing, NOW).endedByYou
        ).toBe(false);
        expect(finalStageView(dag(undefined), [], NOW).endedByYou).toBe(false);
    });

    it("a stage a human ended while only the verifier ran stops at the Verifier", () => {
        const all = [ev("tree", S), ev("check", S), ev("verify", S), ev("final", S)];
        const final = { state: "unverified", round: 1, unverified: [HUMAN], verifierrunid: "v-run" };
        expect(states(finalStageView(dag(final), all, NOW))).toEqual([
            "passed",
            "passed",
            "passed",
            "passed",
            "stopped",
        ]);
        // the commands were over before the verifier started, whether or not their events are still held
        expect(states(finalStageView(dag(final), [], NOW))[4]).toBe("stopped");
        const alone = finalStageView(dag(final, { check: "", verify: "", finalcmd: "" }), [], NOW);
        expect(states(alone)).toEqual(["stopped"]);
    });

    it("ignores another round's events, and takes the newer of two for one step", () => {
        const final = { state: "checking", round: 2, step: "verify", stepts: NOW - S };
        const events = [
            ev("check", 50 * S, true, 2, NOW - 10 * S),
            ev("tree", 99 * S, false, 1),
            ev("check", 20 * S, true, 2, NOW - 5 * S),
            ev("check", 70 * S, true, 2, NOW - 20 * S),
        ];
        const v = finalStageView(dag(final), events, NOW);
        expect(v.steps[0].ms).toBeUndefined();
        expect(v.steps[0].state).toBe("passed");
        expect(v.steps[1].ms).toBe(20 * S);
    });

    it("with no events has no time and no total, and still reads a finished stage by its state", () => {
        const passed = finalStageView(dag({ state: "passed", round: 1 }), [], NOW);
        expect(times(passed)).toEqual([undefined, undefined, undefined, undefined, undefined]);
        expect(passed.stageMs).toBeUndefined();
        expect(passed.elapsedMs).toBeUndefined();
        expect(passed.subline).toBe("passed");
        expect(passed.nodeMeta).toBe("round 1 · passed");
        expect(states(passed)).toEqual(["passed", "passed", "passed", "passed", "passed"]);

        const detail = "Verify `v` failed on the merged result (exit 1):\nFAIL";
        const failed = finalStageView(dag({ state: "failed", round: 1, detail }), [], NOW);
        expect(states(failed)).toEqual(["passed", "passed", "failed", "notrun", "notrun"]);

        const malformed = [
            { ...ev("tree", S), detail: "{not json" },
            { ...ev("tree", S), detail: undefined },
        ];
        expect(finalStageView(dag({ state: "passed", round: 1 }), malformed, NOW).steps[0].ms).toBeUndefined();
    });

    it("totals the steps' times only when every step has one, the Verifier's from its session", () => {
        const final = { state: "passed", round: 1, verifierrunid: "v-run", startedts: NOW - 100 * S };
        const events = [ev("tree", 10 * S), ev("check", 20 * S), ev("verify", 30 * S), ev("final", 40 * S)];
        const whole = finalStageView(dag(final), events, NOW, { completedts: NOW - 40 * S });
        expect(whole.steps[4].ms).toBe(60 * S);
        expect(whole.stageMs).toBe(160 * S);
        expect(whole.elapsedMs).toBe(160 * S);

        expect(finalStageView(dag(final), events.slice(1), NOW, { completedts: NOW }).stageMs).toBeUndefined();
        const noRun = finalStageView(dag(final), events, NOW);
        expect(noRun.steps[4].ms).toBeUndefined();
        expect(noRun.stageMs).toBeUndefined();
        const noStart = finalStageView(dag({ ...final, startedts: 0 }), events, NOW, { completedts: NOW });
        expect(noStart.steps[4].ms).toBeUndefined();
    });

    it("starts the round at its earliest step event once a verifier has moved startedts", () => {
        const treeEnd = NOW - 300 * S;
        const final = { state: "verifying", round: 1, verifierrunid: "v-run", startedts: NOW - 60 * S };
        const events = [ev("check", 100 * S, true, 1, treeEnd + 100 * S), ev("tree", 40 * S, true, 1, treeEnd)];
        const v = finalStageView(dag(final), events, NOW);
        expect(v.stageMs).toBe(340 * S);
        expect(v.elapsedMs).toBe(60 * S);
        // no event left to say when the round began
        expect(finalStageView(dag(final), [], NOW).stageMs).toBeUndefined();
        // before a verifier starts, startedts is the round's own
        const early = { state: "checking", round: 1, step: "tree", stepts: NOW - 5 * S, startedts: NOW - 6 * S };
        expect(finalStageView(dag(early), [], NOW).stageMs).toBe(6 * S);
    });

    it("gives one line per earlier round, oldest first", () => {
        const pastfinals = [
            { state: "unverified", round: 2 },
            { state: "failed", round: 1, detail: "Final `x` failed (exit 1):\nnope" },
        ] as FinalStage[];
        const v = finalStageView(dag({ state: "", round: 3 }, { pastfinals }), [ev("final", S, false, 1)], NOW);
        expect(v.past).toEqual([
            {
                round: 1,
                tone: "fail",
                text: "round 1 · failed at Final",
                outcome: "failed at Final",
                detail: "Final `x` failed (exit 1):\nnope",
                hasShots: false,
            },
            {
                round: 2,
                tone: "warn",
                text: "round 2 · unverified",
                outcome: "unverified",
                detail: "",
                hasShots: false,
            },
        ]);
    });

    it("a past round failed at Verify keeps its detail and has no screenshots", () => {
        const detail = "Verify `node scripts/verify.mjs ./pkg/x` failed on the merged result (exit 1):\nFAIL";
        const pastfinals = [
            { state: "failed", round: 1, detail, shots: [{ name: "s", files: [] }] },
            { state: "passed", round: 2, shots: [{ name: "s", files: ["s.png"] }] },
        ] as FinalStage[];
        const v = finalStageView(dag({ state: "", round: 3 }, { pastfinals }), [], NOW);
        expect(v.past[0]).toMatchObject({ round: 1, text: "round 1 · failed at Verify", detail, hasShots: false });
        expect(v.past[1]).toMatchObject({ round: 2, detail: "", hasShots: true });
    });

    it("points each command step that ended at the output it kept, versioned by its end", () => {
        const outdir = "C:/data/final-shots/dag-1/1";
        const final = { state: "final", round: 1, step: "final", stepts: NOW, outdir, output: "booting" };
        const events = [
            ev("tree", S, true, 1, NOW - 3 * S),
            ev("check", S, true, 1, NOW - 2 * S),
            ev("verify", S, false, 1, NOW - S),
        ];
        const v = finalStageView(dag(final), events, NOW);
        const kept = Object.fromEntries(v.steps.map((s) => [s.key, s.kept]));
        expect(kept).toEqual({
            tree: undefined,
            check: { path: `${outdir}-steps/check.txt`, ts: NOW - 2 * S },
            verify: { path: `${outdir}-steps/verify.txt`, ts: NOW - S },
            final: undefined,
            verifier: undefined,
        });
        // the running Final opens its live tail; Tree and the Verifier have no output of their own
        expect(v.steps.filter((s) => finalStepOpens(v, s)).map((s) => s.key)).toEqual(["check", "verify", "final"]);
    });

    it("keeps no output for a step with no event, or a stage with no out dir", () => {
        const done = { state: "passed", round: 1 };
        expect(finalStageView(dag(done), [ev("check", S)], NOW).steps.some((s) => s.kept)).toBe(false);
        const withDir = { ...done, outdir: "/d/1" };
        expect(finalStageView(dag(withDir), [], NOW).steps.some((s) => s.kept)).toBe(false);
    });

    it("opens a running command only once it printed, and an ended one only when it kept output", () => {
        const final = { state: "checking", round: 1, step: "verify", stepts: NOW, outdir: "/d/1", output: "" };
        const events = [ev("tree", S), ev("check", S)];
        const quiet = finalStageView(dag(final), events, NOW);
        expect(quiet.steps.filter((s) => finalStepOpens(quiet, s)).map((s) => s.key)).toEqual(["check"]);
        const printing = finalStageView(dag({ ...final, output: "ok pkg/x" }), events, NOW);
        expect(printing.steps.filter((s) => finalStepOpens(printing, s)).map((s) => s.key)).toEqual([
            "check",
            "verify",
        ]);
    });

    it("is invisible with nothing running for no dag and for a dag with no tasks", () => {
        for (const v of [finalStageView(undefined, [], NOW), finalStageView(dag(undefined, { tasks: [] }), [], NOW)]) {
            expect(v.visible).toBe(false);
            expect(v.steps).toEqual([]);
            expect(v.running).toBeUndefined();
            expect(v.stepIndex).toBe(0);
        }
        const noList = finalStageView(
            dag({ state: "checking", round: 1, step: "check" }, { tasks: undefined }),
            [],
            NOW
        );
        expect(noList.visible).toBe(false);
        expect(noList.steps).toEqual([]);
    });

    it("starts the round at startedts when the Verifier is the only step, whatever session it runs in", () => {
        const final = { state: "verifying", round: 1, verifierrunid: "v-run", startedts: NOW - 60 * S };
        const v = finalStageView(dag(final, { check: "", verify: "", finalcmd: "" }), [], NOW);
        expect(v.stageMs).toBe(60 * S);
    });

    it("reads an unverified stage that gave no reasons as plain unverified, with no reasons listed", () => {
        const v = finalStageView(dag({ state: "unverified", round: 1 }, { status: "done" }), [], NOW);
        expect(v.subline).toBe("unverified");
        expect(v.unverified).toStrictEqual([]);
        expect(finalStageView(dag(undefined), [], NOW).unverified).toStrictEqual([]);
    });

    it("names a reviewing verifier that has no start time without a duration", () => {
        const final = { state: "verifying", round: 2, verifierrunid: "v-run", startedts: 0 };
        const v = finalStageView(dag(final), [], NOW);
        expect(v.subline).toBe("verifier reviewing");
        expect(v.nodeMeta).toBe("round 2 · verifier");
        expect(v.headline).toBe("round 2 · verifier reviewing");
    });

    it("between two commands the stage names no step, and the steps with an event have settled", () => {
        const final = { state: "checking", round: 2, step: "", stepts: NOW };
        const v = finalStageView(dag(final), [ev("tree", S, true, 2), ev("check", S, true, 2)], NOW);
        expect(states(v)).toEqual(["passed", "passed", "waiting", "waiting", "waiting"]);
        expect(v.running).toBeUndefined();
        expect(v.subline).toBe("starting");
        expect(v.nodeMeta).toBe("round 2 · starting");
        expect(v.headline).toBe("round 2 · starting");
    });

    it("a restarted step runs again, and the steps after it wait whatever their older events say", () => {
        const events = [ev("tree", 2 * S), ev("check", 3 * S), ev("verify", 4 * S)];
        const check = { state: "checking", round: 1, step: "check", stepts: NOW - 5 * S };
        const v = finalStageView(dag(check), events, NOW);
        expect(states(v)).toEqual(["passed", "running", "waiting", "waiting", "waiting"]);
        expect(times(v)).toEqual([2 * S, 5 * S, undefined, undefined, undefined]);

        const tree = { state: "checking", round: 1, step: "tree", stepts: NOW - S };
        expect(states(finalStageView(dag(tree), events, NOW))).toEqual([
            "running",
            "waiting",
            "waiting",
            "waiting",
            "waiting",
        ]);
    });

    it("with a Final command the Verifier waits for the commands, even once it has a session", () => {
        const final = { state: "final", round: 1, step: "final", stepts: NOW - S, verifierrunid: "v-run" };
        expect(states(finalStageView(dag(final), [], NOW))).toEqual([
            "passed",
            "passed",
            "passed",
            "running",
            "waiting",
        ]);
    });

    it("with no detail, an ended stage stops at the last step that ran when that one is not ok", () => {
        const events = [ev("tree", S), ev("check", S), ev("verify", S, false)];
        const v = finalStageView(dag({ state: "failed", round: 1 }), events, NOW);
        expect(states(v)).toEqual(["passed", "passed", "failed", "notrun", "notrun"]);
    });

    it("with no detail, an ended stage whose last step was ok is left to the Verifier", () => {
        const events = [ev("tree", S), ev("check", S), ev("verify", S), ev("final", S)];
        const v = finalStageView(dag({ state: "failed", round: 1 }), events, NOW);
        expect(states(v)).toEqual(["passed", "passed", "passed", "passed", "failed"]);
    });

    it("an unverified stage whose last command could not verify leaves the Verifier unverified too", () => {
        const events = [ev("tree", S), ev("check", S), ev("verify", S), ev("final", S, false)];
        const final = { state: "unverified", round: 1, unverified: ["the Final command could not verify"] };
        const v = finalStageView(dag(final), events, NOW);
        expect(states(v)).toEqual(["passed", "passed", "passed", "unverified", "unverified"]);
    });

    it("reads only a detail that opens with a command's name as that command's failure", () => {
        const events = [ev("tree", S), ev("check", S), ev("verify", S)];
        const final = { state: "failed", round: 1, detail: "defects: the Check `go build` output is stale" };
        const v = finalStageView(dag({ ...final, verifierrunid: "v-run" }, { finalcmd: "" }), events, NOW);
        expect(states(v)).toEqual(["passed", "passed", "passed", "failed"]);
    });

    it("gives a step the stage ended before, or has not reached, no time of its own", () => {
        const final = {
            state: "failed",
            round: 1,
            detail: "Check `go build` failed (exit 1):\nx",
            verifierrunid: "v-run",
            startedts: NOW - 100 * S,
        };
        const events = [ev("tree", S), ev("check", 2 * S, false), ev("verify", 5 * S)];
        const ended = finalStageView(dag(final, { finalcmd: "" }), events, NOW, { completedts: NOW - 40 * S });
        expect(states(ended)).toEqual(["passed", "failed", "notrun", "notrun"]);
        expect(times(ended)).toEqual([S, 2 * S, undefined, undefined]);
        expect(ended.steps.map((s) => s.text)).toEqual(["passed 1s", "failed 2s", "not run", "not run"]);

        const waiting = { state: "", round: 2, verifierrunid: "v-run", startedts: NOW - 100 * S };
        const next = finalStageView(dag(waiting), [ev("check", 3 * S, true, 2)], NOW, { completedts: NOW });
        expect(states(next)).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
        expect(times(next)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    });

    it("reads a stage not started, with every task done, as starting", () => {
        const v = finalStageView(dag(undefined), [], NOW);
        expect(v.subline).toBe("starting");
        expect(v.nodeMeta).toBe("round 1 · starting");
        expect(v.headline).toBe("round 1 · starting");
    });

    it("a later round with no task left to fix reads as the round alone", () => {
        const v = finalStageView(dag({ state: "", round: 2 }), [], NOW);
        expect(v.subline).toBe("round 2");
        expect(v.nodeMeta).toBe("round 2");
        expect(v.headline).toBe("round 2");
    });
});

describe("finalStageView, the end review", () => {
    const keys = (v: FinalStageView) => v.steps.map((s) => s.key);
    const stateOf = (v: FinalStageView, key: string) => v.steps.find((s) => s.key === key)?.state;
    const reviewing = (over: Partial<FinalEndReview> = {}): FinalEndReview => ({ state: "reviewing", ...over });
    const commandsOk = [ev("tree", 41 * S), ev("check", 18 * S), ev("verify", 300 * S), ev("final", 125 * S)];

    it("adds an End review step before the Verifier, with or without commands", () => {
        const endreview = reviewing();
        expect(keys(finalStageView(dag({ state: "checking", round: 1, endreview }), [], NOW))).toEqual([
            "tree",
            "check",
            "verify",
            "final",
            "review",
            "verifier",
        ]);
        const bare = dag({ state: "verifying", round: 1, endreview }, { check: "", verify: "", finalcmd: "" });
        const v = finalStageView(bare, [], NOW);
        expect(keys(v)).toEqual(["review", "verifier"]);
        expect(v.steps[0].label).toBe("End review");
    });

    it("reviews beside a running Verify: running, and the subline and activity name it alongside", () => {
        const stepts = NOW - 192 * S;
        const final = {
            state: "checking",
            round: 1,
            step: "verify",
            stepts,
            endreview: reviewing({ startedts: NOW - 250 * S }),
        };
        const v = finalStageView(dag(final), [ev("tree", 41 * S), ev("check", 18 * S)], NOW);
        expect(states(v)).toEqual(["passed", "passed", "running", "waiting", "running", "waiting"]);
        expect(v.running).toBe("verify");
        expect(v.subline).toBe("Verify · 3m 12s · end review alongside");
        expect(v.steps[4].text).toBe("running 4m 10s");
        expect(finalStageActivity(final)).toBe("running Verify · end review alongside");
    });

    it("names both beside a command when the verifier works alongside too", () => {
        const final = {
            state: "checking",
            round: 1,
            step: "check",
            stepts: NOW - 11 * S,
            verifierrunid: "v-run",
            endreview: reviewing(),
        };
        const v = finalStageView(dag(final, { finalcmd: "" }), [ev("tree", 30 * S)], NOW);
        expect(v.subline).toBe("Check · 11s · verifier and end review alongside");
        expect(finalStageActivity(final)).toBe("running Check · verifier and end review alongside");
    });

    it("names the end review in the headline while the stage waits only on it", () => {
        const endreview = reviewing({ startedts: NOW - 62 * S, waiting: true, judged: true });
        const final = { state: "verifying", round: 1, verifierrunid: "v-run", endreview };
        const v = finalStageView(dag(final), commandsOk, NOW);
        expect(states(v)).toEqual(["passed", "passed", "passed", "passed", "running", "passed"]);
        expect(v.running).toBe("review");
        expect(v.headline).toBe("round 1 · end review reviewing · 1m 02s");
        expect(finalStageActivity(final)).toBe("end review reviewing");
    });

    it("a detail that is only the end review's fails its step, and leaves the commands and the Verifier unfailed", () => {
        const final = {
            state: "failed",
            round: 1,
            verifierrunid: "v-run",
            detail: "[End review] t-2's test asserts nothing",
            endreview: { state: "failed", text: "t-2's test asserts nothing" },
        };
        const v = finalStageView(dag(final, { status: "blocked" }), [...commandsOk, ev("review", 400 * S, false)], NOW);
        expect(states(v)).toEqual(["passed", "passed", "passed", "passed", "failed", "passed"]);
        expect(v.subline).toBe("failed at End review · round 1");
        expect(v.detail).toBe("[End review] t-2's test asserts nothing");
    });

    it("a command's failure beside the end review's fails both, and the Verifier did not run", () => {
        const final = {
            state: "failed",
            round: 1,
            detail: "Final `x` failed (exit 1):\nsteps 4 and 5\n\n[End review] t-2's test asserts nothing",
            endreview: { state: "failed", text: "t-2's test asserts nothing" },
        };
        const events = [ev("tree", 41 * S), ev("check", 18 * S), ev("verify", 300 * S), ev("final", 125 * S, false)];
        const v = finalStageView(dag(final, { status: "blocked" }), events, NOW);
        expect(states(v)).toEqual(["passed", "passed", "passed", "failed", "failed", "notrun"]);
    });

    it("reads a lost end review as failed and its reason apart from the Verifier's verdict", () => {
        const final = {
            state: "unverified",
            round: 1,
            verifierrunid: "v-run",
            unverified: ["the end review did not finish: its session exited twice"],
            endreview: { state: "lost", text: "its session exited twice" },
        };
        const v = finalStageView(dag(final, { status: "done" }), commandsOk, NOW);
        expect(stateOf(v, "review")).toBe("failed");
        expect(stateOf(v, "verifier")).toBe("passed");
    });

    it("leaves the parallel end review out of a passed stage's total", () => {
        const final = {
            state: "passed",
            round: 1,
            verifierrunid: "v-run",
            startedts: NOW - 400 * S,
            endreview: { state: "passed" },
        };
        const events = [...commandsOk, ev("review", 600 * S)];
        const v = finalStageView(dag(final, { status: "done" }), events, NOW, { completedts: NOW });
        expect(states(v)).toEqual(Array(6).fill("passed"));
        // 41s + 18s + 5m + 2m 05s and the Verifier's 6m 40s
        expect(v.subline).toBe("passed · 14m 44s");
    });
});

describe("finalStageActivity", () => {
    const at = (state: string, step?: string, verifierrunid?: string) =>
        finalStageActivity({ state, round: 1, step, verifierrunid });

    it("says what the running step is doing", () => {
        expect(at("verifying")).toBe("verifier reviewing");
        expect(at("checking", "tree")).toBe("preparing the tree");
        expect(at("checking", "check")).toBe("running Check");
        expect(at("checking", "verify")).toBe("running Verify");
        expect(at("final", "final")).toBe("running Final");
        expect(at("checking", "")).toBe("starting");
        expect(at("final")).toBe("starting");
    });

    it("shows the verifier alongside only for a checking stage that has one", () => {
        expect(at("checking", "check", "v-run")).toBe("running Check · verifier alongside");
        expect(at("checking", "check")).toBe("running Check");
        expect(at("final", "final", "v-run")).toBe("running Final");
    });

    it("is undefined when no step runs", () => {
        for (const state of ["", "passed", "failed", "unverified"]) {
            expect(at(state, "check")).toBeUndefined();
        }
        expect(finalStageActivity(undefined)).toBeUndefined();
    });
});

describe("the stage's focus id", () => {
    it("round-trips the run id", () => {
        const id = finalStageId("lead-run");
        expect(isFinalStageId(id)).toBe(true);
        expect(finalStageRunId(id)).toBe("lead-run");
        expect(isFinalStageId("ended:lead-run:t-1")).toBe(false);
        expect(finalStageRunId("agent-1")).toBeUndefined();
    });

    it("focuses the verifier agent only when it holds the current round's verifier run", () => {
        const run = { runId: "lead-run", dag: dag({ state: "verifying", round: 2, verifierrunid: "v-2" }) };
        const earlier = { id: "tab-old", runId: "v-1" };
        expect(finalRowFocusId(run, [earlier, { id: "tab-new", runId: "v-2" }])).toBe("tab-new");
        expect(finalRowFocusId(run, [earlier])).toBe(finalStageId("lead-run"));
        expect(finalRowFocusId(run, [])).toBe(finalStageId("lead-run"));
        const noVerifier = { runId: "lead-run", dag: dag({ state: "checking", round: 1 }) };
        expect(finalRowFocusId(noVerifier, [{ id: "plain", runId: undefined }])).toBe(finalStageId("lead-run"));
    });
});

describe("outputTail", () => {
    it("keeps the last lines", () => {
        expect(outputTail("a\nb\r\nc\nd\n", 3)).toBe("b\nc\nd");
        expect(outputTail("a\nb", 5)).toBe("a\nb");
        expect(outputTail("a\nb", 0)).toBe("");
        expect(outputTail("", 3)).toBe("");
    });
});

describe("finalStageView, memory holds", () => {
    const GB = 1024 ** 3;
    const memory = (kind: string, ts: number, detail: object): RunEvent => ({
        id: `m-${ts}-${kind}`,
        runid: "lead-run",
        channelid: "ch",
        ts,
        kind,
        detail: JSON.stringify(detail),
    });
    const held = (role: string, ts: number, taskid = "") =>
        memory("memory-held", ts, { taskid, role, free: 2.1 * GB, need: 3.5 * GB });
    const running = (step: string, round = 1) => ({
        state: "checking",
        round,
        step,
        stepts: NOW - 5 * S,
        startedts: 1,
    });
    const detailOfStep = (v: FinalStageView, key: string) => v.steps.find((s) => s.key === key)?.memory;

    it("final step waiting for memory", () => {
        const v = finalStageView(dag(running("check")), [held("Check", NOW - 4 * S)], NOW);
        expect(detailOfStep(v, "check")).toBe("waiting for memory · 2.1 GB free, 3.5 GB needed");
        // only the running step's own command shows it
        expect(v.steps.filter((s) => s.memory != null).map((s) => s.key)).toEqual(["check"]);

        const admitted = [
            held("Check", NOW - 4 * S),
            memory("memory-admitted", NOW - 2 * S, { taskid: "", role: "Check" }),
        ];
        expect(detailOfStep(finalStageView(dag(running("check")), admitted, NOW), "check")).toBeUndefined();

        // a task's hold and another command's hold are not this step's
        const others = [held("Check", NOW - 4 * S, "t-3"), held("Verify", NOW - 4 * S)];
        expect(detailOfStep(finalStageView(dag(running("check")), others, NOW), "check")).toBeUndefined();
    });

    it("previous round's hold is not shown", () => {
        const events = [
            held("Verify", NOW - 60 * S),
            memory("final-ended", NOW - 30 * S, { round: 1, outcome: "failed" }),
        ];
        const v = finalStageView(dag(running("verify", 2)), events, NOW);
        expect(detailOfStep(v, "verify")).toBeUndefined();

        const again = [...events, held("Verify", NOW - 10 * S)];
        expect(detailOfStep(finalStageView(dag(running("verify", 2)), again, NOW), "verify")).toBe(
            "waiting for memory · 2.1 GB free, 3.5 GB needed"
        );
    });
});

describe("finalFailedNote", () => {
    it("says the lead is asking about the failure, and that a rerun is the human's call", () => {
        expect(finalFailedNote({ asking: true })).toBe(
            "The lead is asking you about this failure. Rerun it if the failure was outside the code."
        );
    });

    it("leaves the failure with a lead that is not asking", () => {
        expect(finalFailedNote({ asking: false })).toBe("The lead has this failure and decides what happens next.");
    });

    it("hands the failure to the human when there is no lead", () => {
        expect(finalFailedNote(undefined)).toBe("This failure is yours. Rerun it if the failure was outside the code.");
    });
});

describe("the pane's step decisions", () => {
    const GO_FAIL = "--- FAIL: TestPlan (0.00s)\n    plan_test.go:88: want 3 tasks, got 1\nFAIL\nFAIL\tpkg/x\t0.1s\n";
    const OUTDIR = "/d/1";
    const kept = (status: FinalKept["status"], text = ""): FinalKept => ({ status, text });
    const step = (v: FinalStageView, key: string) => v.steps.find((s) => s.key === key);
    const verifyCmd = { verify: "go test ./..." };

    const failedAt = (name: string, over: Partial<TaskGroup> = {}) => {
        const detail = `${name} \`x\` failed (exit 1):\nboom`;
        const events = [ev("tree", S), ev("check", S, name !== "Check"), ev("verify", S, name !== "Verify")];
        const final = { state: "failed", round: 1, detail, outdir: OUTDIR };
        return finalStageView(dag(final, over), events, NOW);
    };

    it("a running command's body is its tail, even when the output parses as tests", () => {
        const final = { state: "checking", round: 1, step: "verify", stepts: NOW, output: GO_FAIL, outdir: OUTDIR };
        const v = finalStageView(dag(final, verifyCmd), [ev("tree", S), ev("check", S)], NOW);
        expect(finalStepBody(v, step(v, "verify"), kept("loading"))).toEqual({
            kind: "tail",
            command: "go test ./...",
            output: GO_FAIL,
        });
    });

    it("a failed Verify whose kept go output parses is a card with no error", () => {
        const v = failedAt("Verify", verifyCmd);
        const body = finalStepBody(v, step(v, "verify"), kept("ok", GO_FAIL));
        expect(body).toMatchObject({ kind: "card", output: GO_FAIL, summary: { runner: "go", fail: 1 } });
        expect(body).not.toHaveProperty("error");
    });

    it("a failed Check that is no test run is a panel carrying the stage's detail as its error", () => {
        const v = failedAt("Check", { check: "tsc --noEmit" });
        expect(finalStepBody(v, step(v, "check"), kept("ok", "src/a.ts(1,1): error TS2322"))).toEqual({
            kind: "panel",
            command: "tsc --noEmit",
            output: "src/a.ts(1,1): error TS2322",
            error: v.detail,
        });
    });

    it("an empty kept output is a panel noting it, and a loading one its loading line with no error", () => {
        const v = failedAt("Check", { check: "tsc --noEmit" });
        const check = step(v, "check");
        expect(finalStepBody(v, check, kept("ok"))).toMatchObject({ kind: "panel", note: KEPT_NOTE.ok });
        expect(KEPT_NOTE.ok).toBe("the step printed nothing");
        const loading = finalStepBody(v, check, kept("loading"));
        expect(loading).toMatchObject({ kind: "panel", note: KEPT_NOTE.loading });
        expect(loading).not.toHaveProperty("error");
        expect(finalStepBody(v, check, kept("missing"))).toMatchObject({ note: KEPT_NOTE.missing, error: v.detail });
    });

    it("a passed step's unparsed kept output is a plain panel", () => {
        const v = finalStageView(dag({ state: "passed", round: 1, outdir: OUTDIR }), [ev("check", S)], NOW);
        expect(finalStepBody(v, step(v, "check"), kept("ok", "built"))).toEqual({
            kind: "panel",
            command: "go build ./cmd/wsh/...",
            output: "built",
        });
    });

    const FINDINGS = "[End review] t-2's test asserts nothing";
    const FINAL_FAILED = "Final `x` failed (exit 1):\nboom";
    const endReviewFailed = { state: "failed", text: "t-2's test asserts nothing" };

    it.each([
        ["Verifier", { state: "failed", round: 1, detail: "defects", verifierrunid: "v-run" }, "", "defects"],
        ["a human ended the stage", { state: "failed", round: 1, detail: HUMAN }, "", HUMAN],
        ["a command that kept output", { state: "failed", round: 1, detail: FINAL_FAILED }, "final", ""],
        [
            "a command that kept output and a failed end review",
            { state: "failed", round: 1, detail: `${FINAL_FAILED}\n\n${FINDINGS}`, endreview: endReviewFailed },
            "final",
            FINDINGS,
        ],
    ])("draws above the box for %s", (_name, final, failedStep, above) => {
        const events = ["tree", "check", "verify", "final"].map((s) => ev(s, S, s !== failedStep));
        const v = finalStageView(dag({ ...final, outdir: OUTDIR }), events, NOW);
        expect(finalDetailAbove(v)).toBe(above);
    });

    it("a failed Check's panel error is the command's part alone when the end review also failed", () => {
        const command = "Check `x` failed (exit 1):\nboom";
        const final = {
            state: "failed",
            round: 1,
            detail: `${command}\n\n${FINDINGS}`,
            endreview: endReviewFailed,
            outdir: OUTDIR,
        };
        const v = finalStageView(dag(final, { check: "tsc --noEmit" }), [ev("tree", S), ev("check", S, false)], NOW);
        expect(finalStepBody(v, step(v, "check"), kept("ok", "src/a.ts(1,1): error TS2322"))).toMatchObject({
            kind: "panel",
            error: command,
        });
    });

    it("opens the running command with output and the failed step with kept output, no other", () => {
        const final = { state: "checking", round: 1, step: "verify", stepts: NOW, output: "ok", outdir: OUTDIR };
        const running = finalStageView(dag(final), [ev("tree", S), ev("check", S)], NOW);
        const opens = running.steps.filter((s) => finalStepOpensByDefault(running, s)).map((s) => s.key);
        expect(opens).toEqual(["verify"]);
        const quiet = finalStageView(dag({ ...final, output: "" }), [ev("tree", S), ev("check", S)], NOW);
        expect(quiet.steps.some((s) => finalStepOpensByDefault(quiet, s))).toBe(false);

        const failed = failedAt("Verify");
        expect(failed.steps.filter((s) => finalStepOpensByDefault(failed, s)).map((s) => s.key)).toEqual(["verify"]);
    });

    it("reads a failed step's exit code from the detail's first line, else says failed", () => {
        const v = failedAt("Verify");
        expect(finalStepExit(v, step(v, "verify"))).toBe("exit 1");
        const final = { state: "failed", round: 1, detail: "Final `x` failed (timed out after 10m):\nlate" };
        const events = [ev("tree", S), ev("check", S), ev("verify", S), ev("final", S, false)];
        const timedOut = finalStageView(dag(final), events, NOW);
        expect(finalStepExit(timedOut, step(timedOut, "final"))).toBe("failed");
    });
});
