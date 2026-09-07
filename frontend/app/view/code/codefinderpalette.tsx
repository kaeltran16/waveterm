// frontend/app/view/code/codefinderpalette.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Fuzzy open-by-name over the same flat path list the tree is built from. Opening a file inside a
// collapsed subtree expands its ancestors, so the tree shows where you landed.
//
// This is what Ctrl+P opens on the Code surface; on every other surface the same chord opens the
// command palette. A leading '>' here hands off to that palette (VS Code's convention), so commands
// stay reachable without a second chord.
//
// Built on ModalShell for the same reason the command palette is: hand-rolling the overlay meant
// Escape only worked while the input held focus, and a drag that ended outside the panel counted as
// a backdrop click and dismissed it.

import { ModalShell } from "@/app/modals/modalshell";
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
    const listRef = useRef<HTMLDivElement>(null);

    const parsed = useMemo(() => parseFinderQuery(query), [query]);
    const matches = useMemo(() => rankPaths(parsed.text, index?.paths ?? [], MAX_RESULTS), [parsed.text, index]);
    const selected = Math.min(cursor, Math.max(matches.length - 1, 0));

    useEffect(() => {
        if (open) {
            setQuery("");
            setCursor(0);
            // after paint: ModalShell mounts the panel in the same commit, so the input does not
            // exist yet on the render that flipped `open`
            const raf = requestAnimationFrame(() => inputRef.current?.focus());
            return () => cancelAnimationFrame(raf);
        }
    }, [open]);

    useEffect(() => {
        setCursor(0);
    }, [query]);

    // The list scrolls, the selection did not: arrowing past the ~14th row walked the highlight out
    // of view with the container still at scrollTop 0, so the cursor looked stuck and Enter opened a
    // file the user could not see.
    useEffect(() => {
        listRef.current?.querySelector(`[data-idx="${selected}"]`)?.scrollIntoView({ block: "nearest" });
    }, [selected]);

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

    // On the panel rather than the input: keydown bubbles from wherever focus sits inside the modal,
    // so the list stays keyboard-operable even when focus is not in the field. Escape belongs to
    // ModalShell's window listener, which works from outside the panel too.
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor(matches.length === 0 ? 0 : (selected + 1) % matches.length);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor(matches.length === 0 ? 0 : (selected - 1 + matches.length) % matches.length);
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (parsed.text === "" && parsed.line != null) {
                jumpInPlace();
            } else if (matches[selected] != null) {
                choose(matches[selected].path);
            }
        } else if (e.key === "Tab") {
            // nothing inside is a better focus target than the field, and letting Tab strand focus
            // on a result row left the overlay open with no way back to typing
            e.preventDefault();
            inputRef.current?.focus();
        }
    };

    return (
        <ModalShell open={open} onClose={close} className="flex w-[min(680px,90%)] max-h-[70vh] flex-col">
            {open ? (
                <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
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
                        className="w-full shrink-0 border-b border-border bg-transparent px-4 py-3 text-[13px] text-primary outline-none placeholder:text-muted"
                    />
                    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
                        {matches.length === 0 ? (
                            <div className="px-4 py-3 text-[12.5px] text-muted">No matching files</div>
                        ) : (
                            matches.map((m, i) => (
                                <button
                                    key={m.path}
                                    type="button"
                                    tabIndex={-1}
                                    data-idx={i}
                                    onMouseMove={() => setCursor(i)}
                                    onClick={() => choose(m.path)}
                                    className={cn(
                                        "block w-full cursor-pointer truncate px-4 py-1.5 text-left font-mono text-[12px] text-secondary",
                                        i === selected && "bg-accent/10 text-accent-soft"
                                    )}
                                >
                                    {m.path}
                                </button>
                            ))
                        )}
                    </div>
                    {index?.truncated ? (
                        <div className="shrink-0 border-t border-border px-4 py-1.5 text-[11px] text-muted">
                            Index truncated — searching the first 20,000 files only.
                        </div>
                    ) : null}
                </div>
            ) : null}
        </ModalShell>
    );
}
