// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The workspace File tab's Diff: the file's one-path patch against HEAD, read each time the view mounts, drawn as the
// Changes tab's hunk rows and landed on the cited line.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { DIFF_NOTES, DiffHunks } from "@/app/view/agents/diffhunks";
import { parseUnifiedDiff } from "@/app/view/agents/unifieddiff";
import type { ChangesHunk } from "@/app/view/agents/workspacechangesmodel";
import { PATCH_RPC_TIMEOUT_MS } from "@/app/view/agents/workspacechangesstore";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { TabDiffRead } from "./codepeekmodel";

// against HEAD, the base the header's numstat stat reads, so the rows and its +/- agree; never cached, so the rows
// always match the file on disk
export function useTabDiffRead(root: string, rel: string): TabDiffRead {
    const [read, setRead] = useState<TabDiffRead>({ kind: "loading" });
    useEffect(() => {
        let live = true;
        setRead({ kind: "loading" });
        RpcApi.GitPatchCommand(
            TabRpcClient,
            { cwd: root, ref: "", path: rel, ignorews: false },
            { timeout: PATCH_RPC_TIMEOUT_MS }
        ).then(
            (rtn) => {
                if (live) {
                    setRead({
                        kind: "read",
                        files: parseUnifiedDiff(rtn.patch) ?? [],
                        truncated: rtn.truncated ?? false,
                    });
                }
            },
            (e) => {
                if (live) {
                    const message =
                        (e instanceof Error ? e.message : String(e ?? "")) || "The read failed with no message.";
                    setRead({ kind: "failed", message });
                }
            }
        );
        return () => {
            live = false;
        };
    }, [root, rel]);
    return read;
}

// the Changes tab's hunk background and its padding, as the Diff board draws it
function DiffBody({ children, bodyRef }: { children?: ReactNode; bodyRef?: Ref<HTMLDivElement> }) {
    return (
        <div ref={bodyRef} data-peek-diff className="relative h-full overflow-y-auto bg-surface-code pt-[4px] pb-[6px]">
            {children}
        </div>
    );
}

export function TabDiffNote({ note }: { note: keyof typeof DIFF_NOTES }) {
    return (
        <DiffBody>
            <div data-changes-note={note} className="px-[13px] py-[8px] font-mono text-[11.5px] text-muted">
                {DIFF_NOTES[note]}
            </div>
        </DiffBody>
    );
}

export function TabDiffBlank() {
    return <DiffBody />;
}

// lands the cited row in the middle of the body, as Source centres its line; with none the body stays at the top
export function TabDiffHunks({
    hunks,
    cited,
    landOn,
}: {
    hunks: ChangesHunk[];
    cited: number | null;
    landOn: number | null;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const body = ref.current;
        const row = landOn == null ? null : body?.querySelector<HTMLElement>("[data-diff-cited]");
        if (body == null || row == null) {
            return;
        }
        // offsets, not client rects: the view swap's fade may still be transforming the body
        body.scrollTop = row.offsetTop - (body.clientHeight - row.offsetHeight) / 2;
    }, [landOn]);
    return (
        <DiffBody bodyRef={ref}>
            <DiffHunks hunks={hunks} cited={cited} />
        </DiffBody>
    );
}
