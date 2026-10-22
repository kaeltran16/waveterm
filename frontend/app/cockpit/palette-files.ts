// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The universal search's Files scope: its groups and rows. Code's file finder folded in here, so this reuses
// its ranking (rankPaths) and its query language (a trailing ":123" is a line, a leading "@" a symbol)
// rather than growing a second one.

import { globalStore } from "@/app/store/jotaiStore";
import type { SurfaceKey } from "@/app/store/keybindings/types";
import { parseFinderQuery, rankPaths } from "@/app/view/code/codefinder";
import { recentPaths, type History } from "@/app/view/code/codehistory";
import { rankSymbols } from "@/app/view/code/codeoutline";
import {
    codeFileAtom,
    codeOutlineAtom,
    codePendingLineAtom,
    goToLine,
    openInCode,
    type CodeIndex,
    type CodeProject,
} from "@/app/view/code/codestore";
import { fireAndForget } from "@/util/util";
import { assembleScopeGroups, MAX_IN_SCOPE, type PaletteGroup } from "./palette-groups";
import type { PaletteDeps } from "./palette-items";
import type { PaletteItem } from "./palette-rows";
import { scopeDef } from "./palette-scope";

export interface FileHit {
    path: string; // repo-relative
    base: string;
    dir: string;
}

export interface FileGroups {
    text: string; // the query without its line suffix: what rows highlight against
    line?: number;
    groups: { key: string; label: string; items: FileHit[] }[];
}

function hit(path: string): FileHit {
    const slash = path.lastIndexOf("/");
    return slash === -1
        ? { path, base: path, dir: "" }
        : { path, base: path.slice(slash + 1), dir: path.slice(0, slash) };
}

// recent: most recent first, from Code's history. With nothing typed it leads as its own group; a
// recent file the index no longer lists is left out (rankPaths drops it), since it was deleted or renamed.
export function assembleFileGroups(
    query: string,
    paths: readonly string[],
    recent: readonly string[],
    projectLabel: string,
    limit: number
): FileGroups {
    const { text, line } = parseFinderQuery(query);
    const ranked = rankPaths(text, paths, limit, recent).map((m) => hit(m.path));
    const label = `Files in ${projectLabel}`;
    if (text !== "") {
        return { text, line, groups: ranked.length > 0 ? [{ key: "files", label, items: ranked }] : [] };
    }
    const recentSet = new Set(recent);
    return {
        text,
        line,
        groups: [
            { key: "recent-files", label: "Recent files", items: ranked.filter((f) => recentSet.has(f.path)) },
            { key: "files", label, items: ranked.filter((f) => !recentSet.has(f.path)) },
        ].filter((g) => g.items.length > 0),
    };
}

export function fileEcho(f: FileHit, line: number | undefined): string {
    return `Opens ${f.path}${line != null ? ` at line ${line}` : ""} in Code`;
}

export interface FileScopeGroups {
    groups: PaletteGroup<PaletteItem>[];
    fileHighlight?: string; // what rows highlight against, when it is not the query
}

export interface FileScopeInput {
    query: string;
    surface: SurfaceKey;
    target: CodeProject | null; // the project whose files are listed
    index: CodeIndex | undefined; // undefined while it loads
    error: string | undefined;
    history: History | null; // Code's history, when Code has the target open
}

type FileDeps = Pick<PaletteDeps, "model" | "close">;

export function fileScopeGroups(input: FileScopeInput, deps: FileDeps): FileScopeGroups {
    const { query, surface, target, index, error, history } = input;
    const { model, close } = deps;
    const empty = (emptyText: string) => [{ key: "empty", label: "Files", items: [], emptyText }];
    const fq = parseFinderQuery(query);
    if (fq.symbol) {
        return symbolScopeGroups(fq.text, surface, deps);
    }
    if (target == null) {
        return { groups: empty("No project to search. Pick one on Code or in the cockpit.") };
    }
    const label = `#${target.name}`;
    if (error != null) {
        return { groups: empty(`Couldn’t list files in ${label}: ${error}`) };
    }
    if (index == null) {
        return { groups: empty(`Loading files in ${label}…`) };
    }
    const recent = history != null ? recentPaths(history) : [];
    const fg = assembleFileGroups(query, index.paths, recent, label, MAX_IN_SCOPE);
    const rows: PaletteGroup<PaletteItem>[] = fg.groups.map((g) => ({
        key: g.key,
        label: g.label,
        items: g.items.map((f) => ({
            key: `file:${f.path}`,
            kind: "file" as const,
            search: "",
            title: f.base,
            meta: [f.dir, fg.line != null ? `:${fg.line}` : ""].filter(Boolean).join("  ") || undefined,
            verb: "Open",
            echo: fileEcho(f, fg.line),
            run: () => {
                close();
                fireAndForget(() => openInCode(model, { projectPath: target.path, rel: f.path, line: fg.line }));
            },
        })),
    }));
    // a bare ":152" on Code names no file, so it means "that line of the file already open"
    if (surface === "code" && fg.text === "" && fg.line != null) {
        const line = fg.line;
        rows.unshift({
            key: "line",
            label: "Open file",
            items: [
                {
                    key: "line",
                    kind: "line",
                    search: "",
                    title: `Line ${line} of the open file`,
                    verb: "Go to",
                    echo: `Moves the open file to line ${line}`,
                    run: () => {
                        close();
                        globalStore.set(codePendingLineAtom, line);
                    },
                },
            ],
        });
    }
    if (rows.length === 0) {
        // quote the path part: "readme:3" found no file named readme, not no file named "readme:3"
        const def = scopeDef("files");
        return {
            groups: assembleScopeGroups({
                rows: [],
                order: ["file"],
                label: def.label,
                noun: def.noun,
                query: fg.text,
                widenItem: null,
            }),
        };
    }
    return { groups: rows, fileHighlight: fg.text };
}

// "@" ranks the open file's outline. Read from the store rather than subscribed: the outline is derived
// from the buffer, and a subscription in the palette would re-parse it on every editor keystroke while the
// palette sits closed.
function symbolScopeGroups(text: string, surface: SurfaceKey, { close }: FileDeps): FileScopeGroups {
    const empty = (emptyText: string) => [{ key: "empty", label: "Symbols", items: [], emptyText }];
    const file = globalStore.get(codeFileAtom);
    if (surface !== "code" || file.kind !== "text") {
        return { groups: empty("Open a file on Code to list its symbols.") };
    }
    const outline = globalStore.get(codeOutlineAtom);
    const base = file.path.slice(file.path.lastIndexOf("/") + 1);
    const ranked = rankSymbols(text, outline).slice(0, MAX_IN_SCOPE);
    if (ranked.length === 0) {
        return {
            groups: empty(outline.length === 0 ? `No symbols found in ${base}.` : `No symbol matches “${text}”.`),
        };
    }
    const items: PaletteItem[] = ranked.map((sym) => ({
        key: `symbol:${sym.line}:${sym.name}`,
        kind: "symbol" as const,
        search: "",
        title: sym.name,
        meta: `:${sym.line}`,
        verb: "Go to",
        echo: `Moves ${base} to ${sym.name}, line ${sym.line}`,
        run: () => {
            close();
            goToLine(sym.line);
        },
    }));
    return { groups: [{ key: "symbols", label: `Symbols in ${base}`, items }], fileHighlight: text };
}
