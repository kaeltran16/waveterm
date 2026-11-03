// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
    FileInfoCommand: vi.fn(),
    FileReadCommand: vi.fn(),
    GitFileAtRefCommand: vi.fn(),
    GitChangesCommand: vi.fn(),
}));
const openTarget = vi.hoisted(() => vi.fn());

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/view/jarvis/openref", () => ({ openTarget: (...a: unknown[]) => openTarget(...a) }));

import { globalStore } from "@/app/store/jotaiStore";
import { stringToBase64 } from "@/util/util";
import type { AgentsViewModel } from "../agents/agents";
import { MAX_VIEW_BYTES } from "./codeclassify";
import { closePeek, codePeekAtom, codePeekFocusedAtom, openPeekInCode, setPeekMode, togglePeek } from "./codepeekstore";

const CWD = "C:\\repo\\docs";
const anchor = { blockId: "b1", bufferLine: 10, start: 4, line: null, cwd: CWD };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

function fileInfo(size = 12, mimetype = "") {
    return { size, mimetype, notfound: false };
}

function read(text: string) {
    return { data64: stringToBase64(text) };
}

function atRef(over: Partial<CommandGitFileAtRefRtnData> = {}): CommandGitFileAtRefRtnData {
    return { content: "old\n", isrepo: true, root: "C:/repo", prefix: "docs/", ...over };
}

beforeEach(() => {
    for (const fn of Object.values(rpc)) {
        fn.mockReset();
    }
    openTarget.mockReset();
    closePeek();
    rpc.FileInfoCommand.mockResolvedValue(fileInfo());
    rpc.FileReadCommand.mockResolvedValue(read("hello\n"));
    rpc.GitFileAtRefCommand.mockResolvedValue(atRef());
    rpc.GitChangesCommand.mockResolvedValue({ statusz: "", numstat: "", isrepo: true, branch: "main" });
});

describe("togglePeek", () => {
    it("loads a markdown file new since HEAD as text, opened on Preview", async () => {
        rpc.GitFileAtRefCommand.mockResolvedValue(atRef({ missing: true, content: "" }));
        rpc.GitChangesCommand.mockResolvedValue({
            statusz: "?? docs/notes.md\0",
            numstat: "",
            isrepo: true,
            branch: "main",
        });

        await togglePeek({ ...anchor, raw: "notes.md" });

        expect(rpc.GitFileAtRefCommand).toHaveBeenCalledWith(expect.anything(), {
            cwd: "C:\\repo\\docs",
            ref: "HEAD",
            path: "notes.md",
            maxbytes: MAX_VIEW_BYTES,
        });
        expect(rpc.GitChangesCommand).toHaveBeenCalledWith(expect.anything(), { cwd: "C:/repo" });
        const peek = globalStore.get(codePeekAtom);
        expect(peek?.abs).toBe("C:\\repo\\docs\\notes.md");
        expect(peek?.mode).toBe("preview");
        expect(peek?.file).toEqual({
            kind: "text",
            text: "hello\n",
            git: {
                kind: "repo",
                root: "C:/repo",
                rel: "docs/notes.md",
                head: { kind: "absent" },
                change: { adds: 0, dels: 0 },
            },
            open: { projectPath: "C:/repo", rel: "docs/notes.md" },
        });
    });

    it("opens a source file on Source with its HEAD copy and numstat change", async () => {
        rpc.GitChangesCommand.mockResolvedValue({
            statusz: " M docs/a.ts\0",
            numstat: "3\t1\tdocs/a.ts\n",
            isrepo: true,
            branch: "main",
        });

        await togglePeek({ ...anchor, raw: "a.ts", line: 12 });

        const peek = globalStore.get(codePeekAtom);
        expect(peek?.mode).toBe("source");
        expect(peek?.line).toBe(12);
        expect(peek?.file).toMatchObject({
            kind: "text",
            git: {
                kind: "repo",
                rel: "docs/a.ts",
                head: { kind: "text", text: "old\n" },
                change: { adds: 3, dels: 1 },
            },
        });
    });

    it("maps a binary or oversized HEAD copy to a head error", async () => {
        rpc.GitFileAtRefCommand.mockResolvedValue(atRef({ binary: true, content: "" }));

        await togglePeek({ ...anchor, raw: "a.ts" });

        const file = globalStore.get(codePeekAtom)?.file;
        expect(file?.kind === "text" && file.git.kind === "repo" && file.git.head).toEqual({
            kind: "error",
            message: "The committed copy is a binary blob.",
        });
    });

    it("reports a file that is not there as missing", async () => {
        rpc.FileInfoCommand.mockResolvedValue({ notfound: true });

        await togglePeek({ ...anchor, raw: "gone.ts" });

        expect(globalStore.get(codePeekAtom)?.file).toEqual({ kind: "missing" });
        expect(rpc.FileReadCommand).not.toHaveBeenCalled();
    });

    it("gates a file over the view limit without reading it", async () => {
        rpc.FileInfoCommand.mockResolvedValue(fileInfo(MAX_VIEW_BYTES + 1));

        await togglePeek({ ...anchor, raw: "big.log" });

        expect(globalStore.get(codePeekAtom)?.file).toEqual({
            kind: "toolarge",
            size: MAX_VIEW_BYTES + 1,
            open: { projectPath: "C:/repo", rel: "docs/big.log" },
        });
        expect(rpc.FileReadCommand).not.toHaveBeenCalled();
    });

    it("treats content with a NUL byte as binary", async () => {
        rpc.FileReadCommand.mockResolvedValue(read("ab\u0000cd"));

        await togglePeek({ ...anchor, raw: "blob.dat" });

        expect(globalStore.get(codePeekAtom)?.file).toMatchObject({ kind: "binary", size: 12 });
    });

    it("opens a file outside a repository with its directory as the project", async () => {
        rpc.GitFileAtRefCommand.mockResolvedValue({ content: "", isrepo: false });

        await togglePeek({ ...anchor, raw: "a.ts" });

        expect(globalStore.get(codePeekAtom)?.file).toEqual({
            kind: "text",
            text: "hello\n",
            git: { kind: "norepo" },
            open: { projectPath: "C:\\repo\\docs", rel: "a.ts" },
        });
        expect(rpc.GitChangesCommand).not.toHaveBeenCalled();
    });

    it("gives a relative path with no cwd the no-working-directory state, with no RPC", async () => {
        await togglePeek({ ...anchor, raw: "a.ts", cwd: null });

        expect(globalStore.get(codePeekAtom)).toMatchObject({ abs: null, file: { kind: "nocwd" } });
        expect(rpc.FileInfoCommand).not.toHaveBeenCalled();
    });

    it("closes on the same anchor and moves on a different one", async () => {
        await togglePeek({ ...anchor, raw: "a.ts" });
        await togglePeek({ ...anchor, raw: "a.ts" });
        expect(globalStore.get(codePeekAtom)).toBeNull();

        await togglePeek({ ...anchor, raw: "a.ts" });
        await togglePeek({ ...anchor, bufferLine: 11, raw: "b.ts" });
        expect(globalStore.get(codePeekAtom)).toMatchObject({ bufferLine: 11, raw: "b.ts" });
    });

    it("never shows a superseded load's file in the newer card", async () => {
        const first = deferred<FileData>();
        rpc.FileReadCommand.mockReturnValueOnce(first.promise).mockResolvedValueOnce(read("second\n"));

        const p1 = togglePeek({ ...anchor, raw: "first.ts" });
        await vi.waitFor(() => expect(rpc.FileReadCommand).toHaveBeenCalledTimes(1));
        const p2 = togglePeek({ ...anchor, bufferLine: 20, raw: "second.ts" });
        await p2;
        first.resolve(read("first\n"));
        await p1;

        const peek = globalStore.get(codePeekAtom);
        expect(peek?.raw).toBe("second.ts");
        expect(peek?.file).toMatchObject({ kind: "text", text: "second\n" });
    });

    it("keeps the card when the change lookup fails", async () => {
        rpc.GitChangesCommand.mockRejectedValue(new Error("git exploded"));

        await togglePeek({ ...anchor, raw: "a.ts" });

        expect(globalStore.get(codePeekAtom)?.file).toMatchObject({
            kind: "text",
            git: { kind: "repo", change: null },
        });
    });

    it("turns a thrown RPC error into an error card", async () => {
        rpc.FileInfoCommand.mockRejectedValue(new Error("connection lost"));

        await togglePeek({ ...anchor, raw: "a.ts" });

        expect(globalStore.get(codePeekAtom)?.file).toEqual({ kind: "error", message: "connection lost" });
    });
});

