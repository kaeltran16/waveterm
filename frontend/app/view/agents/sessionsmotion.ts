// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Chips animate the filter reflow; search-as-you-type updates instantly. This maps that
// decision to the Framer props each session row spreads. See
// docs/superpowers/specs/2026-07-03-sessions-motion-design.md.
import { MOTION } from "@/app/element/motiontokens";
import type { Transition } from "motion/react";

export interface ReflowProps {
    initial: string | false;
    exit: string | undefined;
    transition: Transition;
}

export function reflowProps(animated: boolean): ReflowProps {
    if (animated) {
        return {
            initial: "initial",
            exit: "exit",
            transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid },
        };
    }
    // search: no enter, no exit (popLayout drops the row), zero-duration layout snap.
    return { initial: false, exit: undefined, transition: { duration: 0 } };
}
