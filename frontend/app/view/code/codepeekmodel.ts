// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: the Code peek card's state and the decisions it renders from: where a clicked path points,
// which modes it offers, its diff stat, and where the card sits against the terminal line.

import type { EditFile } from "@/app/view/agents/agentsviewmodel";
import { lineCountsShown } from "@/app/view/agents/gitstatus";
import { isCitedRow, splitHunks, type ChangesHunk } from "@/app/view/agents/workspacechangesmodel";
import { isImagePath, isMarkdownPath, NOT_TRACKED } from "./codeclassify";

export type PeekMode = "preview" | "source" | "diff";
export type PeekOpen = { projectPath: string; rel: string; inRepo: boolean };
export type PeekHead = { kind: "text"; text: string } | { kind: "absent" } | { kind: "error"; message: string };
export type PeekChange = { adds: number; dels: number; lineCounts?: false };
export type PeekGit =
    | { kind: "norepo" }
    | { kind: "repo"; root: string; rel: string; head: PeekHead; change: PeekChange | null };
export type PeekFile =
    | { kind: "loading" }
    | { kind: "nocwd" }
    | { kind: "missing" }
    | { kind: "folder"; open: PeekOpen }
    | { kind: "binary"; size: number; open: PeekOpen }
    | { kind: "toolarge"; size: number; open: PeekOpen }
    | { kind: "error"; message: string }
    | { kind: "text"; text: string; git: PeekGit; open: PeekOpen };

export const PEEK_PREFERRED_PX = 400;
// the floor the design asks for; min(preferred, room) already meets it wherever the room allows
export const PEEK_MIN_PX = 160;

const PREVIEW_MARKDOWN_ONLY = "Preview is for markdown files";

type Rooted = { root: string; sep: string; rest: string };

// the absolute root of a path, with the separator its kind uses; null for a relative path
function splitRoot(p: string): Rooted | null {
    const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(p);
    if (unc) {
        return { root: `\\\\${unc[1]}\\${unc[2]}\\`, sep: "\\", rest: p.slice(unc[0].length) };
    }
    const drive = /^([A-Za-z]:)(?:[\\/]|$)/.exec(p);
    if (drive) {
        return { root: `${drive[1]}\\`, sep: "\\", rest: p.slice(drive[0].length) };
    }
    if (p.startsWith("/")) {
        return { root: "/", sep: "/", rest: p };
    }
    return null;
}

// folds . and .. so one file has one absolute spelling; .. never climbs above the root
function joinNormalized(base: Rooted, ...parts: string[]): string {
    const out: string[] = [];
    for (const seg of parts.join("/").split(/[\\/]+/)) {
        if (seg === "" || seg === ".") {
            continue;
        }
        if (seg === "..") {
            out.pop();
            continue;
        }
        out.push(seg);
    }
    return base.root + out.join(base.sep);
}

// null for a ~ path home cannot expand: home unknown (""), or a ~user path
function expandHome(p: string, home: string): string | null {
    if (!p.startsWith("~")) {
        return p;
    }
    if (home === "" || !/^~(?:$|[\\/])/.test(p)) {
        return null;
    }
    return home + p.slice(1);
}

export function resolvePeekPath(raw: string, cwd: string | null, home: string): string | null {
    const path = expandHome(raw, home);
    if (path == null) {
        return null;
    }
    const abs = splitRoot(path);
    if (abs) {
        return joinNormalized(abs, abs.rest);
    }
    const dir = cwd ? expandHome(cwd, home) : null;
    const base = dir ? splitRoot(dir) : null;
    return base ? joinNormalized(base, base.rest, path) : null;
}

export function needsHome(raw: string, cwd: string | null): boolean {
    return raw.startsWith("~") || (cwd?.startsWith("~") ?? false);
}

export function initialPeekMode(path: string): PeekMode {
    return isMarkdownPath(path) ? "preview" : "source";
}

// repo-relative inside a repository, else the absolute path (or what was clicked, when nothing resolved)
export function peekHeaderPath(peek: { abs: string | null; raw: string; file: PeekFile }): string {
    if ("open" in peek.file && peek.file.open.inRepo) {
        return peek.file.open.rel;
    }
    return peek.abs ?? peek.raw;
}

