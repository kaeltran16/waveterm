import { describe, expect, it } from "vitest";
import { fileDecision, hunkKey, progressOf, rejectedPatchPlan, type ReviewFile } from "./reviewstore";

const files: ReviewFile[] = [
    {
        path: "src/a.ts", status: " M", isNew: false, adds: 2, dels: 1, diffHeader: "H-A\n",
        hunks: [
            { id: "h0", header: "@@1@@", adds: 1, dels: 0, body: "B0\n" },
            { id: "h1", header: "@@2@@", adds: 1, dels: 1, body: "B1\n" },
        ],
    },
    {
        path: "new.ts", status: "??", isNew: true, adds: 3, dels: 0, diffHeader: "",
        hunks: [{ id: "file", header: "@@ new @@", adds: 3, dels: 0, body: "" }],
    },
];

describe("review decision model", () => {
    it("fileDecision derives accept/reject/partial/pending", () => {
        expect(fileDecision(files[0], {})).toBe("pending");
        expect(fileDecision(files[0], { [hunkKey("src/a.ts", "h0")]: "accept" })).toBe("partial");
        const both = { [hunkKey("src/a.ts", "h0")]: "accept", [hunkKey("src/a.ts", "h1")]: "accept" } as const;
        expect(fileDecision(files[0], both)).toBe("accept");
        const rej = { [hunkKey("src/a.ts", "h0")]: "reject", [hunkKey("src/a.ts", "h1")]: "reject" } as const;
        expect(fileDecision(files[0], rej)).toBe("reject");
    });

    it("progressOf counts across all hunks", () => {
        const d = { [hunkKey("src/a.ts", "h0")]: "accept", [hunkKey("new.ts", "file")]: "reject" } as const;
        const p = progressOf(files, d);
        expect(p.total).toBe(3);
        expect(p.accepted).toBe(1);
        expect(p.rejected).toBe(1);
        expect(p.pending).toBe(1);
    });

    it("rejectedPatchPlan: whole-file for all-rejected/untracked, patch for partial", () => {
        const d = {
            [hunkKey("src/a.ts", "h0")]: "reject", // partial (h1 accepted)
            [hunkKey("src/a.ts", "h1")]: "accept",
            [hunkKey("new.ts", "file")]: "reject", // untracked whole-file
        } as const;
        const plan = rejectedPatchPlan(files, d);
        const a = plan.find((x) => x.path === "src/a.ts")!;
        expect(a.patch).toBe("H-A\nB0\n"); // header + only the rejected hunk
        expect(a.status).toBe(" M");
        const n = plan.find((x) => x.path === "new.ts")!;
        expect(n.patch).toBe(""); // whole-file discard
    });

    it("rejectedPatchPlan: all hunks rejected -> whole-file (empty patch)", () => {
        const d = {
            [hunkKey("src/a.ts", "h0")]: "reject",
            [hunkKey("src/a.ts", "h1")]: "reject",
        } as const;
        const plan = rejectedPatchPlan(files, d);
        expect(plan.find((x) => x.path === "src/a.ts")!.patch).toBe("");
    });
});
