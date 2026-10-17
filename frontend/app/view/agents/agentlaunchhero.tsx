// frontend/app/view/agents/agentlaunchhero.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent-tab "No terminal running" state (handoff dc.html tui.notLaunched, lines 569-583): a
// launch CTA + a list of recent sessions (from recentsessionsstore), each marked with its runtime, to resume.
// Resume + launch both route through launchAgent; resume passes `claude --resume <id>` and no task,
// so the agent picks up its prior session in its original cwd.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import { formatChordString } from "@/util/keysym";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAge, formatTokens } from "./agentsviewmodel";
import type { Runtime } from "./launch";
import { loadRecentSessions, recentSessionsAtom } from "./recentsessionsstore";
import { RuntimeMark } from "./runtimemark";

export function AgentLaunchHero({ model }: { model: AgentsViewModel }) {
    const sessions = useAtomValue(recentSessionsAtom);
    useEffect(() => {
        fireAndForget(loadRecentSessions);
    }, []);

    // Open the New Agent modal (same atom as the app-bar "+New agent" and Cmd+N) so the user picks
    // project/runtime/task — rather than launching a bare `claude` in an empty cwd.
    const launchFresh = () => globalStore.set(model.newAgentOpenAtom, true);

    const resume = (s: SessionInfo) => {
        const piResume =
            s.runtime === "pi" && s.resumeargs?.length
                ? { startupArgs: s.resumeargs, resumePath: s.transcriptpath }
                : {};
        fireAndForget(() =>
            launchAgent(model, {
                runtime: s.runtime as Runtime,
                startupCommand: s.resumecommand,
                task: "",
                projectPath: s.projectpath,
                projectName: s.projectname || "agent",
                ...piResume,
            })
        );
    };

    const now = Date.now();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center bg-background px-8 py-9">
            <div className="flex w-full max-w-[440px] flex-col items-center text-center">
                <div className="mb-5 flex h-[54px] w-[54px] items-center justify-center rounded-[14px] border border-edge-mid bg-surface-raised text-accent">
                    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 4 6.5 8 3 12" />
                        <line x1="8.5" y1="12" x2="13" y2="12" />
                    </svg>
                </div>
                <div className="text-[16px] font-semibold text-primary">No terminal running</div>
                <p className="mt-2 max-w-[350px] text-[13px] leading-[1.55] text-muted">
                    Start an agent and its full TUI runs live right here.
                </p>
                <button
                    type="button"
                    onClick={launchFresh}
                    className="mt-[22px] flex cursor-pointer items-center gap-2 rounded-[9px] bg-accent px-[18px] py-[10px] text-[13px] font-semibold text-background hover:bg-accenthover"
                >
                    New agent
                    <span className="rounded-sm bg-background/15 px-[6px] py-[2px] font-mono text-[10.5px] font-semibold">
                        {formatChordString("Ctrl:n")}
                    </span>
                </button>

                {sessions != null && sessions.length > 0 ? (
                    <div className="mt-6 w-full overflow-hidden rounded-lg border border-border bg-surface text-left">
                        <div className="flex items-center gap-2 px-[14px] pb-[9px] pt-[11px] font-mono text-[10.5px] font-semibold uppercase tracking-[.1em] text-muted">
                            <span>Recent sessions</span>
                            <span className="opacity-60">{sessions.length}</span>
                            <div className="flex-1" />
                            <span className="opacity-60">select one to resume</span>
                        </div>
                        {sessions.map((s) => (
                            <button
                                key={s.id}
                                type="button"
                                onClick={() => resume(s)}
                                className="flex w-full cursor-pointer items-center gap-[11px] border-t border-border px-[14px] py-[11px] text-left hover:bg-surface-hover"
                            >
                                <RuntimeMark
                                    runtime={s.runtime}
                                    className="w-4 shrink-0 text-center text-[11px] leading-none text-muted"
                                    imageClassName="h-4 w-4 shrink-0"
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[12.5px] font-semibold text-primary">
                                        {s.task || "(untitled session)"}
                                    </div>
                                    <div className="mt-[2px] truncate font-mono text-[10.5px] text-muted">
                                        {s.projectname} · {s.branch || "—"} · {s.model || "—"} · {formatTokens(s.tokenstotal)} tok
                                    </div>
                                </div>
                                <span className="shrink-0 font-mono text-[10.5px] text-muted">
                                    {formatAge(now - s.lastactivets)}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
