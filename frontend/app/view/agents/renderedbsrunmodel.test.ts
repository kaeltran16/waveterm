// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it } from "vitest";
import {
    brainstormClosedAtom,
    brainstormSwitchShown,
    closeDetail,
    closedRowText,
    goneView,
    recordClose,
    runCardView,
} from "./renderedbsrunmodel";
import type { RunInfo } from "./runlineage";

const RUN_ID = "3f9a1c2e-0000-4000-8000-000000000001";
const SHA = "9c1e2f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PATH = "C:\\proj\\.superpowers\\brainstorm\\run-memory-pressure\\brainstorm.json";

function runInfo(patch: Partial<RunInfo>): RunInfo {
    return { runId: RUN_ID, channelId: "ch", title: "t", project: "p", base: "main", ...patch } as RunInfo;
}

const MERGED = (finalState: string) =>
    runInfo({
        land: { state: "landed", commit: SHA },
        dag: { final: { state: finalState, round: 1 }, tasks: [] } as unknown as RunInfo["dag"],
    });

describe("runCardView", () => {
    it("heads a building run with its short id and the pane's headline and detail", () => {
        const run = runInfo({
            dag: {
                status: "running",
                tasks: [
                    { id: "t-1", state: "done", merged: true },
                    { id: "t-2", state: "" },
                ],
            } as unknown as RunInfo["dag"],
        });
        const v = runCardView(RUN_ID, run, true, "run-memory-pressure", "final-queue");
        expect(v.status).toBe("Run 3f9a1c2e");
        expect(v.view.state).toBe("building");
        expect(v.headline).toBe("The run is building: 1 of 2 tasks landed");
        expect(v.detail).toContain("Then the final check verifies the whole");
        expect(v.canClose).toBe(false);
        expect(v.showOpen).toBe(true);
    });

    it("merged with the final check passed offers Close with the pane's close detail", () => {
        const v = runCardView(RUN_ID, MERGED("passed"), true, "run-memory-pressure", "final-queue");
        expect(v.headline).toBe("Built and merged into main at 9c1e2f0");
        expect(v.canClose).toBe(true);
        expect(v.detail).toBe(closeDetail("run-memory-pressure", "final-queue"));
        expect(v.detail).toContain(
            "closing deletes .superpowers/brainstorm/run-memory-pressure and the final-queue canvas."
        );
    });

    it("merged with a failed final check says the brainstorm stays and offers no Close", () => {
        const v = runCardView(RUN_ID, MERGED("failed"), true, "run-memory-pressure", "final-queue");
        expect(v.view.merged).toBe(true);
        expect(v.canClose).toBe(false);
        expect(v.detail).toBe("The final check did not pass, so the brainstorm stays.");
    });

    it("hides Open run for a run Arc cannot find", () => {
        const v = runCardView(RUN_ID, undefined, true, "run-memory-pressure", undefined);
        expect(v.view.state).toBe("missing");
        expect(v.showOpen).toBe(false);
    });
});

describe("closeDetail", () => {
    it("names only the brainstorm folder when there is no canvas", () => {
        expect(closeDetail("t", undefined)).toContain("closing deletes .superpowers/brainstorm/t.");
    });
});

describe("goneView", () => {
    beforeEach(() => globalStore.set(brainstormClosedAtom, {}));

    it("an unreadable brainstorm shows the parse error and the path", () => {
        const v = goneView("unreadable", { topic: "t", path: PATH, error: "Unexpected end of JSON input" }, {});
        expect(v).toEqual({
            kind: "unreadable",
            title: "Arc could not read this brainstorm",
            error: "Unexpected end of JSON input",
            path: PATH,
        });
    });

    it("a removed brainstorm says its file is gone, with why and what the switch does", () => {
        const v = goneView("removed", { topic: "run-memory-pressure", path: PATH, error: null }, {});
        expect(v).toMatchObject({ kind: "removed", title: "run-memory-pressure's brainstorm file is gone" });
        expect(v.kind === "removed" && v.text).toContain("It is no longer at");
        expect(v.kind === "removed" && v.text).toContain(
            "The Brainstorm switch in the header goes with it; the answers above stay in the transcript."
        );
    });

    it("a removed brainstorm with a close record is the closed row, naming the canvas deleted", () => {
        recordClose(PATH, { topic: "run-memory-pressure", canvas: "final-queue" });
        const v = goneView(
            "removed",
            { topic: "run-memory-pressure", path: PATH, error: null },
            globalStore.get(brainstormClosedAtom)
        );
        expect(v).toEqual({
            kind: "closed",
            text: "You closed the brainstorm · its file and the final-queue canvas were deleted",
        });
    });

    it("a close record for another brainstorm does not turn this one into a closed row", () => {
        recordClose("C:\\other\\brainstorm.json", { topic: "x" });
        const v = goneView(
            "removed",
            { topic: "run-memory-pressure", path: PATH, error: null },
            globalStore.get(brainstormClosedAtom)
        );
        expect(v.kind).toBe("removed");
    });

    it("an unreadable brainstorm never reads as closed", () => {
        recordClose(PATH, { topic: "t" });
        const v = goneView(
            "unreadable",
            { topic: "t", path: PATH, error: "bad" },
            globalStore.get(brainstormClosedAtom)
        );
        expect(v.kind).toBe("unreadable");
    });
});

describe("closedRowText", () => {
    it("says only the file was deleted for a brainstorm with no canvas", () => {
        expect(closedRowText({ topic: "t" })).toBe("You closed the brainstorm · its file was deleted");
    });
});

describe("recordClose", () => {
    beforeEach(() => globalStore.set(brainstormClosedAtom, {}));

    it("keeps each brainstorm's record under its own path", () => {
        recordClose("a", { topic: "a" });
        recordClose("b", { topic: "b", canvas: "c" });
        expect(globalStore.get(brainstormClosedAtom)).toEqual({ a: { topic: "a" }, b: { topic: "b", canvas: "c" } });
    });
});

describe("brainstormSwitchShown", () => {
    it("drops the switch for a removed brainstorm while Rendered shows", () => {
        expect(brainstormSwitchShown({ removed: true, mode: "terminal" }, true)).toBe(false);
    });

    it("keeps it for a live brainstorm", () => {
        expect(brainstormSwitchShown({ removed: false, mode: "terminal" }, true)).toBe(true);
    });

    it("keeps it while the pane shows the removed view, so the user can go back", () => {
        expect(brainstormSwitchShown({ removed: true, mode: "brainstorm" }, true)).toBe(true);
    });

    it("keeps it off the Rendered view", () => {
        expect(brainstormSwitchShown({ removed: true, mode: "terminal" }, false)).toBe(true);
    });
});
