// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit surface's keyboard dispatch (cursor nav, answer selection, surface switch, triage keys).
// These keys are cockpit-local — handled here, not by the global keybinding registry. Extracted from
// cockpitsurface.tsx as a hook taking a single deps object.

import { type KeyboardEvent, type MutableRefObject } from "react";
import type { AgentsViewModel } from "./agents";
import { canSubmitAsk, hasAnswerableAsk, moveCursor, nextAskId, type AgentVM } from "./agentsviewmodel";

export type CockpitKeyDeps = {
    model: AgentsViewModel;
    orderedAgents: AgentVM[];
    navigableIds: string[];
    cursorId: string | undefined;
    setCursorId: (v: (string | undefined) | ((p: string | undefined) => string | undefined)) => void;
    answerTab: Record<string, number>;
    answerSel: Record<string, Record<number, Set<number>>>;
    asking: AgentVM[];
    lastJumpRef: MutableRefObject<string | undefined>;
    setOpenComposerId: (v: string | undefined) => void;
    showHelp: boolean;
    setShowHelp: (v: boolean | ((p: boolean) => boolean)) => void;
    selectQuestion: (id: string, qi: number) => void;
    toggleAnswer: (id: string, qi: number, oi: number) => void;
    submitAnswer: (id: string) => void;
    toggleBackground: (id: string) => void;
    openFocus: (id: string, reply: boolean) => void;
    scrollToPulse: (id: string) => void;
    focusRowComposer: (id: string) => void;
};

export function useCockpitKeyboard(deps: CockpitKeyDeps): (e: KeyboardEvent) => void {
    const {
        model,
        orderedAgents,
        navigableIds,
        cursorId,
        setCursorId,
        answerTab,
        answerSel,
        asking,
        lastJumpRef,
        setOpenComposerId,
        showHelp,
        setShowHelp,
        selectQuestion,
        toggleAnswer,
        submitAnswer,
        toggleBackground,
        openFocus,
        scrollToPulse,
        focusRowComposer,
    } = deps;

    return (e: KeyboardEvent) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) {
            return; // typing — let the input own its keys
        }
        // surface switch (`[`/`]`) now lives in the global keybinding registry (bindings.ts), so it
        // fires from every surface, not just the cockpit — see docs Pass A (F1/F2).
        const cur = orderedAgents.find((a) => a.id === cursorId);
        if (e.key === "ArrowDown" || e.key === "j") {
            e.preventDefault();
            setCursorId((c) => moveCursor(navigableIds, c, 1));
        } else if (e.key === "ArrowUp" || e.key === "k") {
            e.preventDefault();
            setCursorId((c) => moveCursor(navigableIds, c, -1));
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "h" || e.key === "l") {
            const n = cur?.ask?.questions?.length ?? 0;
            if (cur?.state !== "asking" || n <= 1) {
                return;
            }
            e.preventDefault();
            const delta = e.key === "ArrowLeft" || e.key === "h" ? -1 : 1;
            const curTab = Math.min(answerTab[cur.id] ?? 0, n - 1);
            selectQuestion(cur.id, Math.max(0, Math.min(n - 1, curTab + delta)));
        } else if (e.key === "n") {
            e.preventDefault();
            const target = nextAskId(
                asking.map((a) => a.id),
                lastJumpRef.current
            );
            if (target) {
                lastJumpRef.current = target;
                setCursorId(target);
                scrollToPulse(target);
            }
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (!cur) return;
            if (cur.state === "asking" && canSubmitAsk(cur.ask?.questions ?? [], answerSel[cur.id] ?? {})) {
                submitAnswer(cur.id);
            } else {
                openFocus(cur.id, false);
            }
        } else if (e.key === "r") {
            e.preventDefault();
            if (cur && !hasAnswerableAsk(cur)) {
                setOpenComposerId(cur.id);
                requestAnimationFrame(() => focusRowComposer(cur.id));
            }
        } else if (e.key === "t") {
            e.preventDefault();
            if (cur) {
                model.openTerminal(cur.id);
            }
        } else if (e.key === "b") {
            e.preventDefault();
            if (cur && cur.state !== "asking") {
                toggleBackground(cur.id);
            }
        } else if (e.key === "Escape") {
            if (showHelp) {
                e.preventDefault();
                setShowHelp(false);
            }
        } else if (e.key === "?") {
            e.preventDefault();
            setShowHelp((v) => !v);
        } else if (/^[1-9]$/.test(e.key)) {
            if (cur?.state === "asking") {
                const qi = Math.min(answerTab[cur.id] ?? 0, (cur.ask?.questions?.length ?? 1) - 1);
                const oi = parseInt(e.key, 10) - 1;
                const opts = cur.ask?.questions?.[qi]?.options ?? [];
                if (oi < opts.length) {
                    e.preventDefault();
                    toggleAnswer(cur.id, qi, oi);
                }
            }
        }
    };
}
