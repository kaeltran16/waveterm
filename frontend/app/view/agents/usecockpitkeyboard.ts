// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit surface's keyboard dispatch (cursor nav, answer selection, surface switch, triage keys).
// These keys are cockpit-local — handled here, not by the global keybinding registry. Extracted from
// cockpitsurface.tsx as a hook taking a single deps object.

import { globalStore } from "@/app/store/jotaiStore";
import { peekTarget } from "@/app/view/jarvis/openref";
import { type KeyboardEvent, type MutableRefObject } from "react";
import type { AgentsViewModel } from "./agents";
import { answerDigitTarget, hasAnswerableAsk, moveCursor, nextAskId, type AgentVM } from "./agentsviewmodel";
import { enterAction, pickAdvance } from "./askflow";
import { askerAt, columnJump, type RowTarget } from "./cardgridlayout";
import { isRowKey, rowCardId } from "./leadcardmodel";

export type CockpitKeyDeps = {
    model: AgentsViewModel;
    navigableIds: string[];
    cursorId: string | undefined;
    setCursorId: (v: (string | undefined) | ((p: string | undefined) => string | undefined)) => void;
    answerTab: Record<string, number>;
    answerSel: Record<string, Record<number, Set<number>>>;
    navCols: string[][];
    rowTargets: Record<string, RowTarget>;
    askTargets: string[];
    roster: AgentVM[];
    lastJumpRef: MutableRefObject<string | undefined>;
    setOpenComposerId: (v: string | undefined) => void;
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
        navigableIds,
        cursorId,
        setCursorId,
        answerTab,
        navCols,
        rowTargets,
        askTargets,
        roster,
        lastJumpRef,
        setOpenComposerId,
        selectQuestion,
        toggleAnswer,
        submitAnswer,
        toggleBackground,
        openFocus,
        scrollToPulse,
        focusRowComposer,
    } = deps;

    // the atoms, not the render's snapshot: a digit's toggle has just written them
    const answersOf = (id: string) => ({
        sel: globalStore.get(model.answerSelAtom)[id] ?? {},
        txt: globalStore.get(model.answerTextAtom)[id] ?? {},
    });
    // a digit picks an option, then moves on as a click does, but never submits: Enter stays the confirm step
    const pickDigit = (asker: AgentVM, qi: number, oi: number) => {
        toggleAnswer(asker.id, qi, oi);
        const { sel, txt } = answersOf(asker.id);
        const next = pickAdvance(asker.ask?.questions ?? [], sel, txt, qi);
        if (next != null) {
            selectQuestion(asker.id, next);
        }
    };
    const enterAsk = (asker: AgentVM) => {
        const { sel, txt } = answersOf(asker.id);
        const action = enterAction(asker.ask?.questions ?? [], sel, txt, answerTab[asker.id] ?? 0);
        if ("qi" in action) {
            selectQuestion(asker.id, action.qi);
        } else {
            submitAnswer(asker.id);
        }
    };

    return (e: KeyboardEvent) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) {
            return; // typing — let the input own its keys
        }
        // surface switch (`[`/`]`) now lives in the global keybinding registry (bindings.ts), so it
        // fires from every surface, not just the cockpit — see docs Pass A (F1/F2).
        // a run card can hold a lead the live list parked, so look the card up in the whole roster
        const cur = roster.find((a) => a.id === cursorId);
        const row = cursorId != null && isRowKey(cursorId) ? rowTargets[cursorId] : undefined;
        if (row && (/^[1-9]$/.test(e.key) || e.key === "Enter" || e.key === "t")) {
            e.preventDefault();
            // a worker is not a grid card, so look it up in the whole roster
            const asker = askerAt(cursorId, roster, rowTargets);
            if (/^[1-9]$/.test(e.key)) {
                const d = parseInt(e.key, 10);
                const target = asker ? answerDigitTarget(asker, answerTab[asker.id] ?? 0, d) : null;
                if (asker && target) {
                    pickDigit(asker, target.qi, target.oi);
                } else {
                    row.actions[d - 1]?.();
                }
            } else if (e.key === "Enter") {
                if (asker?.state === "asking" && hasAnswerableAsk(asker)) {
                    enterAsk(asker);
                } else if (row.openId) {
                    openFocus(row.openId, false);
                }
            } else if (row.openId) {
                model.openTerminal(row.openId);
            }
            return;
        }
        if (e.key === "ArrowDown" || e.key === "j") {
            e.preventDefault();
            setCursorId((c) => moveCursor(navigableIds, c, 1));
        } else if (e.key === "ArrowUp" || e.key === "k") {
            e.preventDefault();
            setCursorId((c) => moveCursor(navigableIds, c, -1));
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "h" || e.key === "l") {
            const back = e.key === "ArrowLeft" || e.key === "h";
            // a question with several parts keeps h/l for its tabs, on its own card or on its worker's task row
            const asker = askerAt(cursorId, roster, rowTargets);
            const n = asker?.ask?.questions?.length ?? 0;
            if (asker?.state === "asking" && n > 1) {
                e.preventDefault();
                const curTab = Math.min(answerTab[asker.id] ?? 0, n - 1);
                selectQuestion(asker.id, Math.max(0, Math.min(n - 1, curTab + (back ? -1 : 1))));
                return;
            }
            const target = columnJump(navCols, rowCardId, cursorId, back ? -1 : 1);
            if (target) {
                e.preventDefault();
                setCursorId(target);
            }
        } else if (e.key === "n") {
            e.preventDefault();
            const target = nextAskId(askTargets, lastJumpRef.current);
            if (target) {
                lastJumpRef.current = target;
                setCursorId(target);
                scrollToPulse(target);
            }
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (!cur) return;
            if (cur.state === "asking" && hasAnswerableAsk(cur)) {
                enterAsk(cur);
            } else {
                openFocus(cur.id, false);
            }
        } else if (e.key === " ") {
            if (cur) {
                e.preventDefault();
                void peekTarget(model, { kind: "agent", tabId: cur.id });
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
        } else if (/^[1-9]$/.test(e.key)) {
            if (cur) {
                const target = answerDigitTarget(cur, answerTab[cur.id] ?? 0, parseInt(e.key, 10));
                if (target) {
                    e.preventDefault();
                    pickDigit(cur, target.qi, target.oi);
                }
            }
        }
    };
}
