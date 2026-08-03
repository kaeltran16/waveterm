// frontend/app/view/code/codeviewer.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Renders whichever variant the store resolved the opened file to. The text case hands off to the
// existing Monaco wrapper, which derives the language from the filename — so Go, Rust and TypeScript
// all highlight without a language map here. Only the text case is editable; every other variant
// (binary, too large, missing, unreadable) stays a dead end by construction.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { SurfaceEmptyState } from "@/app/view/agents/surfacescaffold";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { joinRepoPath } from "@/util/paths";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { codeDraftsAtom, codeFileAtom, codeProjectAtom, draftKey, editDraft, refreshIndex } from "./codestore";

function sizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CodeViewer({ model }: { model: AgentsViewModel }) {
    const file = useAtomValue(codeFileAtom);
    const project = useAtomValue(codeProjectAtom);
    const drafts = useAtomValue(codeDraftsAtom);

    switch (file.kind) {
        case "none":
            return (
                <SurfaceEmptyState
                    title="No file open"
                    body="Pick a file from the tree, or press f to search by name."
                />
            );
        case "loading":
            return <SurfaceEmptyState title="Opening…" body={file.path} />;
        case "missing":
            return (
                <SurfaceEmptyState
                    title="File no longer exists"
                    body={`${file.path} — the file list is a snapshot, so it can fall behind.`}
                    action={{ label: "Refresh index", onClick: () => fireAndForget(refreshIndex) }}
                />
            );
        case "binary":
            return <SurfaceEmptyState title="Binary file" body={`${file.path} — ${sizeLabel(file.size)}`} />;
        case "toolarge":
            return (
                <SurfaceEmptyState
                    title="File too large to display"
                    body={`${file.path} — ${sizeLabel(file.size)}`}
                    action={{
                        label: "Copy path",
                        onClick: () => {
                            if (project != null) {
                                void navigator.clipboard?.writeText(joinRepoPath(project.path, file.path));
                            }
                        },
                    }}
                />
            );
        case "error":
            return <SurfaceEmptyState title="Could not read the file" body={`${file.path} — ${file.message}`} />;
        case "text": {
            // `text` is the draft when one exists, so the buffer survives a surface unmount. Monaco's
            // prop-sync effect no-ops when the incoming text already equals the model's (monaco-react
            // checks before pushing an edit), so feeding our own keystrokes back does not move the caret.
            const draft = project != null ? drafts.get(draftKey(project, file.path)) : undefined;
            return (
                <CodeEditor
                    key={file.path}
                    blockId={model.blockId}
                    text={draft?.text ?? file.text}
                    fileName={file.path}
                    readonly={false}
                    onChange={editDraft}
                />
            );
        }
    }
}
