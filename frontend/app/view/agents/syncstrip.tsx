// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory-surface projection status: shows which project each lackey runtime's steering file
// currently reflects (from MemoryProjectionStatusCommand), and a "Project now" button that
// projects the focused agent's project into the lackey steering files on demand.

import { atoms } from "@/app/store/global-atoms";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { projectLabel } from "./projectlabel";

const RUNTIME_LABEL: Record<string, string> = { codex: "Codex", antigravity: "Antigravity" };

export function SyncStrip({ focusedCwd }: { focusedCwd: string | null }) {
    const config = useAtomValue(atoms.fullConfigAtom);
    const [status, setStatus] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(() => {
        void RpcApi.MemoryProjectionStatusCommand(TabRpcClient)
            .then((r) => setStatus(r.runtimes ?? {}))
            .catch(() => setStatus({}));
    }, []);

    useEffect(refresh, [refresh]);

    const projectNow = () => {
        if (!focusedCwd || busy) return;
        setBusy(true);
        fireAndForget(async () => {
            try {
                await RpcApi.MemoryProjectCommand(TabRpcClient, { cwd: focusedCwd });
                refresh();
            } finally {
                setBusy(false);
            }
        });
    };

    const label = projectLabel(focusedCwd ?? "", config?.projects ?? {});
    const runtimes = ["codex", "antigravity"];

    return (
        <div className="flex items-center gap-[12px] border-b border-edge-faint px-[16px] py-[9px] text-[12px]">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                Projection
            </span>
            {runtimes.map((rt) => {
                const proj = status[rt];
                return (
                    <span key={rt} className="flex items-center gap-[6px] text-ink-mid">
                        <span className={cn("h-[6px] w-[6px] rounded-full", proj ? "bg-mem-project" : "bg-ink-faint")} />
                        {RUNTIME_LABEL[rt]}
                        {proj ? <span className="text-accent-soft">· {proj}</span> : <span className="text-ink-faint">· none</span>}
                    </span>
                );
            })}
            <div className="flex-1" />
            <button
                onClick={projectNow}
                disabled={!focusedCwd || busy}
                title={focusedCwd ? `Project ${label} into the lackey steering files` : "Focus an agent to project its project"}
                className="rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-semibold text-ink-mid hover:text-foreground disabled:opacity-40"
            >
                {busy ? "Projecting…" : "Project now"}
            </button>
        </div>
    );
}
