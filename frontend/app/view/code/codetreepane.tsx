// frontend/app/view/code/codetreepane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The directory tree, built from the same flat path list the finder indexes — one source of truth,
// so the two can never disagree about what exists.

import { useSurfaceListNav } from "@/app/store/keybindings/listnav";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, File } from "lucide-react";
import { useMemo } from "react";
import { codeExpandedAtom, codeFileAtom, codeIndexAtom, openPath, toggleDir } from "./codestore";
import { buildTree, visibleRows } from "./codetree";

export function CodeTreePane({ model }: { model: AgentsViewModel }) {
    void model;
    const index = useAtomValue(codeIndexAtom);
    const expanded = useAtomValue(codeExpandedAtom);
    const file = useAtomValue(codeFileAtom);
    const selected = file.kind === "none" ? null : file.path;

    const tree = useMemo(() => buildTree(index?.paths ?? []), [index]);
    const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

    // Enter on a directory expands it, on a file opens it — the cursor IS the selection, so the
    // shared j/k/arrow bindings drive this without the pane owning any keys of its own.
    useSurfaceListNav(
        useMemo(
            () => ({
                surface: "code" as const,
                navigableIds: rows.map((r) => r.path),
                cursorId: selected ?? rows[0]?.path,
                setCursor: (id: string) => {
                    const row = rows.find((r) => r.path === id);
                    if (row?.kind === "file") {
                        fireAndForget(() => openPath(id));
                    }
                },
                activate: () => {
                    const row = rows.find((r) => r.path === selected);
                    if (row?.kind === "dir") {
                        toggleDir(row.path);
                    }
                },
            }),
            [rows, selected]
        )
    );

    return (
        <div className="h-full overflow-y-auto border-r border-border py-2">
            {rows.map((row) => (
                <button
                    key={row.path}
                    type="button"
                    onClick={() => (row.kind === "dir" ? toggleDir(row.path) : fireAndForget(() => openPath(row.path)))}
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                    className={cn(
                        "flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] text-secondary hover:bg-accent/10 hover:text-primary",
                        row.path === selected && "bg-accent/10 text-accent-soft"
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
                </button>
            ))}
        </div>
    );
}
