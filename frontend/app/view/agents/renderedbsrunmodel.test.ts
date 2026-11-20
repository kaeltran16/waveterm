// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it } from "vitest";
import { brainstormClosedAtom, closeDetail, closedRowText, goneView, recordClose } from "./renderedbsrunmodel";

const PATH = "C:\\proj\\.superpowers\\brainstorm\\run-memory-pressure\\brainstorm.json";

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

    it("a removed brainstorm says its file is gone, with why, and that the answers stay", () => {
        const v = goneView("removed", { topic: "run-memory-pressure", path: PATH, error: null }, {});
        expect(v).toMatchObject({ kind: "removed", title: "run-memory-pressure's brainstorm file is gone" });
        expect(v.kind === "removed" && v.text).toContain("It is no longer at");
        expect(v.kind === "removed" && v.text).toContain("The answers above stay in the transcript.");
    });

    it.each([
        ["a line that names the path draws no path of its own", PATH, null],
        [
            "a run worktree's line does not name the path, so the path is drawn under it",
            "C:\\Users\\k\\arc-wt\\9ce70819\\.superpowers\\brainstorm\\t\\brainstorm.json",
            "C:\\Users\\k\\arc-wt\\9ce70819\\.superpowers\\brainstorm\\t\\brainstorm.json",
        ],
    ])("a removed brainstorm: %s", (_why, path, expected) => {
        const v = goneView("removed", { topic: "t", path, error: null }, {});
        expect(v.kind === "removed" && v.path).toBe(expected);
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
