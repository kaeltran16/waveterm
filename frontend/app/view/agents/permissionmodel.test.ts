import { describe, expect, it } from "vitest";
import type { AgentEntry } from "./agentsviewmodel";
import {
    anchorMarks,
    bandRequests,
    permissionLogText,
    permissionPreview,
    permissionTitle,
    placeMarks,
    relativeToCwd,
} from "./permissionmodel";
import type { LayoutItem } from "./transcriptlayout";

function perm(toolname: string, input: unknown, choices = ["Yes", "No, tell Claude what to do"]): AgentPermissionData {
    return {
        oref: "block:a",
        permid: "p1",
        toolname,
        toolinput: typeof input === "string" ? input : JSON.stringify(input),
        choices,
        ts: 1,
    };
}

describe("bandRequests", () => {
    const ask = perm("AskUserQuestion", {});
    const bash = perm("Bash", { command: "ls" });

    it("never draws an AskUserQuestion at the head", () => {
        expect(bandRequests([ask])).toEqual([]);
        expect(bandRequests([ask, bash])).toEqual([]);
    });

    it("draws any other head", () => {
        expect(bandRequests([bash, ask])).toEqual([bash, ask]);
        expect(bandRequests([bash])).toEqual([bash]);
        expect(bandRequests([])).toEqual([]);
    });
});

describe("permissionTitle", () => {
    it("names the file for the edit tools", () => {
        for (const tool of ["Edit", "Write", "MultiEdit"]) {
            expect(permissionTitle(perm(tool, { file_path: "pkg/a.go" }))).toBe("Allow an edit to pkg/a.go?");
        }
        expect(permissionTitle(perm("NotebookEdit", { notebook_path: "n.ipynb" }))).toBe("Allow an edit to n.ipynb?");
    });

    it("has fixed titles for Bash and plan approval, and names any other tool", () => {
        expect(permissionTitle(perm("Bash", { command: "ls" }))).toBe("Allow this command?");
        expect(permissionTitle(perm("ExitPlanMode", { plan: "# p" }))).toBe("Approve this plan?");
        expect(permissionTitle(perm("WebFetch", { url: "https://x" }))).toBe("Allow WebFetch?");
    });

    it("names a file under the agent's working dir relative to it, in the title, preview and log", () => {
        const edit = perm("Edit", { file_path: "C:\\Work\\Proj\\stats\\stats.go", old_string: "a", new_string: "b" });
        const cwd = "c:/work/proj";
        expect(permissionTitle(edit, cwd)).toBe("Allow an edit to stats/stats.go?");
        const preview = permissionPreview(edit, cwd);
        expect(preview.kind === "diff" && preview.files[0].path).toBe("stats/stats.go");
        expect(permissionLogText(edit, 0, cwd)).toBe("Yes: stats/stats.go");
    });
});

describe("relativeToCwd", () => {
    it("keeps a path outside the working dir, or with no working dir, as it is", () => {
        expect(relativeToCwd("C:\\Other\\x.go", "C:\\Work\\Proj")).toBe("C:\\Other\\x.go");
        expect(relativeToCwd("C:\\Work\\Project2\\x.go", "C:\\Work\\Proj")).toBe("C:\\Work\\Project2\\x.go");
        expect(relativeToCwd("/home/u/p/x.go", undefined)).toBe("/home/u/p/x.go");
    });
    it("compares a POSIX path case-sensitively", () => {
        expect(relativeToCwd("/home/u/p/x.go", "/home/u/p/")).toBe("x.go");
        expect(relativeToCwd("/home/U/p/x.go", "/home/u/p")).toBe("/home/U/p/x.go");
    });
});

describe("permissionPreview", () => {
    it("gives an Edit as one file with its removed and added lines", () => {
        const p = permissionPreview(
            perm("Edit", { file_path: "a.go", old_string: "x := 1", new_string: "x := 2\ny := 3" })
        );
        expect(p.kind).toBe("diff");
        if (p.kind !== "diff") return;
        expect(p.files).toHaveLength(1);
        expect(p.files[0].path).toBe("a.go");
        expect(p.files[0].lines).toEqual([
            { sign: "-", text: "x := 1" },
            { sign: "+", text: "x := 2" },
            { sign: "+", text: "y := 3" },
        ]);
    });

    it("gives a MultiEdit one file per edit and a Write as an added file", () => {
        const multi = permissionPreview(
            perm("MultiEdit", {
                file_path: "a.go",
                edits: [
                    { old_string: "a", new_string: "b" },
                    { old_string: "c", new_string: "d" },
                ],
            })
        );
        expect(multi.kind === "diff" && multi.files.length).toBe(2);
        const write = permissionPreview(perm("Write", { file_path: "n.go", content: "package n" }));
        expect(write.kind === "diff" && write.files[0]).toMatchObject({
            badge: "A",
            lines: [{ sign: "+", text: "package n" }],
        });
    });

    it("gives Bash its command and plan approval its markdown", () => {
        expect(permissionPreview(perm("Bash", { command: "go test ./..." }))).toEqual({
            kind: "command",
            text: "go test ./...",
        });
        expect(permissionPreview(perm("ExitPlanMode", { plan: "# Plan\n- a" }))).toEqual({
            kind: "markdown",
            text: "# Plan\n- a",
        });
    });

    it("falls back to the raw text when the input is not JSON", () => {
        expect(permissionPreview(perm("Edit", "{not json"))).toEqual({ kind: "json", text: "{not json" });
    });

    it("shows an unknown tool, or a known one missing its fields, as indented JSON", () => {
        expect(permissionPreview(perm("WebFetch", { url: "https://x" }))).toEqual({
            kind: "json",
            text: '{\n  "url": "https://x"\n}',
        });
        expect(permissionPreview(perm("Bash", { description: "d" })).kind).toBe("json");
    });
});

