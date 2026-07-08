// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Renders the modalsModel stack (pushModal/popModal). The Electron-era host was dropped in the
// Phase 5b frontend teardown, leaving ConfirmModal/UserInputModal/MessageModal pushed into an atom
// that nothing read — so confirm dialogs (e.g. the Agent header's Close terminal) never appeared.
// Mounted once in CockpitBody.

import { AgentToolDetailModal } from "@/app/view/agents/tooldetailmodal";
import { modalsModel } from "@/app/store/modalmodel";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig } from "motion/react";
import type { ComponentType } from "react";
import { ConfirmModal } from "./confirmmodal";
import { MessageModal } from "./messagemodal";
import { UserInputModal } from "./userinputmodal";

const REGISTRY: Record<string, ComponentType<any>> = {
    ConfirmModal,
    MessageModal,
    UserInputModal,
    AgentToolDetailModal,
};

export function ModalsRenderer() {
    const modals = useAtomValue(modalsModel.modalsAtom);
    return (
        <MotionConfig reducedMotion="user">
            <AnimatePresence initial={false}>
                {modals.map((m, i) => {
                    const Comp = REGISTRY[m.displayName];
                    return Comp ? <Comp key={`${m.displayName}-${i}`} {...m.props} /> : null;
                })}
            </AnimatePresence>
        </MotionConfig>
    );
}
