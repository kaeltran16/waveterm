// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// the Rendered box's `@` file picker and its pills. An `@` word lists the agent's files (the Code surface's cached
// index, ranked by its finder) in the suggestion panel, and a pick writes `@<path> ` into the text. The box stays a
// textarea: a mirror behind it draws the same text with every mention token as a pill, and the textarea's own text
// goes transparent while the mirror shows. filementionmodel.ts holds the rules.

import { rankPaths } from "@/app/view/code/codefinder";
import { loadFileIndex } from "@/app/view/code/codestore";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
    type RefObject,
} from "react";
import { resolveCwd } from "./agentcwdresolve";
import { ComposerSuggest } from "./composersuggest";
import { stillDismissed, suggestKey } from "./composersuggestmodel";
import { backspaceMention, insertMention, mentionQueryAt, mentionTokens } from "./filementionmodel";

const MENTION_LIMIT = 50;
const NOTE_LOADING = "Loading files";
const NOTE_NO_CWD = "No working folder known for this agent";
const FOOTER_TRUNCATED = "Not every file is listed: the folder is too large";

// the files of one folder while the picker reads them: nothing yet (loading), its paths, or the error
type Listing = { cwd: string; paths?: string[]; truncated?: boolean; error?: string };

export interface FileMention {
    panel: ReactNode;
    open: boolean;
    // true when it handled the key; the box's own keys run only when it did not
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
    onCaret: () => void;
    // the pill mirror, for a `relative` wrapper that holds it and then the textarea; null while the text has no mention
    backdrop: ReactNode;
}

// the mirror wraps where the textarea does only with the same padding and the textarea's scrollbar taken off its width
function syncMirror(ta: HTMLTextAreaElement, mirror: HTMLDivElement) {
    const cs = getComputedStyle(ta);
    mirror.style.paddingTop = cs.paddingTop;
    mirror.style.paddingBottom = cs.paddingBottom;
    mirror.style.paddingLeft = cs.paddingLeft;
    mirror.style.paddingRight = `calc(${cs.paddingRight} + ${ta.offsetWidth - ta.clientWidth}px)`;
    mirror.scrollTop = ta.scrollTop;
}

function FileRow({ path }: { path: string }) {
    const slash = path.lastIndexOf("/");
    return (
        <>
            <span className="shrink-0 font-mono">{path.slice(slash + 1)}</span>
            {slash > 0 ? (
                <span className="min-w-0 truncate text-[11.5px] text-muted">{path.slice(0, slash)}</span>
            ) : null}
        </>
    );
}

