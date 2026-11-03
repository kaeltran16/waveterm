// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The terminal Code peek's one card: which path is open, in which mode, and its loaded file. It
// reads over the same RPCs as the Code surface but never writes a Code-surface atom; only Open in
// Code, through the router, touches that surface.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { openTarget } from "@/app/view/jarvis/openref";
import { homeFromInfo } from "@/app/view/jarvis/projectpicker";
import { base64ToString } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentsViewModel } from "../agents/agents";
import { parseGitChanges } from "../agents/gitstatus";
import { classifyFile, hasNulByte, HEAD_BINARY, HEAD_TOOLARGE, MAX_VIEW_BYTES } from "./codeclassify";
import {
    initialPeekMode,
    needsHome,
    peekModes,
    resolvePeekPath,
    type PeekFile,
    type PeekGit,
    type PeekHead,
    type PeekMode,
    type PeekOpen,
} from "./codepeekmodel";

export type CodePeek = {
    blockId: string;
    bufferLine: number;
    start: number;
    raw: string;
    abs: string | null;
    line: number | null;
    mode: PeekMode;
    file: PeekFile;
};

export const codePeekAtom = atom<CodePeek | null>(null) as PrimitiveAtom<CodePeek | null>;
export const codePeekFocusedAtom = atom(false) as PrimitiveAtom<boolean>;

type PeekRequest = {
    blockId: string;
    bufferLine: number;
    start: number;
    raw: string;
    line: number | null;
    cwd: string | null;
};

// bumped by every open and close, so a load that a newer click superseded writes nothing
let loadToken = 0;

type Anchor = Pick<CodePeek, "blockId" | "bufferLine" | "start">;

function sameAnchor(p: Anchor, req: Anchor): boolean {
    return p.blockId === req.blockId && p.bufferLine === req.bufferLine && p.start === req.start;
}

// home is fixed for the app's life, so one stat serves every peek; a failed stat is retried next time
let homePromise: Promise<string> | null = null;

function homeDir(): Promise<string> {
    homePromise ??= RpcApi.FileInfoCommand(TabRpcClient, { info: { path: "~" } }).then(homeFromInfo, (e) => {
        console.error("code peek: could not read the home folder, so ~ paths stay unresolved", e);
        homePromise = null;
        return "";
    });
    return homePromise;
}

function splitAbs(abs: string): { dir: string; base: string } {
    const i = Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/"));
    const dir = abs.slice(0, i);
    // a file at a drive or POSIX root keeps the root's separator, or the dir would read as relative
    return { dir: dir === "" || /^[A-Za-z]:$/.test(dir) ? abs.slice(0, i + 1) : dir, base: abs.slice(i + 1) };
}

function headOf(res: CommandGitFileAtRefRtnData): PeekHead {
    if (res.missing) {
        return { kind: "absent" };
    }
    if (res.binary) {
        return { kind: "error", message: HEAD_BINARY };
    }
    if (res.toolarge) {
        return { kind: "error", message: HEAD_TOOLARGE };
    }
    return { kind: "text", text: res.content ?? "" };
}

// a numstat lookup is a nicety: when it fails the card still opens, with no stat
async function changeOf(root: string, rel: string): Promise<{ adds: number; dels: number } | null> {
    try {
        const res = await RpcApi.GitChangesCommand(TabRpcClient, { cwd: root });
        const hit = parseGitChanges(res?.statusz ?? "", res?.numstat ?? "").files.find((f) => f.path === rel);
        return hit ? { adds: hit.adds, dels: hit.dels } : null;
    } catch {
        return null;
    }
}

async function loadFile(abs: string, current: () => boolean): Promise<PeekFile | null> {
    const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: abs } });
    if (!current()) {
        return null;
    }
    if (info == null || info.notfound) {
        return { kind: "missing" };
    }
    const { dir, base } = splitAbs(abs);
    const at = await RpcApi.GitFileAtRefCommand(TabRpcClient, {
        cwd: dir,
        ref: "HEAD",
        path: base,
        maxbytes: MAX_VIEW_BYTES,
    });
    if (!current()) {
        return null;
    }
    const inRepo = at?.isrepo === true && !!at.root;
    const rel = inRepo ? (at.prefix ?? "") + base : base;
    const open: PeekOpen = inRepo ? { projectPath: at.root, rel } : { projectPath: dir, rel: base };
    const size = info.size ?? 0;
    const klass = classifyFile(size, info.mimetype ?? "");
    if (klass !== "text") {
        return { kind: klass, size, open };
    }
    const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: abs } });
    if (!current()) {
        return null;
    }
    const text = base64ToString(data?.data64 ?? "");
    if (hasNulByte(text)) {
        return { kind: "binary", size, open };
    }
    let git: PeekGit = { kind: "norepo" };
    if (inRepo) {
        const change = await changeOf(at.root, rel);
        if (!current()) {
            return null;
        }
        git = { kind: "repo", root: at.root, rel, head: headOf(at), change };
    }
    return { kind: "text", text, git, open };
}

export async function togglePeek(req: PeekRequest): Promise<void> {
    const prev = globalStore.get(codePeekAtom);
    if (prev != null && sameAnchor(prev, req)) {
        closePeek();
        return;
    }
    const token = ++loadToken;
    const current = () => loadToken === token;
    const home = needsHome(req.raw, req.cwd) ? await homeDir() : "";
    if (!current()) {
        return;
    }
    const abs = resolvePeekPath(req.raw, req.cwd, home);
    const { cwd: _cwd, ...anchor } = req;
    const peek: CodePeek = {
        ...anchor,
        abs,
        mode: initialPeekMode(abs ?? req.raw),
        file: abs == null ? { kind: "nocwd" } : { kind: "loading" },
    };
    globalStore.set(codePeekAtom, peek);
    if (abs == null) {
        return;
    }
    let file: PeekFile | null;
    try {
        file = await loadFile(abs, current);
    } catch (e) {
        file = current() ? { kind: "error", message: e instanceof Error ? e.message : String(e) } : null;
    }
    if (file != null && current()) {
        globalStore.set(codePeekAtom, { ...peek, file });
    }
}

export function closePeek(): void {
    loadToken++;
    globalStore.set(codePeekAtom, null);
    globalStore.set(codePeekFocusedAtom, false);
}

export function setPeekMode(mode: PeekMode): void {
    const peek = globalStore.get(codePeekAtom);
    if (peek == null || !peekModes(peek.abs ?? peek.raw, peek.file)[mode].enabled) {
        return;
    }
    globalStore.set(codePeekAtom, { ...peek, mode });
}

export async function openPeekInCode(model: AgentsViewModel): Promise<void> {
    const peek = globalStore.get(codePeekAtom);
    if (peek == null || !("open" in peek.file)) {
        return;
    }
    const { projectPath, rel } = peek.file.open;
    const res = await openTarget(model, {
        kind: "code",
        projectPath,
        rel,
        ...(peek.line != null ? { line: peek.line } : {}),
    });
    // a click that moved the card meanwhile owns it now, so only the card that was opened closes
    const now = globalStore.get(codePeekAtom);
    if (res.ok && now != null && sameAnchor(now, peek)) {
        closePeek();
    }
}
