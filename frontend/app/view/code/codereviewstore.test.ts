// frontend/app/view/code/codereviewstore.test.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { base64ToString } from "@/util/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reviewWrite = vi.fn();
const controllerInput = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        CodeReviewWriteCommand: (...a: any[]) => reviewWrite(...a),
        ControllerInputCommand: (...a: any[]) => controllerInput(...a),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { projectComments, reviewHandoffLine, reviewMarkdown, type ReviewComment } from "./codereview";
import {
    codeCommentDraftAtom,
    codeReviewsAtom,
    saveComment,
    sendReview,
    setCommentSelectionReader,
    startComment,
} from "./codereviewstore";
import { codeFileAtom, codeProjectAtom } from "./codestore";

const project = { name: "alpha", path: "/repos/alpha" };
const text = ["one", "two", "three", "four"].join("\n");
const agent = { id: "a1", name: "claude", blockId: "blk-1" } as AgentVM;

function seed(comments: ReviewComment[]): void {
    globalStore.set(codeReviewsAtom, new Map([[project.path, comments]]));
}

const comment: ReviewComment = { id: "c1", path: "a.ts", startLine: 2, endLine: 2, anchor: "two", note: "why" };

let clipboard: { writeText: ReturnType<typeof vi.fn> };

beforeEach(() => {
    globalStore.set(codeProjectAtom, project);
    globalStore.set(codeFileAtom, { kind: "text", path: "a.ts", text, size: text.length, modtime: 1 });
    clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal("navigator", { clipboard });
});

afterEach(() => {
    reviewWrite.mockReset();
    controllerInput.mockReset();
    vi.unstubAllGlobals();
    globalStore.set(codeReviewsAtom, new Map());
    globalStore.set(codeCommentDraftAtom, null);
    setCommentSelectionReader(() => null);
});

describe("sendReview to an agent", () => {
    it("writes the review once, injects one handoff line, and clears the project", async () => {
        seed([comment]);
        reviewWrite.mockResolvedValue({ path: "/home/u/.arc/review/alpha/x.md" });
        controllerInput.mockResolvedValue(undefined);

        const res = await sendReview(agent, "alpha");

        expect(res).toEqual({ ok: true });
        expect(reviewWrite).toHaveBeenCalledTimes(1);
        expect(reviewWrite.mock.calls[0][1]).toEqual({
            project: "alpha",
            markdown: reviewMarkdown("alpha", [comment]),
        });
        expect(controllerInput).toHaveBeenCalledTimes(1);
        const input = controllerInput.mock.calls[0][1];
        expect(input.blockid).toBe("blk-1");
        expect(base64ToString(input.inputdata64)).toBe(reviewHandoffLine("/home/u/.arc/review/alpha/x.md") + "\r");
        expect(projectComments(globalStore.get(codeReviewsAtom), project.path)).toEqual([]);
    });

    it("keeps the comments and injects nothing when the write fails", async () => {
        seed([comment]);
        reviewWrite.mockRejectedValue(new Error("disk full"));

        const res = await sendReview(agent, "alpha");

        expect(res.ok).toBe(false);
        expect("message" in res && res.message).toContain("disk full");
        expect(controllerInput).not.toHaveBeenCalled();
        expect(projectComments(globalStore.get(codeReviewsAtom), project.path)).toEqual([comment]);
    });

    it("re-anchors the open file's comments against the buffer before writing", async () => {
        seed([{ ...comment, startLine: 1, endLine: 1, anchor: "three" }]);
        reviewWrite.mockResolvedValue({ path: "/r.md" });
        controllerInput.mockResolvedValue(undefined);

        await sendReview(agent, "alpha");

        expect(reviewWrite.mock.calls[0][1].markdown).toContain("### a.ts:L3");
    });
});

describe("sendReview with no agent", () => {
    it("copies the markdown, writes no file, and clears the project", async () => {
        seed([comment]);

        const res = await sendReview(null, "alpha");

        expect(res).toEqual({ ok: true });
        expect(clipboard.writeText).toHaveBeenCalledWith(reviewMarkdown("alpha", [comment]));
        expect(reviewWrite).not.toHaveBeenCalled();
        expect(projectComments(globalStore.get(codeReviewsAtom), project.path)).toEqual([]);
    });

    it("keeps the comments when the clipboard refuses", async () => {
        seed([comment]);
        clipboard.writeText.mockRejectedValue(new Error("denied"));

        const res = await sendReview(null, "alpha");

        expect(res.ok).toBe(false);
        expect(projectComments(globalStore.get(codeReviewsAtom), project.path)).toEqual([comment]);
    });
});

describe("comment drafts", () => {
    it("starts on the caret line when nothing is selected, anchored to the buffer's text", () => {
        setCommentSelectionReader(() => ({ startLine: 3, endLine: 3, endColumn: 2 }));
        startComment();
        expect(globalStore.get(codeCommentDraftAtom)).toEqual({
            path: "a.ts",
            startLine: 3,
            endLine: 3,
            anchor: "three",
        });
    });

    it("trims a selection that ends at column 1 of the next line", () => {
        setCommentSelectionReader(() => ({ startLine: 1, endLine: 3, endColumn: 1 }));
        startComment();
        expect(globalStore.get(codeCommentDraftAtom)).toMatchObject({ startLine: 1, endLine: 2, anchor: "one" });
    });

    it("does nothing without a text file open", () => {
        globalStore.set(codeFileAtom, { kind: "none" });
        setCommentSelectionReader(() => ({ startLine: 1, endLine: 1, endColumn: 1 }));
        startComment();
        expect(globalStore.get(codeCommentDraftAtom)).toBeNull();
    });

    it("saves a note as a comment and closes the draft", () => {
        setCommentSelectionReader(() => ({ startLine: 2, endLine: 2, endColumn: 1 }));
        startComment();
        saveComment("  rename this ");
        const saved = projectComments(globalStore.get(codeReviewsAtom), project.path);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ path: "a.ts", startLine: 2, endLine: 2, anchor: "two", note: "rename this" });
        expect(globalStore.get(codeCommentDraftAtom)).toBeNull();
    });

    it("adds nothing for a blank note", () => {
        setCommentSelectionReader(() => ({ startLine: 2, endLine: 2, endColumn: 1 }));
        startComment();
        saveComment("  ");
        expect(projectComments(globalStore.get(codeReviewsAtom), project.path)).toEqual([]);
        expect(globalStore.get(codeCommentDraftAtom)).toBeNull();
    });
});
