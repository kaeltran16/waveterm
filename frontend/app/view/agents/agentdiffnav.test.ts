// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { describe, expect, it, vi } from "vitest";

const requestFileLink = vi.fn();
vi.mock("./filesstore", () => ({ requestFileLink: (...a: any[]) => requestFileLink(...a) }));

import { agentDiffScope, openDiff, runDiffScope } from "./agentdiffnav";
import { scopeKey } from "./diffscope";
import { diffScopeAtom } from "./diffscopeatom";

const surfaceAtom = atom("cockpit");
const model = { diffScopeAtom, surfaceAtom } as any;

describe("openDiff", () => {
    it("stores the scope and switches to the Diff surface", () => {
        const scope = agentDiffScope("a1", "jarvis-recall");
        openDiff(model, scope);
        expect(globalStore.get(diffScopeAtom)).toEqual(scope);
        expect(globalStore.get(surfaceAtom)).toBe("files");
    });

    // The link and the load must name the scope with the same string, or the request is never claimed
    // and the surface opens on its first file instead of the one that was clicked.
    it("requests the file link under the same key the loader will use", () => {
        requestFileLink.mockClear();
        const scope = runDiffScope("r1", "/repo", "9f2c1de");
        openDiff(model, scope, "pkg/jarvis/evidence.go");
        expect(requestFileLink).toHaveBeenCalledWith(scopeKey(scope), "pkg/jarvis/evidence.go");
    });

    it("skips the link request when no file was named", () => {
        requestFileLink.mockClear();
        openDiff(model, agentDiffScope("a1", "jarvis-recall"));
        expect(requestFileLink).not.toHaveBeenCalled();
    });

    it("opens a run on the run range and an agent on its session range", () => {
        expect(runDiffScope("r1", "/repo", "9f2c1de").range).toEqual({
            kind: "run",
            runId: "r1",
            baseCommit: "9f2c1de",
        });
        expect(agentDiffScope("a1", "n").range).toEqual({ kind: "session", agentId: "a1" });
    });

    it("carries the run's directory and base commit, which exist nowhere else to be re-resolved", () => {
        expect(runDiffScope("r1", "/repo", "9f2c1de").repo.origin).toEqual({
            kind: "run",
            runId: "r1",
            cwd: "/repo",
            baseCommit: "9f2c1de",
        });
    });

    it("degrades a missing base commit to the live diff rather than undefined", () => {
        expect(runDiffScope("r2", "/repo").repo.origin).toEqual({
            kind: "run",
            runId: "r2",
            cwd: "/repo",
            baseCommit: "",
        });
    });
});