export function binaryPeekMessage(path: string): string {
    return isImagePath(path) ? "Image — open it in Code" : "Binary file";
}

// the tab drops Diff for a file new since HEAD: its Source already shows every line, and the stat says "new file"
export function peekModes(
    path: string,
    file: PeekFile,
    variant: "card" | "tab" = "card"
): Record<PeekMode, { enabled: boolean; reason?: string }> {
    if (file.kind !== "text") {
        return { preview: { enabled: false }, source: { enabled: false }, diff: { enabled: false } };
    }
    const git = file.git;
    return {
        preview: isMarkdownPath(path) ? { enabled: true } : { enabled: false, reason: PREVIEW_MARKDOWN_ONLY },
        source: { enabled: true },
        diff:
            git.kind !== "repo"
                ? { enabled: false, reason: NOT_TRACKED }
                : { enabled: variant === "card" || git.head.kind !== "absent" },
    };
}

export type TabDiffRead =
    | { kind: "loading" }
    | { kind: "failed"; message: string }
    | { kind: "read"; files: EditFile[]; truncated: boolean };
export type TabDiffBody =
    | { kind: "loading" }
    | { kind: "head"; message: string }
    | { kind: "error"; message: string }
    | { kind: "note"; note: "empty" | "toolarge" | "binary" }
    | { kind: "hunks"; hunks: ChangesHunk[]; landOn: number | null };

// what the File tab's Diff draws from its one-path patch read; landOn is the cited row's index across every hunk's
// rows, null when the cited line sits outside them all
export function tabDiffBody(head: PeekHead, read: TabDiffRead, rel: string, cited: number | null): TabDiffBody {
    if (head.kind === "error") {
        return { kind: "head", message: head.message };
    }
    if (read.kind === "loading") {
        return read;
    }
    if (read.kind === "failed") {
        return { kind: "error", message: read.message };
    }
    const entry = read.files.find((f) => f.path === rel);
    if (entry == null) {
        return { kind: "note", note: read.truncated ? "toolarge" : "empty" };
    }
    if (entry.binary) {
        return { kind: "note", note: "binary" };
    }
    const hunks = splitHunks(entry.lines, false);
    if (hunks.length === 0) {
        return { kind: "note", note: "empty" };
    }
    const at = hunks.flatMap((h) => h.rows).findIndex((row) => isCitedRow(row, cited));
    return { kind: "hunks", hunks, landOn: at < 0 ? null : at };
}

// counted as numstat counts: a final line without a newline still counts
function lineCount(text: string): number {
    if (text === "") {
        return 0;
    }
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// numstat is the source, matching the details rail; an untracked file has no numstat entry, so a
// file new since HEAD falls back to its own line count
export function peekStat(file: PeekFile): { label: string; adds?: number; dels?: number } | null {
    if (file.kind !== "text" || file.git.kind !== "repo") {
        return null;
    }
    const { head, change } = file.git;
    if (head.kind === "absent") {
        return { label: "new file", adds: change?.adds ? change.adds : lineCount(file.text) };
    }
    if (change && !lineCountsShown(change)) {
        return { label: "line counts unknown" };
    }
    if (change) {
        return { label: "", adds: change.adds, dels: change.dels };
    }
    return { label: "no changes" };
}

export function peekRow(markerLine: number, viewportY: number, rows: number): number | null {
    const row = markerLine - viewportY;
    return row >= 0 && row < rows ? row : null;
}

// decided on open and on resize only, so streaming output never flips the card
export function peekPlacement(p: { lineTop: number; lineHeight: number; viewportHeight: number }): {
    side: "below" | "above";
    height: number;
} {
    const above = p.lineTop;
    const below = p.viewportHeight - p.lineTop - p.lineHeight;
    const side = below >= PEEK_PREFERRED_PX || below > above ? "below" : "above";
    const room = side === "below" ? below : above;
    return { side, height: Math.max(0, Math.min(PEEK_PREFERRED_PX, room)) };
}
