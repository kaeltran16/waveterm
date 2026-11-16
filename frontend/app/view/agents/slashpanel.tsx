// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// the Rendered box's `/` command panel. A leading `/` lists the session's commands (the list the arc mod publishes
// for the block, read again on each open, or the built-ins when none is published), grouped and filtered as you type;
// a pick writes `/name ` into the text. slashpanelmodel.ts holds the rules.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
    type RefObject,
} from "react";
import { ComposerSuggest } from "./composersuggest";
import { stillDismissed, suggestKey } from "./composersuggestmodel";
import { isPickerCommand } from "./renderedmode";
import {
    BUILTIN_COMMANDS,
    fromLive,
    insertSlash,
    slashGroups,
    slashMatches,
    slashQueryAt,
    type SlashCommand,
} from "./slashpanelmodel";

// the command word always starts the text
const WORD_START = 0;
const FOOTER_BUILTINS = "Built-in commands only: this session has not published its list";

// the live list last read for a block; empty means it published none. error: the read failed
type Known = { blockId: string; commands: SlashCommand[]; error?: string };

export interface SlashPanel {
    panel: ReactNode;
    open: boolean;
    // true when it handled the key; the box's own keys run only when it did not
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
    onCaret: () => void;
}

function CommandRow({ c }: { c: SlashCommand }) {
    return (
        <>
            <span data-slash-name className="shrink-0 font-mono">
                /{c.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{c.description}</span>
            {c.plugin ? (
                <span className="shrink-0 rounded-[3px] border border-edge-mid px-1.5 text-[10.5px] text-muted">
                    {c.plugin}
                </span>
            ) : null}
            {isPickerCommand(`/${c.name}`) ? (
                <span
                    data-opens-terminal
                    title="Opens a menu on Claude Code's own screen"
                    className="shrink-0 text-[10.5px] text-muted"
                >
                    opens in Terminal
                </span>
            ) : null}
        </>
    );
}

function footerOf(known: Known | null): string | undefined {
    if (known?.error != null) {
        return `Could not read this session's commands (${known.error}); built-ins only`;
    }
    if (known == null || known.commands.length === 0) {
        return FOOTER_BUILTINS;
    }
    const n = known.commands.length;
    return `${n} ${n === 1 ? "command" : "commands"} in this session`;
}

// off (bash mode) turns the panel off
export function useSlashPanel({
    text,
    setText,
    taRef,
    blockId,
    off,
}: {
    text: string;
    setText: (text: string) => void;
    taRef: RefObject<HTMLTextAreaElement>;
    blockId: string | undefined;
    off?: boolean;
}): SlashPanel {
    const [caret, setCaret] = useState(0);
    const [at, setAt] = useState(0);
    // the word start when Esc closed the panel
    const [dismissedAt, setDismissedAt] = useState<number | null>(null);
    const [known, setKnown] = useState<Known | null>(null);
    // where a pick puts the caret once the new text is in the textarea
    const pendingCaret = useRef<number | null>(null);

    const query = off ? null : slashQueryAt(text, caret);
    const wordAt = query != null ? WORD_START : null;
    const active = query != null && !stillDismissed(dismissedAt, wordAt);
    const live = blockId != null && known?.blockId === blockId ? known : null;

    useLayoutEffect(() => {
        const ta = taRef.current;
        if (ta == null) {
            return;
        }
        if (pendingCaret.current != null) {
            ta.setSelectionRange(pendingCaret.current, pendingCaret.current);
            pendingCaret.current = null;
        }
        setCaret(ta.selectionStart);
    }, [text]);

    useEffect(() => {
        if (dismissedAt != null && wordAt !== dismissedAt) {
            setDismissedAt(null);
        }
    }, [wordAt, dismissedAt]);

    useEffect(() => setAt(0), [query]);

    // read on each open, so a skill or MCP server added mid-session shows on the next `/`; the last list stays
    // listed meanwhile
    useEffect(() => {
        if (!active || blockId == null) {
            return;
        }
        RpcApi.GetClaudeLiveCommandsCommand(TabRpcClient, { blockid: blockId }).then(
            (list) => setKnown({ blockId, commands: fromLive(list ?? []) }),
            (e) => setKnown({ blockId, commands: [], error: e instanceof Error ? e.message : String(e) })
        );
    }, [active, blockId]);

    const all = live != null && live.commands.length > 0 ? live.commands : BUILTIN_COMMANDS;
    const groups = active ? slashGroups(slashMatches(query, all)) : [];
    const items = groups.flatMap((g) => g.items);
    let start = 0;
    const starts = groups.map((g) => {
        const header = { title: g.title, start };
        start += g.items.length;
        return header;
    });
    // a query no command matches shows no panel, so Enter sends as before
    const open = items.length > 0;
    const hi = Math.min(at, Math.max(items.length - 1, 0));

    const pick = (i: number) => {
        if (items[i] == null) {
            return;
        }
        const next = insertSlash(text, caret, items[i].name);
        pendingCaret.current = next.caret;
        setText(next.text);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!open) {
            return false;
        }
        const r = suggestKey(
            { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
            hi,
            items.length
        );
        if (r == null) {
            return false;
        }
        // Enter on a command already typed in full sends it; Tab still completes
        if ("pick" in r && e.key === "Enter" && items[r.pick].name === query) {
            return false;
        }
        e.preventDefault();
        if ("move" in r) {
            setAt(r.move);
        } else if ("pick" in r) {
            pick(r.pick);
        } else {
            setDismissedAt(wordAt);
        }
        return true;
    };

    const onCaret = () => {
        const ta = taRef.current;
        if (ta != null) {
            setCaret(ta.selectionStart);
        }
    };

    const panel = (
        <ComposerSuggest
            open={open}
            items={items}
            at={hi}
            groups={starts}
            itemKey={(c) => c.name}
            renderItem={(c) => <CommandRow c={c} />}
            onPick={pick}
            onHover={setAt}
            footer={footerOf(live)}
            label="Commands"
            dataAttr="data-slash-panel"
        />
    );
    return { panel, open, onKeyDown, onCaret };
}
