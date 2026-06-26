// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Focus-surface transcript, faithful to the handoff (Wave-cockpit-live.dc.html:413-465): agent and
// user turns render as avatar + name + prose; consecutive tool actions coalesce into one bordered
// tool box. (The cockpit card keeps the compact NarrationTimeline; this is the full-height read.)

import { cn } from "@/util/util";
import type { AgentActionEntry, AgentEntry } from "./agentsviewmodel";
import { MarkdownMessage } from "./markdownmessage";

// our action outcome -> handoff status glyph + color token
const STATUS = {
    ok: { glyph: "✓", color: "text-success" },
    fail: { glyph: "✗", color: "text-error" },
    none: { glyph: "▸", color: "text-ink-mid" },
} as const;
const statusOf = (a: AgentActionEntry) =>
    a.outcome === "ok" ? STATUS.ok : a.outcome === "fail" ? STATUS.fail : STATUS.none;

function ToolBox({ actions }: { actions: AgentActionEntry[] }) {
    return (
        <div className="ml-[38px] flex flex-col overflow-hidden rounded-[10px] border border-border bg-surface">
            {actions.map((a, i) => {
                const s = statusOf(a);
                return (
                    <div
                        key={i}
                        className={cn(
                            "flex items-center gap-[9px] px-[13px] py-[9px]",
                            i < actions.length - 1 && "border-b border-edge-faint"
                        )}
                    >
                        <span
                            className={cn(
                                "flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[4px] text-[9px]",
                                s.color
                            )}
                            style={{ background: "color-mix(in srgb, currentColor 14%, transparent)" }}
                        >
                            {s.glyph}
                        </span>
                        <span className="shrink-0 rounded-[5px] border border-edge-mid bg-surface-raised px-[6px] py-[2px] font-mono text-[9.5px] font-semibold uppercase tracking-[.04em] text-ink-mid">
                            {a.verb}
                        </span>
                        <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-secondary">
                            {a.target}
                        </span>
                        {a.note ? (
                            <>
                                <span className="shrink-0 text-[11px] text-ink-faint">→</span>
                                <span className={cn("min-w-0 truncate font-mono text-[12px]", s.color)}>{a.note}</span>
                            </>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

function AgentTurn({ name, text }: { name: string; text: string }) {
    return (
        <div className="flex items-start gap-[12px]">
            <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] border border-accent/30 bg-accent/[0.12]">
                <span className="h-[9px] w-[9px] rounded-full bg-accent-300" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="mb-[5px] font-mono text-[11px] font-semibold text-accent-200">{name}</div>
                <div className="text-[14px] leading-[1.6] text-secondary">
                    <MarkdownMessage text={text} />
                </div>
            </div>
        </div>
    );
}

function UserTurn({ text }: { text: string }) {
    return (
        <div className="flex items-start gap-[12px]">
            <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] border border-edge-mid bg-surface-raised text-ink-mid">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <circle cx="8" cy="5" r="3" />
                    <path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5z" />
                </svg>
            </div>
            <div className="min-w-0 flex-1">
                <div className="mb-[5px] font-mono text-[11px] font-semibold text-accent">You</div>
                <div className="whitespace-pre-wrap text-[14px] leading-[1.6] text-primary">{text}</div>
            </div>
        </div>
    );
}

type Block =
    | { kind: "agent"; text: string; key: number }
    | { kind: "user"; text: string; key: number }
    | { kind: "tools"; actions: AgentActionEntry[]; key: number };

export function FocusTranscript({ entries, agentName }: { entries: AgentEntry[]; agentName: string }) {
    // coalesce consecutive tool actions into one box (the handoff groups tools per box, keyed by the
    // run's first index)
    const blocks: Block[] = [];
    let run: AgentActionEntry[] = [];
    let runKey = -1;
    const flush = () => {
        if (run.length) {
            blocks.push({ kind: "tools", actions: run, key: runKey });
            run = [];
            runKey = -1;
        }
    };
    entries.forEach((e, i) => {
        if (e.kind === "action") {
            if (run.length === 0) {
                runKey = i;
            }
            run.push(e);
        } else {
            flush();
            blocks.push({ kind: e.kind === "user" ? "user" : "agent", text: e.text, key: i });
        }
    });
    flush();

    return (
        <>
            {blocks.map((b) => (
                <div key={b.key}>
                    {b.kind === "agent" ? (
                        <AgentTurn name={agentName} text={b.text} />
                    ) : b.kind === "user" ? (
                        <UserTurn text={b.text} />
                    ) : (
                        <ToolBox actions={b.actions} />
                    )}
                </div>
            ))}
        </>
    );
}