describe("setPeekMode", () => {
    it("switches to an enabled mode and ignores a disabled one", async () => {
        await togglePeek({ ...anchor, raw: "a.ts" });

        setPeekMode("preview");
        expect(globalStore.get(codePeekAtom)?.mode).toBe("source");
        setPeekMode("diff");
        expect(globalStore.get(codePeekAtom)?.mode).toBe("diff");
    });
});

describe("closePeek", () => {
    it("clears the card and its focus flag", async () => {
        await togglePeek({ ...anchor, raw: "a.ts" });
        globalStore.set(codePeekFocusedAtom, true);

        closePeek();

        expect(globalStore.get(codePeekAtom)).toBeNull();
        expect(globalStore.get(codePeekFocusedAtom)).toBe(false);
    });
});

describe("openPeekInCode", () => {
    const model = {} as AgentsViewModel;

    it("opens the file in Code at the clicked line and closes on success", async () => {
        openTarget.mockResolvedValue({ ok: true });
        await togglePeek({ ...anchor, raw: "a.ts", line: 7 });

        await openPeekInCode(model);

        expect(openTarget).toHaveBeenCalledWith(model, {
            kind: "code",
            projectPath: "C:/repo",
            rel: "docs/a.ts",
            line: 7,
        });
        expect(globalStore.get(codePeekAtom)).toBeNull();
    });

    it("keeps the card when the landing fails", async () => {
        openTarget.mockResolvedValue({ ok: false, reason: "unavailable", message: "No such file: docs/a.ts" });
        await togglePeek({ ...anchor, raw: "a.ts" });

        await openPeekInCode(model);

        expect(globalStore.get(codePeekAtom)).not.toBeNull();
    });

    it("does nothing for a card with no file to open", async () => {
        rpc.FileInfoCommand.mockResolvedValue({ notfound: true });
        await togglePeek({ ...anchor, raw: "gone.ts" });

        await openPeekInCode(model);

        expect(openTarget).not.toHaveBeenCalled();
    });
});