describe("permissionLogText", () => {
    it("joins the choice label and the request's subject", () => {
        const edit = perm("Edit", { file_path: "a.go" }, [
            "Yes",
            "Yes, allow edits this session",
            "No, tell Claude what to do",
        ]);
        expect(permissionLogText(edit, 1)).toBe("Yes, allow edits this session: a.go");
        expect(permissionLogText(perm("Bash", { command: "ls -la" }), 0)).toBe("Yes: ls -la");
        expect(permissionLogText(perm("ExitPlanMode", { plan: "p" }, ["Yes, auto-accept edits", "b", "c"]), 0)).toBe(
            "Yes, auto-accept edits: plan"
        );
        expect(permissionLogText(perm("WebFetch", { url: "u" }), 1)).toBe("No, tell Claude what to do: WebFetch");
    });
});

describe("placeMarks", () => {
    // entries: 0 user, 1-4 a stretch of steps, 5 message
    const items: LayoutItem[] = [
        { kind: "user", text: "go", index: 0 },
        { kind: "steps", startIndex: 1, steps: [] },
        { kind: "message", text: "done", index: 5, latest: true },
    ];

    it("puts a mark whose entry falls inside a folded turn after the turn's row", () => {
        const folded: LayoutItem[] = [
            items[0],
            {
                kind: "turn",
                startIndex: 1,
                items: [items[1]],
                fold: { phrase: "", adds: 0, dels: 0, failed: 0 },
                latest: false,
            },
            items[2],
        ];
        const { after } = placeMarks(folded, [{ afterEntry: 3, text: "a" }]);
        expect(after.get(1)?.map((m) => m.text)).toEqual(["a"]);
    });

    it("puts a mark after the item holding entry afterEntry - 1, a fold included", () => {
        const { lead, after } = placeMarks(items, [
            { afterEntry: 1, text: "a" },
            { afterEntry: 3, text: "b" },
            { afterEntry: 4, text: "c" },
            { afterEntry: 6, text: "d" },
        ]);
        expect(lead).toEqual([]);
        expect(after.get(0)?.map((m) => m.text)).toEqual(["a"]);
        expect(after.get(1)?.map((m) => m.text)).toEqual(["b", "c"]);
        expect(after.get(2)?.map((m) => m.text)).toEqual(["d"]);
    });

    it("leads with a mark that precedes every item", () => {
        const { lead, after } = placeMarks(items.slice(1), [{ afterEntry: 1, text: "early" }]);
        expect(lead.map((m) => m.text)).toEqual(["early"]);
        expect(after.size).toBe(0);
    });
});

describe("anchorMarks", () => {
    const user = (text: string, ts: number): AgentEntry => ({ kind: "user", text, ts });
    const ran: AgentEntry = { kind: "action", verb: "ran", target: "npm test", outcome: "ok" };
    const mark = { ts: 1500, text: "Yes: npm test" };

    it("goes after the entries that were there when it was answered", () => {
        const entries = [user("go", 1000), ran, user("next", 2000)];
        expect(anchorMarks(entries, [mark])).toEqual([{ afterEntry: 2, text: "Yes: npm test" }]);
        expect(anchorMarks(entries.slice(0, 2), [mark])).toEqual([{ afterEntry: 2, text: "Yes: npm test" }]);
    });

    it("keeps its place when a trim drops the entries before it", () => {
        const trimmed = [user("again", 1200), ran, user("next", 2000)];
        expect(anchorMarks(trimmed, [mark])).toEqual([{ afterEntry: 2, text: "Yes: npm test" }]);
    });

    it("is dropped once the window no longer holds it, as after /clear or a trim", () => {
        expect(anchorMarks([user("fresh", 3000), ran], [mark])).toEqual([]);
        expect(anchorMarks([ran], [mark])).toEqual([]);
    });

    const prose = (text: string, ts: number): AgentEntry => ({ kind: "message", text, ts });
    const done = (target: string, ts: number): AgentEntry => ({
        kind: "action",
        verb: "ran",
        target,
        outcome: "ok",
        ts,
    });

    it("goes right after the finished call it follows, not at the next prose", () => {
        const entries = [user("go", 1000), done("npm test", 1100), done("npm run lint", 1600), prose("ok", 2000)];
        expect(anchorMarks(entries, [mark])).toEqual([{ afterEntry: 2, text: "Yes: npm test" }]);
    });

    it("times a pending call by its start", () => {
        const pending: AgentEntry = { kind: "action", verb: "ran", target: "npm test", startedTs: 1600 };
        const entries = [user("go", 1000), done("ls", 1100), pending, prose("ok", 2000)];
        expect(anchorMarks(entries, [mark])).toEqual([{ afterEntry: 2, text: "Yes: npm test" }]);
    });

    it("is dropped when older than every stamped call", () => {
        expect(anchorMarks([done("npm test", 2000), prose("ok", 3000)], [mark])).toEqual([]);
    });
});