// cwd: the agent's folder, null when none is known, undefined while it is still being resolved. off (bash mode)
// turns the panel and the pills off.
export function useFileMention({
    text,
    setText,
    taRef,
    cwd,
    off,
}: {
    text: string;
    setText: (text: string) => void;
    taRef: RefObject<HTMLTextAreaElement>;
    cwd: string | null | undefined;
    off?: boolean;
}): FileMention {
    const [caret, setCaret] = useState(0);
    const [at, setAt] = useState(0);
    // the start of the `@` word whose panel Esc closed
    const [dismissedAt, setDismissedAt] = useState<number | null>(null);
    const [listing, setListing] = useState<Listing | null>(null);
    // where a programmatic edit (a pick, a pill's Backspace) puts the caret once the new text is in the textarea
    const pendingCaret = useRef<number | null>(null);
    const mirrorRef = useRef<HTMLDivElement>(null);

    const mention = off ? null : mentionQueryAt(text, caret);
    const wordAt = mention?.start ?? null;
    const active = mention != null && !stillDismissed(dismissedAt, wordAt);
    const listed = cwd != null && listing?.cwd === cwd ? listing : null;

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

    useEffect(() => setAt(0), [wordAt, mention?.query]);

    useEffect(() => {
        if (!active) {
            // a failed read is tried again on the next `@`
            if (listing?.error != null) {
                setListing(null);
            }
            return;
        }
        if (cwd == null || listing?.cwd === cwd) {
            return;
        }
        setListing({ cwd });
        loadFileIndex(cwd).then(
            (idx) =>
                setListing((cur) => (cur?.cwd === cwd ? { cwd, paths: idx.paths, truncated: idx.truncated } : cur)),
            (e) =>
                setListing((cur) =>
                    cur?.cwd === cwd ? { cwd, error: e instanceof Error ? e.message : String(e) } : cur
                )
        );
    }, [active, cwd, listing]);

    const items =
        active && listed?.paths ? rankPaths(mention.query, listed.paths, MENTION_LIMIT).map((m) => m.path) : [];
    let note: string | undefined;
    if (cwd === null) {
        note = NOTE_NO_CWD;
    } else if (listed?.error != null) {
        note = `Could not list files: ${listed.error}`;
    } else if (listed?.paths == null) {
        note = NOTE_LOADING;
    }
    // a query no file matches shows no panel, so Enter sends as before
    const open = active && (items.length > 0 || note != null);
    const hi = Math.min(at, Math.max(items.length - 1, 0));

    const edit = (next: { text: string; caret: number }) => {
        pendingCaret.current = next.caret;
        setText(next.text);
    };
    const pick = (i: number) => {
        if (mention == null || items[i] == null) {
            return;
        }
        edit(insertMention(text, mention.start, caret, items[i]));
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (open) {
            // a note-only panel has no rows for suggestKey, and its Esc must still close it rather than interrupt
            if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(wordAt);
                return true;
            }
            const r = suggestKey(
                { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
                hi,
                items.length
            );
            if (r != null) {
                e.preventDefault();
                if ("move" in r) {
                    setAt(r.move);
                } else if ("pick" in r) {
                    pick(r.pick);
                } else {
                    setDismissedAt(wordAt);
                }
                return true;
            }
        }
        const ta = taRef.current;
        if (off || e.key !== "Backspace" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || ta == null) {
            return false;
        }
        if (ta.selectionStart !== ta.selectionEnd) {
            return false;
        }
        const next = backspaceMention(text, ta.selectionStart);
        if (next == null) {
            return false;
        }
        e.preventDefault();
        edit(next);
        return true;
    };

    const onCaret = () => {
        const ta = taRef.current;
        if (ta != null) {
            setCaret(ta.selectionStart);
        }
    };

    const tokens = off ? [] : mentionTokens(text);
    const mirrored = tokens.length > 0;
    useLayoutEffect(() => {
        const ta = taRef.current;
        const mirror = mirrorRef.current;
        if (!mirrored || ta == null || mirror == null) {
            return;
        }
        syncMirror(ta, mirror);
        const onScroll = () => syncMirror(ta, mirror);
        ta.addEventListener("scroll", onScroll);
        return () => ta.removeEventListener("scroll", onScroll);
    });

    let backdrop: ReactNode = null;
    if (mirrored) {
        const parts: ReactNode[] = [];
        let from = 0;
        for (const t of tokens) {
            parts.push(text.slice(from, t.start));
            parts.push(
                <span
                    key={t.start}
                    data-mention-pill
                    className="rounded-[3px] bg-accent/15 text-accent ring-2 ring-accent/15"
                >
                    {text.slice(t.start, t.end)}
                </span>
            );
            from = t.end;
        }
        parts.push(text.slice(from));
        backdrop = (
            <div
                ref={mirrorRef}
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words"
            >
                {parts}
                {/* a trailing newline gets its line in a textarea, and collapses in a div without something after it */}
                {"​"}
            </div>
        );
    }

    const panel = (
        <ComposerSuggest
            open={open}
            items={items}
            at={hi}
            itemKey={(p) => p}
            renderItem={(p) => <FileRow path={p} />}
            onPick={pick}
            onHover={setAt}
            note={note}
            footer={listed?.truncated && items.length > 0 ? FOOTER_TRUNCATED : undefined}
            label="Files"
            dataAttr="data-mention-panel"
        />
    );
    return { panel, open, onKeyDown, onCaret, backdrop };
}

// the textarea's look while the mirror draws its text: its own text hidden, its caret kept
export const MIRRORED_TEXTAREA = "text-transparent caret-foreground";

// the agent's folder for the picker: undefined while it resolves, null when none is known
export function useAgentCwd(
    transcriptPath: string | undefined,
    blockId: string | undefined
): string | null | undefined {
    const [cwd, setCwd] = useState<string | null | undefined>(undefined);
    useEffect(() => {
        let live = true;
        setCwd(undefined);
        // resolveCwd answers null on a failed read rather than throwing
        void resolveCwd(transcriptPath, blockId).then((c) => {
            if (live) setCwd(c);
        });
        return () => {
            live = false;
        };
    }, [transcriptPath, blockId]);
    return cwd;
}
