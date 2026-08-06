// frontend/app/view/code/codefinderpalette.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Fuzzy open-by-name over the same flat path list the tree is built from. Opening a file inside a
// collapsed subtree expands its ancestors, so the tree shows where you landed.
//
// This is what Ctrl+P opens on the Code surface; on every other surface the same chord opens the
// command palette. A leading '>' here hands off to that palette (VS Code's convention), so commands
// stay reachable without a second chord.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseFinderQuery, rankPaths } from "./codefinder";
import { codeFinderOpenAtom, codeIndexAtom, codePendingLineAtom, codeProjectAtom, openInCode } from "./codestore";

const MAX_RESULTS = 50;
const COMMAND_SIGIL = ">";

export function CodeFinderPalette({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(codeFinderOpenAtom);
    const index = useAtomValue(codeIndexAtom);
    const project = useAtomValue(codeProjectAtom);
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const parsed = useMemo(() => parseFinderQuery(query), [query]);
    const matches = useMemo(() => rankPaths(parsed.text, index?.paths ?? [], MAX_RESULTS), [parsed.text, index]);

    useEffect(() => {
        if (open) {
            setQuery("");
            setCursor(0);
            inputRef.current?.focus();
        }
    }, [open]);

    useEffect(() => {
        setCursor(0);
    }, [query]);

    if (!open) {
        return null;
    }

    const close = () => globalStore.set(codeFinderOpenAtom, false);
    const choose = (path: string) => {
        close();
        if (project != null) {
            fireAndForget(() => openInCode(model, { projectPath: project.path, rel: path, line: parsed.line }));
        }
    };
    // a bare ":152" names no file, so it means "that line of the file already open"
    const jumpInPlace = () => {
        close();
        globalStore.set(codePendingLineAtom, parsed.line ?? null);
    };
    // Seed before opening: the palette reads the seed in its own open effect, so the '>' the user
    // typed survives the swap instead of being eaten by this overlay closing.
    const toCommands = (seed: string) => {
        close();
        globalStore.set(model.paletteSeedAtom, seed);
        globalStore.set(model.paletteOpenAtom, true);
    };

    return (
        <div
            className="absolute inset-0 z-30 flex items-start justify-center bg-background/60 pt-[12vh]"
            onClick={close}
        >
            <div
                className="w-[min(680px,90%)] overflow-hidden rounded-[12px] border border-border bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <input
                    ref={inputRef}
                    value={query}
                    placeholder="Find a file by name — add :123 for a line"
                    onChange={(e) => {
                        const next = e.target.value;
                        if (next.startsWith(COMMAND_SIGIL)) {
                            toCommands(next);
                            return;
                        }
                        setQuery(next);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            e.preventDefault();
                            close();
                        } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setCursor((c) => Math.min(c + 1, matches.length - 1));
                        } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setCursor((c) => Math.max(c - 1, 0));
                        } else if (e.key === "Enter") {
                            e.preventDefault();
                            if (parsed.text === "" && parsed.line != null) {
                                jumpInPlace();
                            } else if (matches[cursor] != null) {
                                choose(matches[cursor].path);
                            }
                        }
                    }}
                    className="w-full border-b border-border bg-transparent px-4 py-3 text-[13px] text-primary outline-none placeholder:text-muted"
                />
                <div className="max-h-[50vh] overflow-y-auto">
                    {matches.length === 0 ? (
                        <div className="px-4 py-3 text-[12.5px] text-muted">No matching files</div>
                    ) : (
                        matches.map((m, i) => (
                            <button
                                key={m.path}
                                type="button"
                                onMouseEnter={() => setCursor(i)}
                                onClick={() => choose(m.path)}
                                className={cn(
                                    "block w-full cursor-pointer truncate px-4 py-1.5 text-left font-mono text-[12px] text-secondary",
                                    i === cursor && "bg-accent/10 text-accent-soft"
                                )}
                            >
                                {m.path}
                            </button>
                        ))
                    )}
                </div>
                {index?.truncated ? (
                    <div className="border-t border-border px-4 py-1.5 text-[11px] text-muted">
                        Index truncated — searching the first 20,000 files only.
                    </div>
                ) : null}
            </div>
        </div>
    );
}
