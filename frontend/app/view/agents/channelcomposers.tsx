// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The channel composer's two faces. Launch: a goal input driven by typed @quick/@run/@ask commands
// with an autocomplete. Talk: a plain message box addressed to the selected run's live worker. Both
// render through the shared ComposerShell and drive their vocabulary from composercommand.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { type AgentVM } from "./agentsviewmodel";
import { activeMentionQuery } from "./channelderive";
import { ComposerShell } from "./composer-shell";
import { LAUNCH_COMMANDS, parseComposerCommand, runFooterFor, type LaunchMode } from "./composercommand";

// Launch face: a plain goal input driven by typed @quick/@run/@ask commands (a bare goal defaults to
// @run). Typing a leading `@` opens an autocomplete of the three; a mid-text `@` is left as-is. The
// footer surfaces what the parsed mode will do — @run's strategy comes from the channel's ⚙ profile.
export function LaunchComposer({
    value,
    onChange,
    onSubmit,
    profile,
    channelName,
    pending,
}: {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    profile: JarvisProfile | undefined;
    channelName: string;
    pending: boolean;
}) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    const pendingCaret = useRef<number | null>(null);
    const [sugg, setSugg] = useState<{ query: string; start: number } | null>(null);
    const [sel, setSel] = useState(0);

    const mode: LaunchMode = pending ? "run" : parseComposerCommand(value).mode;
    // only a leading `@` token is a command — mid-text `@` (start > 0) is not
    const matches =
        sugg && sugg.start === 0
            ? LAUNCH_COMMANDS.filter((c) => c.cmd.startsWith("@" + sugg.query.toLowerCase()))
            : [];
    const open = matches.length > 0;

    useEffect(() => setSel(0), [sugg?.query, sugg?.start]);
    useLayoutEffect(() => {
        if (pendingCaret.current != null && taRef.current) {
            const p = pendingCaret.current;
            pendingCaret.current = null;
            taRef.current.setSelectionRange(p, p);
        }
    }, [value]);

    const syncSuggest = () => {
        const ta = taRef.current;
        if (ta) {
            setSugg(activeMentionQuery(ta.value, ta.selectionStart ?? ta.value.length));
        }
    };
    const accept = (cmd: (typeof LAUNCH_COMMANDS)[number]) => {
        const rest = value.slice((sugg?.query.length ?? 0) + 1); // drop the leading "@query" token
        const next = cmd.cmd + " " + rest.replace(/^\s+/, "");
        pendingCaret.current = cmd.cmd.length + 1;
        setSugg(null);
        onChange(next);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (open) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => (s + 1) % matches.length);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => (s - 1 + matches.length) % matches.length);
                return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                accept(matches[Math.min(sel, matches.length - 1)]);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setSugg(null);
                return;
            }
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
        }
    };

    const footer =
        pending || mode === "run"
            ? runFooterFor(profile)
            : mode === "quick"
              ? `→ spawns one worker in #${channelName}`
              : "→ no worker · answer lands in Consults";
    const sendLabel = mode === "ask" ? "Ask" : "Run ⏎";

    return (
        <ComposerShell
            onSubmit={onSubmit}
            sendLabel={sendLabel}
            sendDisabled={!value.trim()}
            overlay={
                open ? (
                    <div className="absolute bottom-full left-0 mb-1.5 w-[300px] overflow-hidden rounded-[9px] border border-edge-strong bg-surface-raised shadow-lg">
                        {matches.map((c, i) => (
                            <button
                                key={c.cmd}
                                type="button"
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    accept(c);
                                }}
                                onMouseEnter={() => setSel(i)}
                                className={
                                    "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left " +
                                    (i === sel ? "bg-accentbg" : "")
                                }
                            >
                                <span className="font-mono text-[12.5px] font-semibold text-accent-soft">{c.cmd}</span>
                                <span className="ml-auto font-mono text-[10px] text-muted">{c.desc}</span>
                            </button>
                        ))}
                    </div>
                ) : null
            }
            inputRegion={
                <textarea
                    ref={taRef}
                    value={value}
                    onChange={(e) => {
                        onChange(e.target.value);
                        syncSuggest();
                    }}
                    onKeyDown={onKeyDown}
                    onKeyUp={syncSuggest}
                    onClick={syncSuggest}
                    onBlur={() => setSugg(null)}
                    rows={1}
                    autoFocus
                    placeholder="Give Jarvis a goal…"
                    className="field-sizing-content max-h-[160px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none"
                    style={{ caretColor: "var(--color-primary)" }}
                />
            }
            footerLeft={<span className="font-mono text-[11px] text-ink-mid">{footer}</span>}
        />
    );
}

// Talk face: a plain message box addressed to the run's live worker. Sending injects the text as a
// follow-up turn (the behavior formerly called "Steer"). No command autocomplete; a + New run breaks
// back to the Launch face.
export function TalkComposer({
    worker,
    phaseLabel,
    value,
    onChange,
    onSubmit,
    onNewRun,
}: {
    worker: AgentVM;
    phaseLabel: string | undefined;
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    onNewRun: () => void;
}) {
    return (
        <ComposerShell
            onSubmit={onSubmit}
            sendLabel="Send ⏎"
            sendDisabled={!value.trim()}
            inputRegion={
                <>
                    <div className="mb-2.5 flex items-center gap-2 border-b border-edge-mid pb-2.5">
                        <span className="text-[12px] font-bold text-primary">{worker.name}</span>
                        <span className="rounded-[4px] bg-success/12 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[.05em] text-success">
                            live
                        </span>
                        {phaseLabel ? <span className="text-[11px] text-muted">· {phaseLabel}</span> : null}
                        <div className="flex-1" />
                        <button
                            type="button"
                            onClick={onNewRun}
                            className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11px] text-muted hover:border-edge-strong hover:text-secondary"
                        >
                            ＋ New run
                        </button>
                    </div>
                    <textarea
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                onSubmit();
                            }
                        }}
                        rows={1}
                        autoFocus
                        placeholder={`Message ${worker.name}…`}
                        className="field-sizing-content max-h-[160px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none"
                        style={{ caretColor: "var(--color-primary)" }}
                    />
                </>
            }
            footerLeft={
                <span className="font-mono text-[11px] text-ink-mid">→ injected as a follow-up turn to {worker.name}</span>
            }
        />
    );
}
