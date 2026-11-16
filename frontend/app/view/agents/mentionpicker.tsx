// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The rendered composer's @ picker: typing @ lists this project's other live agents above the box, and a
// picked row writes its tag into the text. The tag picks travel with the send as a trailing block
// (mentionmodel.ts), so the agent typed to messages the tagged one.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import {
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type KeyboardEvent,
    type ReactNode,
    type RefObject,
    type SetStateAction,
} from "react";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import { cockpitRosterAtom } from "./devmock";
import {
    appendMentions,
    insertMention,
    mentionRows,
    mentionTargets,
    mentionToken,
    type MentionRow,
} from "./mentionmodel";

const STATE_TEXT: Record<AgentVM["state"], string> = {
    working: "text-working",
    asking: "text-asking",
    idle: "text-muted",
};
const STATE_DOT: Record<AgentVM["state"], string> = {
    working: "bg-working",
    asking: "bg-asking",
    idle: "border-[1.5px] border-muted",
};

function Key({ children }: { children: ReactNode }) {
    return (
        <span className="rounded-[5px] border border-edge-mid px-1.5 font-mono text-[10.5px] text-muted">
            {children}
        </span>
    );
}

function MentionPicker({
    agent,
    rows,
    active,
    onHover,
    onPick,
}: {
    agent: AgentVM;
    rows: MentionRow[];
    active: number;
    onHover: (i: number) => void;
    onPick: (row: MentionRow) => void;
}) {
    const activeRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: "nearest" });
    }, [active]);
    return (
        <div
            data-mention-picker
            className="absolute inset-x-0 bottom-[calc(100%+8px)] z-10 flex flex-col rounded-lg border border-edge-mid bg-surface-raised p-1.5 shadow-popover-md"
        >
            <div className="px-2 pb-1.5 pt-1 text-[11.5px] text-muted">Live agents in {projectOf(agent)}</div>
            <div
                role="listbox"
                aria-label="Agents to tag"
                className="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto"
            >
                {rows.map((row, i) => (
                    <div
                        key={row.tabId}
                        ref={i === active ? activeRef : undefined}
                        role="option"
                        aria-selected={i === active}
                        data-mention-row={row.tag}
                        // mousedown, so the textarea keeps its focus and caret
                        onMouseDown={(e) => {
                            e.preventDefault();
                            onPick(row);
                        }}
                        onMouseEnter={() => onHover(i)}
                        className={cn(
                            "flex h-[34px] shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-2",
                            i === active && "bg-surface-selected"
                        )}
                    >
                        <span
                            aria-hidden
                            className={cn("h-[7px] w-[7px] shrink-0 rounded-full", STATE_DOT[row.state])}
                        />
                        <span className="shrink-0 font-mono text-[12.5px] text-primary">{row.tag}</span>
                        <span className={cn("shrink-0 text-[12px]", STATE_TEXT[row.state])}>{row.state}</span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-mid">{row.title}</span>
                        <span className="shrink-0 font-mono text-[10.5px] text-muted">
                            {row.harness} · {row.id8}
                        </span>
                    </div>
                ))}
            </div>
            <div className="mt-1 flex items-center gap-2.5 border-t border-edge-faint px-2 pb-0.5 pt-2 text-[11.5px] text-muted">
                <span className="min-w-0 flex-1 truncate">{agent.name} messages the agent you tag</span>
                <span className="inline-flex items-center gap-1">
                    <Key>↑↓</Key> choose
                </span>
                <span className="inline-flex items-center gap-1">
                    <Key>Tab</Key>
                    <Key>⏎</Key> tag
                </span>
                <span className="inline-flex items-center gap-1">
                    <Key>Esc</Key> close
                </span>
            </div>
        </div>
    );
}

export interface UseMentions {
    picker: ReactNode;
    // true when the picker took the key, so the composer must not also act on it
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
    trackCaret: (el: HTMLTextAreaElement) => void;
    compose: (text: string) => string;
    clear: () => void;
}

export function useMentions(
    agent: AgentVM,
    text: string,
    setText: Dispatch<SetStateAction<string>>,
    taRef: RefObject<HTMLTextAreaElement>
): UseMentions {
    const roster = useAtomValue(cockpitRosterAtom);
    const [caret, setCaret] = useState(0);
    const [active, setActive] = useState(0);
    // the @ whose picker Escape closed: it stays closed while that token is typed
    const [dismissed, setDismissed] = useState<number | null>(null);
    const [picks, setPicks] = useState<MentionRow[]>([]);
    const pendingCaret = useRef<number | null>(null);
    const token = mentionToken(text, caret);
    const start = token?.start;
    const query = token?.query;
    const rows = useMemo(
        () => (query == null ? [] : mentionRows(mentionTargets(roster, agent), query)),
        [roster, agent, query]
    );
    const open = token != null && start !== dismissed && rows.length > 0;
    const activeRow = Math.min(active, rows.length - 1);
    useEffect(() => {
        setActive(0);
        if (start == null) {
            setDismissed(null);
        }
    }, [start, query]);
    useLayoutEffect(() => {
        const el = taRef.current;
        if (pendingCaret.current == null || !el) {
            return;
        }
        el.setSelectionRange(pendingCaret.current, pendingCaret.current);
        setCaret(pendingCaret.current);
        pendingCaret.current = null;
    }, [text]);
    const pick = (row: MentionRow) => {
        const out = insertMention(text, token!, caret, row.tag);
        pendingCaret.current = out.caret;
        setText(out.text);
        setPicks((cur) => [...cur, row]);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!open) {
            return false;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((activeRow + step + rows.length) % rows.length);
        } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
            pick(rows[activeRow]);
        } else if (e.key === "Escape") {
            setDismissed(start);
        } else {
            return false;
        }
        e.preventDefault();
        e.stopPropagation();
        return true;
    };
    return {
        picker: open ? (
            <MentionPicker agent={agent} rows={rows} active={activeRow} onHover={setActive} onPick={pick} />
        ) : null,
        onKeyDown,
        trackCaret: (el) => setCaret(el.selectionStart),
        compose: (t) => appendMentions(t, picks),
        clear: () => setPicks([]),
    };
}
