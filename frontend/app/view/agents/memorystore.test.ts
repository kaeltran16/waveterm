// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    applyMemoryGroup,
    decideMemory,
    memoryErrorAtom,
    memoryProjectsAtom,
    memorySelectedChangeAtom,
    memorySelectedProjectAtom,
    memorySelection,
} from "./memorystore";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        DecideMemoryChangeCommand: vi.fn(),
        ListMemoryHygieneCommand: vi.fn(),
        CheckMemoryHygieneCommand: vi.fn(),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));

const decide = vi.mocked(RpcApi.DecideMemoryChangeCommand);

function change(id: string, group: string, status = "open"): MemChange {
    return {
        id,
        kind: group === "switch" ? "settings" : "move-here",
        group,
        title: id,
        note: "",
        applylabel: "",
        effect: "",
        files: [],
        evidence: [],
        diffs: [],
        indexdelta: { lines: 0, bytes: 0 },
        ownindexdelta: { lines: 0, bytes: 0 },
        op: {} as MemOp,
        status,
        conflictfile: "",
        decidedat: 0,
        backupuntil: 0,
        applyid: "",
    };
}

function project(name: string, changes: MemChange[], split = false): MemHygieneProject {
    return {
        project: name,
        path: `C:\\src\\${name}`,
        checkedat: 1,
        nextcheckat: 2,
        checking: false,
        lasterror: "",
        memories: 0,
        sessions: 0,
        folder: `C:/claude/projects/${name}/memory`,
        sharedwith: split ? ["other"] : [],
        ownfolder: "",
        formershared: "",
        switchedat: 0,
        index: { exists: true, lines: 1, bytes: 1 },
        changes,
    };
}

// the backend's answer to an apply: the project with that change applied
function applying(p: MemHygieneProject): void {
    decide.mockImplementation(async (_c, data) => {
        const cur = globalStore.get(memoryProjectsAtom)!.find((x) => x.project === data.project)!;
        return {
            ...cur,
            changes: cur.changes.map((c) => (c.id === data.changeid ? { ...c, status: "applied" } : c)),
        };
    });
    globalStore.set(memoryProjectsAtom, [p]);
}

beforeEach(() => {
    decide.mockReset();
    globalStore.set(memoryProjectsAtom, null);
    globalStore.set(memorySelectedProjectAtom, null);
    globalStore.set(memorySelectedChangeAtom, null);
    globalStore.set(memoryErrorAtom, null);
});

describe("F11: a verdict keeps the decided change selected", () => {
    it("the last pending change, shown by default and applied, stays selected with Undo", async () => {
        applying(project("own", [change("a", "", "applied"), change("b", "")]));
        expect(memorySelection().change?.id).toBe("b");
        expect(globalStore.get(memorySelectedChangeAtom)).toBeNull();

        await decideMemory("own", "b", "apply");

        expect(globalStore.get(memoryErrorAtom)).toBeNull();
        expect(globalStore.get(memorySelectedChangeAtom)).toBe("b");
        expect(memorySelection().change?.id).toBe("b");
        expect(memorySelection().change?.status).toBe("applied");
    });

    it("stays on the project shown by default once its last change is decided", async () => {
        applying(project("own", [change("b", "")]));
        globalStore.set(memoryProjectsAtom, [
            ...globalStore.get(memoryProjectsAtom)!,
            project("next", [change("n", "")]),
        ]);
        expect(memorySelection().project?.project).toBe("own");

        await decideMemory("own", "b", "apply");

        expect(memorySelection().project?.project).toBe("own");
        expect(memorySelection().change?.id).toBe("b");
    });

    it("moves on to the next change still to review when there is one", async () => {
        applying(project("own", [change("a", ""), change("b", "")]));
        await decideMemory("own", "a", "apply");
        expect(memorySelection().change?.id).toBe("b");
    });

    it("the last id of an Apply all, shown by default, stays selected once nothing is pending", async () => {
        applying(project("split", [change("m1", "shared"), change("m2", "shared")], true));
        expect(memorySelection().change?.id).toBe("m1");

        await applyMemoryGroup("split", "shared", ["m1", "m2"]);

        expect(globalStore.get(memorySelectedChangeAtom)).toBe("m1");
        expect(memorySelection().change?.status).toBe("applied");
    });

    it("an Apply all that leaves a pending change outside its group advances to that change", async () => {
        applying(
            project(
                "split",
                [change("m1", "shared"), change("m2", "shared"), change("o1", "own"), change("s1", "switch")],
                true
            )
        );
        await applyMemoryGroup("split", "shared", ["m1", "m2"]);
        expect(memorySelection().change?.id).toBe("o1");
        expect(globalStore.get(memorySelectedChangeAtom)).toBe("o1");
    });
});
