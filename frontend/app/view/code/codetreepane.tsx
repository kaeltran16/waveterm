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

import { composerReveal, errorNudge, microFade, turnTransition } from "@/app/element/motiontokens";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { focusClaimed } from "@/app/store/keybindings/dispatcher";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { joinRepoPath } from "@/util/paths";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { ChevronRight, File, FilePlus, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { projectDraftPaths } from "./codedraft";
import { existingTreePaths, nameErrorMessage, provisionalIndex, validateName } from "./codemutate";
import { changedDirs, statusGlyph, type CodeStatus } from "./codestatus";
import {
    cancelEdit,
    checkStale,
    codeCursorAtom,
    codeDraftsAtom,
    codeEditAtom,
    codeFileAtom,
    codeIndexAtom,
    codePlainAtom,
    codeProjectAtom,
    codeRowsAtom,
    codeSessionDirsAtom,
    codeStatusAtom,
    codeStatusDirsAtom,
    codeTreeFocusedAtom,
    confirmDelete,
    createEntry,
    draftKey,
    openPath,
    renamePath,
    startCreate,
    startRename,
    toggleDir,
} from "./codestore";
import type { TreeRow } from "./codetree";

// Rows inserted while the tree is on screen (a directory expanded) fade in; a new index (a project switch, a
// refresh) reseeds silently, so a whole tree arriving never cascades. An arrived row stays in the set while it
// is shown, so it keeps rendering as the same element and a re-render never cuts its fade with a remount; the
// rest stay plain divs, since a tree can hold hundreds of rows.
function useArrivedRows(index: object | null, ids: string[], off: boolean): ReadonlySet<string> {
    const shown = useRef<{ index: object | null; ids: Set<string> } | null>(null);
    const arrived = useRef(new Set<string>());
    const live = new Set(ids);
    const prev = shown.current;
    for (const id of arrived.current) {
        if (!live.has(id)) {
            arrived.current.delete(id);
        }
    }
    if (!off && prev != null && prev.index === index) {
        for (const id of ids) {
            if (!prev.ids.has(id)) {
                arrived.current.add(id);
            }
        }
    }
    useLayoutEffect(() => {
        shown.current = { index, ids: live };
    });
    return arrived.current;
}

export function CodeTreePane({ model }: { model: AgentsViewModel }) {
    void model;
    const rows = useAtomValue(codeRowsAtom);
    const cursor = useAtomValue(codeCursorAtom);
    const file = useAtomValue(codeFileAtom);
    const project = useAtomValue(codeProjectAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    // read once for the whole pane rather than per row: hundreds of rows would otherwise mean
    // hundreds of subscriptions
    const status = useAtomValue(codeStatusAtom);
    const changedDirSet = useAtomValue(codeStatusDirsAtom);
    const edit = useAtomValue(codeEditAtom);
    const index = useAtomValue(codeIndexAtom);
    const plain = useAtomValue(codePlainAtom);
    const sessionDirs = useAtomValue(codeSessionDirsAtom);
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    const arrived = useArrivedRows(
        index,
        rows.map((r) => r.path),
        reduce
    );
    const draftDirs = useMemo(
        () => changedDirs(project == null ? [] : projectDraftPaths(drafts, project.path)),
        [drafts, project]
    );
    const openFile = file.kind === "none" ? null : file.path;
    const rowRefs = useRef(new Map<string, HTMLDivElement>());
    const treeRef = useRef<HTMLDivElement>(null);

    // the tree keys (j/k, arrows, Enter, n) need the tree focused, and arriving on Code left focus on
    // <body>, so they were dead until a click or Alt+T
    useEffect(() => {
        if (!focusClaimed()) {
            treeRef.current?.focus({ preventScroll: true });
        }
        // an unmount fires no blur, so a tree that held focus would leave the flag set and its
        // arrow bindings would take keys from whatever pane replaced it
        return () => globalStore.set(codeTreeFocusedAtom, false);
    }, []);

    const paths = useMemo(() => existingTreePaths(index?.paths ?? [], [...sessionDirs]), [index, sessionDirs]);
    const provisional = edit?.kind === "create" ? provisionalIndex(rows, edit.dir) : -1;
    const provisionalDepth =
        edit?.kind === "create" && edit.dir !== "" ? (rows.find((r) => r.path === edit.dir)?.depth ?? -1) + 1 : 0;

    // a finder or search jump expands ancestors, which is invisible if the row it revealed is
    // off-screen; the cursor is what makes the landing visible
    useEffect(() => {
        if (cursor != null) {
            rowRefs.current.get(cursor)?.scrollIntoView({ block: "nearest" });
        }
    }, [cursor]);

    const provisionalInput =
        edit?.kind === "create" ? (
            <NameInput
                key="__provisional"
                initial=""
                dir={edit.dir}
                depth={provisionalDepth}
                existing={paths}
                onCommit={(name) => fireAndForget(() => createEntry(edit.dir, name, edit.isDir))}
            />
        ) : null;

    const renderRow = (row: TreeRow) => {
        const rowProps = {
            ref: (el: HTMLDivElement | null) => {
                if (el == null) {
                    rowRefs.current.delete(row.path);
                } else {
                    rowRefs.current.set(row.path, el);
                }
            },
            role: "treeitem",
            "aria-selected": row.path === cursor,
            "aria-expanded": row.kind === "dir" ? row.expanded : undefined,
            onClick: () => {
                globalStore.set(codeCursorAtom, row.path);
                if (row.kind === "dir") {
                    toggleDir(row.path);
                } else {
                    fireAndForget(() => openPath(row.path));
                }
            },
            onContextMenu: (ev: React.MouseEvent) => {
                // startCreate reads the cursor, so moving it first is what makes New File land where
                // the user pointed rather than where they last clicked
                globalStore.set(codeCursorAtom, row.path);
                ContextMenuModel.getInstance().showContextMenu(
                    [
                        {
                            label: "New File",
                            icon: <FilePlus size={13} strokeWidth={1.8} />,
                            click: () => startCreate(false),
                        },
                        {
                            label: "New Folder",
                            icon: <FolderPlus size={13} strokeWidth={1.8} />,
                            click: () => startCreate(true),
                        },
                        { type: "separator" },
                        {
                            label: "Rename",
                            icon: <Pencil size={13} strokeWidth={1.8} />,
                            accel: "F2",
                            click: () => startRename(row.path),
                        },
                        {
                            label: "Delete",
                            icon: <Trash2 size={13} strokeWidth={1.8} />,
                            danger: true,
                            accel: "Delete",
                            click: () => confirmDelete(row.path, row.kind === "dir"),
                        },
                        { type: "separator" },
                        {
                            label: "Copy Path",
                            click: () => {
                                if (project != null) {
                                    void navigator.clipboard?.writeText(joinRepoPath(project.path, row.path));
                                }
                            },
                        },
                    ],
                    ev
                );
            },
            style: { paddingLeft: 8 + row.depth * 12 },
            className: cn(
                "flex w-full cursor-pointer items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] text-secondary hover:bg-accent/10 hover:text-primary",
                row.path === openFile && "text-accent-soft",
                row.path === cursor && "bg-accent/10"
            ),
        };
        const body = renderRowBody(row);
        return arrived.has(row.path) ? (
            <motion.div key={row.path} {...rowProps} variants={microFade} initial="initial" animate="animate">
                {body}
            </motion.div>
        ) : (
            <div key={row.path} {...rowProps}>
                {body}
            </div>
        );
    };

    const renderRowBody = (row: TreeRow) => (
        <>
            {row.kind === "dir" ? (
                <ChevronRight
                    size={13}
                    strokeWidth={1.8}
                    data-code-tree-chevron
                    style={turnTransition}
                    className={cn(
                        "flex-none transition-transform motion-reduce:transition-none",
                        row.expanded && "rotate-90"
                    )}
                />
            ) : (
                <File size={13} strokeWidth={1.8} className="flex-none opacity-50" />
            )}
            {edit?.kind === "rename" && edit.path === row.path ? (
                <NameInput
                    initial={row.name}
                    dir={row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : ""}
                    depth={0}
                    existing={paths.filter((p) => p !== row.path && !p.startsWith(`${row.path}/`))}
                    onCommit={(name) => fireAndForget(() => renamePath(row.path, name))}
                />
            ) : (
                <span className="min-w-0 truncate">{row.name}</span>
            )}
            <span className="ml-auto flex flex-none items-center gap-1.5">
                {row.kind === "file" ? <StatusMark s={status?.get(row.path)} /> : null}
                {/* a collapsed directory is the only place the roll-up has anything to say:
                    expanded, the rows underneath speak for themselves */}
                {row.kind === "dir" && !row.expanded && changedDirSet.has(row.path) ? (
                    <span
                        aria-label="Contains changes"
                        title="Contains changes"
                        className="size-[5px] rounded-full bg-muted"
                    />
                ) : null}
                {/* drafts survive an unmount, so unsaved work can exist on a file you are not
                    looking at — the dot is the only thing that says so */}
                {row.kind === "file" && project != null && drafts.has(draftKey(project, row.path)) ? (
                    <span
                        aria-label="Unsaved edits"
                        title="Unsaved edits"
                        className="size-[6px] rounded-full bg-accent-soft"
                    />
                ) : null}
                {row.kind === "dir" && !row.expanded && draftDirs.has(row.path) ? (
                    <span
                        aria-label="Contains unsaved edits"
                        title="Contains unsaved edits"
                        className="size-[6px] rounded-full bg-accent-soft"
                    />
                ) : null}
            </span>
        </>
    );

    return (
        <div className="flex h-full flex-col border-r border-border">
            {/* above the rows rather than after them: a truncated list is the one too long to scroll to
                the end of, and a missing file otherwise just looks deleted */}
            {index?.truncated ? (
                <div
                    data-code-tree-truncated
                    className="flex-none border-b border-border px-3 py-1.5 text-[11px] text-muted"
                >
                    File list truncated — showing the first 20,000 files only.
                </div>
            ) : null}
            <div
                ref={treeRef}
                role="tree"
                tabIndex={0}
                data-code-tree
                onFocus={() => {
                    globalStore.set(codeTreeFocusedAtom, true);
                    fireAndForget(checkStale);
                }}
                onBlur={() => globalStore.set(codeTreeFocusedAtom, false)}
                className="min-h-0 flex-1 overflow-y-auto py-2 outline-none"
            >
                {rows.flatMap((row, i) => {
                    const out: React.ReactNode[] = [];
                    if (i === provisional) {
                        out.push(provisionalInput);
                    }
                    out.push(renderRow(row));
                    return out;
                })}
                {provisional >= rows.length ? provisionalInput : null}
            </div>
            {/* no .gitignore to honor here, so the walk's fixed skip set is stated rather than mysterious */}
            {plain ? (
                <div
                    data-code-tree-skipset
                    className="flex-none border-t border-border px-3 py-1.5 text-[11px] text-muted"
                >
                    Skipping node_modules, dist, target, dot-folders and other build output.
                </div>
            ) : null}
        </div>
    );
}

// Enter commits, Escape cancels, and the error shows while you type — the pre-check reads the index
// snapshot, so it can be wrong, which is why the write still surfaces the backend's error.
function NameInput({
    initial,
    dir,
    depth,
    existing,
    onCommit,
}: {
    initial: string;
    dir: string;
    depth: number;
    existing: readonly string[];
    onCommit: (name: string) => void;
}) {
    const [value, setValue] = useState(initial);
    // an unchanged rename is not an error, but an empty create is — so the skip only applies to a
    // name that is both non-empty and untouched
    const trimmed = value.trim();
    const err = trimmed !== "" && trimmed === initial ? null : validateName(value, dir, existing);
    return (
        <motion.div
            variants={composerReveal}
            initial="initial"
            animate="animate"
            style={{ paddingLeft: 8 + depth * 12 }}
            className="flex w-full items-center gap-1.5 overflow-hidden py-[3px] pr-2"
            // a rename draws this inside its row, whose click opens the file or folds the folder: placing the caret
            // must do neither
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
        >
            <input
                autoFocus
                value={value}
                data-code-name-input
                onChange={(e) => setValue(e.target.value)}
                onBlur={cancelEdit}
                onKeyDown={(e) => {
                    e.stopPropagation(); // the tree's j/k/n bindings must not eat what you type
                    if (e.key === "Escape") {
                        cancelEdit();
                    }
                    if (e.key === "Enter" && err == null) {
                        onCommit(trimmed);
                    }
                }}
                className="min-w-0 flex-1 rounded-[4px] border border-border bg-surface px-1 py-[1px] text-[12px] text-primary outline-none"
            />
            {/* the error says the name just typed is at fault: it fades in and nudges once on appearing, but not
                when the editor opens on an empty name */}
            <AnimatePresence initial={false}>
                {err != null ? (
                    <motion.span
                        key="err"
                        data-code-name-error
                        variants={microFade}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        title={nameErrorMessage(err)}
                        className="flex-none text-[10.5px] text-error"
                    >
                        <motion.span variants={errorNudge} className="inline-block">
                            {nameErrorMessage(err)}
                        </motion.span>
                    </motion.span>
                ) : null}
            </AnimatePresence>
        </motion.div>
    );
}

function StatusMark({ s }: { s: CodeStatus | undefined }) {
    if (s == null) {
        return null;
    }
    const g = statusGlyph(s.status);
    return (
        <span data-code-status={g.letter} title={g.label} className={cn("font-mono text-[10.5px]", g.className)}>
            {g.letter}
        </span>
    );
}
