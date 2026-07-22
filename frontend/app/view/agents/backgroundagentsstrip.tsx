// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Background section: detached `claude --bg` / `claude agents` sessions the hook roster can't see
// (they have no Wave block). Deduped against live agents by session id and scoped by the same project
// switcher as the roster. Background agents are view + attach only — no transcript/answer/open (there's
// no block to drive); Attach resumes one into a fresh Wave terminal, after which it becomes a normal
// hook-tracked agent.

import { attachBackgroundAgent } from "@/app/cockpit/cockpit-actions";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import { dedupBackgroundAgents, formatAge, matchesProjectFilter, type AgentVM } from "./agentsviewmodel";
import { backgroundAgentVMsAtom } from "./backgroundagentsstore";

export function BackgroundAgentsStrip({ model }: { model: AgentsViewModel }) {
    const backgroundVMs = useAtomValue(backgroundAgentVMsAtom);
    const live = useAtomValue(model.agentsAtom);
    const projectFilter = useAtomValue(model.projectFilterAtom);

    const shown = dedupBackgroundAgents(backgroundVMs, live).filter((a) => matchesProjectFilter(a, projectFilter));
    if (shown.length === 0) {
        return null;
    }

    const attach = (a: AgentVM) =>
        fireAndForget(() =>
            attachBackgroundAgent(model, { sessionId: a.id, cwd: a.cwd ?? "", project: a.project ?? "" })
        );

    return (
        <div className="shrink-0 border-b border-edge-mid px-4 py-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-mid">
                Background · {shown.length}
            </div>
            <div className="flex flex-col gap-1">
                {shown.map((a) => (
                    <div
                        key={a.id}
                        className="flex items-center gap-2 rounded-[9px] border border-edge-mid bg-lane px-3 py-1.5"
                    >
                        <span className={a.needsInput ? "text-warning" : "text-ink-mid"}>●</span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{a.name}</span>
                        {a.project ? <span className="shrink-0 text-[11px] text-ink-mid">{a.project}</span> : null}
                        {a.needsInput ? (
                            <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
                                needs input
                            </span>
                        ) : null}
                        <span className="shrink-0 text-[11px] text-ink-mid">{formatAge(a.activeMs)}</span>
                        <button
                            onClick={() => attach(a)}
                            className="shrink-0 rounded-[7px] border border-border px-[11px] py-[3px] text-[11px] font-semibold text-ink-mid hover:text-foreground"
                        >
                            Attach
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
