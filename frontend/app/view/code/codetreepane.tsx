// frontend/app/view/code/codetreepane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The directory tree, built from the same flat path list the finder indexes — one source of truth,
// so the two can never disagree about what exists.
//
// The pane is a single focus owner (role="tree" + tabIndex), not a stack of buttons: the Code
// keybindings are gated on this pane holding focus, and a focused row button would make Enter fire
// both the binding and the button's own click. It registers no list-nav controller — a two-focus
// surface owns its keys (see listnav.ts), and the shared "moving is selecting" contract would make
// every cursor step read a file over RPC.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, File } from "lucide-react";
import { useEffect, useRef } from "react";
import {
    codeCursorAtom,
    codeDraftsAtom,
    codeFileAtom,
    codeProjectAtom,
    codeRowsAtom,
    codeTreeFocusedAtom,
    draftKey,
    openPath,
    toggleDir,
} from "./codestore";

export function CodeTreePane({ model }: { model: AgentsViewModel }) {
    void model;
    const rows = useAtomValue(codeRowsAtom);
    const cursor = useAtomValue(codeCursorAtom);
    const file = useAtomValue(codeFileAtom);
    const project = useAtomValue(codeProjectAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    const openFile = file.kind === "none" ? null : file.path;
    const rowRefs = useRef(new Map<string, HTMLDivElement>());

    // a finder or search jump expands ancestors, which is invisible if the row it revealed is
    // off-screen; the cursor is what makes the landing visible
    useEffect(() => {
        if (cursor != null) {
            rowRefs.current.get(cursor)?.scrollIntoView({ block: "nearest" });
        }
    }, [cursor]);

    return (
        <div
            role="tree"
            tabIndex={0}
            data-code-tree
            onFocus={() => globalStore.set(codeTreeFocusedAtom, true)}
            onBlur={() => globalStore.set(codeTreeFocusedAtom, false)}
            className="h-full overflow-y-auto border-r border-border py-2 outline-none"
        >
            {rows.map((row) => (
                <div
                    key={row.path}
                    ref={(el) => {
                        if (el == null) {
                            rowRefs.current.delete(row.path);
                        } else {
                            rowRefs.current.set(row.path, el);
                        }
                    }}
                    role="treeitem"
                    aria-selected={row.path === cursor}
                    aria-expanded={row.kind === "dir" ? row.expanded : undefined}
                    onClick={() => {
                        globalStore.set(codeCursorAtom, row.path);
                        if (row.kind === "dir") {
                            toggleDir(row.path);
                        } else {
                            fireAndForget(() => openPath(row.path));
                        }
                    }}
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                    className={cn(
                        "flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] text-secondary hover:bg-accent/10 hover:text-primary",
                        row.path === openFile && "text-accent-soft",
                        row.path === cursor && "bg-accent/10"
                    )}
                >
                    {row.kind === "dir" ? (
                        row.expanded ? (
                            <ChevronDown size={13} strokeWidth={1.8} className="flex-none" />
                        ) : (
                            <ChevronRight size={13} strokeWidth={1.8} className="flex-none" />
                        )
                    ) : (
                        <File size={13} strokeWidth={1.8} className="flex-none opacity-50" />
                    )}
                    <span className="truncate">{row.name}</span>
                    {/* drafts survive an unmount, so unsaved work can exist on a file you are not looking
                        at — the dot is the only thing that says so */}
                    {row.kind === "file" && project != null && drafts.has(draftKey(project, row.path)) ? (
                        <span
                            aria-label="Unsaved edits"
                            title="Unsaved edits"
                            className="ml-auto size-[6px] flex-none rounded-full bg-accent-soft"
                        />
                    ) : null}
                </div>
            ))}
        </div>
    );
}
