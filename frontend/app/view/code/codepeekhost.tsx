// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Hosts the Code peek in one terminal: present only where the Agent surface provides CodePeekContext,
// it attaches the terminal's file-link handler, shows the Ctrl hint, and pins the card to an xterm
// marker on the clicked line. The card is a sibling of xterm's DOM, not inside it, so xterm's cursor,
// selection and wheel handling never reach it.

import { globalStore } from "@/app/store/jotaiStore";
import { resolveCwd } from "@/app/view/agents/agentcwdresolve";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { LinkHint, TermTooltip } from "@/app/view/term/term-tooltip";
import type { FileLinkHit, TermWrap } from "@/app/view/term/termwrap";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CodePeekCard } from "./codepeekcard";
import { peekPlacement, peekRow } from "./codepeekmodel";
import { closePeek, codePeekAtom, togglePeek, type CodePeek } from "./codepeekstore";

export type CodePeekContextValue = { model: AgentsViewModel; transcriptPath?: string };

export const CodePeekContext = createContext<CodePeekContextValue | null>(null);

// the room between the line band and the card
const GAP_PX = 4;
const LEFT_INSET_CELLS = 4;
const RIGHT_INSET_PX = 24;

type Box = { top: number; left: number; width: number; height: number; side: "below" | "above"; visible: boolean };

function sameBox(a: Box | null, b: Box): boolean {
    return (
        a != null &&
        a.top === b.top &&
        a.left === b.left &&
        a.width === b.width &&
        a.height === b.height &&
        a.side === b.side &&
        a.visible === b.visible
    );
}

export function CodePeekHost({ termWrap, blockId }: { termWrap: TermWrap | null; blockId: string }) {
    const ctx = useContext(CodePeekContext);
    if (ctx == null || termWrap == null) {
        return null;
    }
    return <AttachedPeekHost ctx={ctx} termWrap={termWrap} blockId={blockId} />;
}

function AttachedPeekHost({
    ctx,
    termWrap,
    blockId,
}: {
    ctx: CodePeekContextValue;
    termWrap: TermWrap;
    blockId: string;
}) {
    // read at click time, so a context value that is a fresh object each render never re-attaches the handler
    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;
    const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
    const peek = useAtomValue(codePeekAtom);
    const own = peek?.blockId === blockId ? peek : null;

    useEffect(() => {
        termWrap.setFileLinkHandler({
            activate: ({ match, bufferLine }: FileLinkHit) =>
                fireAndForget(async () => {
                    const cwd = await resolveCwd(ctxRef.current.transcriptPath, blockId);
                    await togglePeek({
                        blockId,
                        bufferLine,
                        start: match.start,
                        raw: match.path,
                        line: match.line,
                        cwd,
                    });
                }),
            hint: setHint,
        });
        return () => {
            termWrap.setFileLinkHandler(null);
            setHint(null);
        };
    }, [termWrap, blockId]);

    return (
        <>
            {/* the hint is for opening a card; over an open one it would cover the card's header */}
            <TermTooltip
                mousePos={own == null ? hint : null}
                placement="bottom-start"
                content={
                    <span data-peek-hint>
                        <LinkHint verb="peek" />
                    </span>
                }
            />
            {own != null ? (
                <PeekAnchor
                    key={`${own.bufferLine}:${own.start}`}
                    peek={own}
                    termWrap={termWrap}
                    model={ctx.model}
                    blockId={blockId}
                />
            ) : null}
        </>
    );
}

function isAnchor(p: CodePeek | null, anchor: CodePeek): boolean {
    return p != null && p.blockId === anchor.blockId && p.bufferLine === anchor.bufferLine && p.start === anchor.start;
}

function PeekAnchor({
    peek,
    termWrap,
    model,
    blockId,
}: {
    peek: CodePeek;
    termWrap: TermWrap;
    model: AgentsViewModel;
    blockId: string;
}) {
    const [box, setBox] = useState<Box | null>(null);
    const peekRef = useRef(peek);
    peekRef.current = peek;

    useLayoutEffect(() => {
        const anchor = peekRef.current;
        const term = termWrap.terminal;
        const marker = termWrap.markLine(anchor.bufferLine);
        if (marker == null) {
            closePeek();
            return;
        }
        // false once this effect disposes the marker itself, so only a trim or clear closes the peek
        let live = true;
        marker.onDispose(() => {
            if (live && isAnchor(globalStore.get(codePeekAtom), anchor)) {
                closePeek();
            }
        });
        const band = term.registerDecoration({ marker, width: term.cols, layer: "top" });
        band?.onRender((el) => {
            el.setAttribute("data-peek-line", "");
            el.classList.add("bg-accentbg", "pointer-events-none");
        });

        // the side is chosen on open and on resize, never on scroll
        let placed: { side: "below" | "above"; height: number } | null = null;
        const place = (replace: boolean) => {
            const screen = term.element?.querySelector(".xterm-screen");
            const root = term.element?.closest("[data-term-view]");
            if (screen == null || root == null || marker.isDisposed) {
                return;
            }
            const s = screen.getBoundingClientRect();
            const r = root.getBoundingClientRect();
            const lineHeight = s.height / term.rows;
            const row = peekRow(marker.line, term.buffer.active.viewportY, term.rows);
            if (row == null) {
                setBox((prev) => (prev == null || !prev.visible ? prev : { ...prev, visible: false }));
                return;
            }
            const lineTop = row * lineHeight;
            if (replace || placed == null) {
                placed = peekPlacement({ lineTop, lineHeight, viewportHeight: s.height });
            }
            const height = Math.max(0, placed.height - GAP_PX);
            const lineTopInRoot = s.top - r.top + lineTop;
            const top = placed.side === "below" ? lineTopInRoot + lineHeight + GAP_PX : lineTopInRoot - GAP_PX - height;
            const left = s.left - r.left + LEFT_INSET_CELLS * (s.width / term.cols);
            const next: Box = {
                top,
                left,
                width: Math.max(0, r.width - RIGHT_INSET_PX - left),
                height,
                side: placed.side,
                visible: true,
            };
            setBox((prev) => (sameBox(prev, next) ? prev : next));
        };
        place(true);
        const subs = [
            term.onRender(() => place(false)),
            term.onScroll(() => place(false)),
            term.onResize(() => place(true)),
        ];

        return () => {
            live = false;
            subs.forEach((d) => d.dispose());
            band?.dispose();
            marker.dispose();
            const now = globalStore.get(codePeekAtom);
            if (isAnchor(now, anchor)) {
                // the host is going away while it owns the card
                closePeek();
            }
            if (now == null || isAnchor(now, anchor)) {
                // closed, not moved: a moved card takes focus itself
                const textarea = term.textarea;
                if (textarea?.checkVisibility()) {
                    term.focus();
                }
            }
        };
    }, [termWrap]);

    if (box == null) {
        return null;
    }
    return (
        <div
            className="absolute z-10"
            style={{
                top: box.top,
                left: box.left,
                width: box.width,
                height: box.height,
                visibility: box.visible ? "visible" : "hidden",
            }}
        >
            <CodePeekCard peek={peek} model={model} blockId={blockId} side={box.side} />
        </div>
    );
}
