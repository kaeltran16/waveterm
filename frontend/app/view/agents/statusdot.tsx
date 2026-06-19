// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { motion } from "motion/react";
import type { AgentState } from "./agentsviewmodel";

// Single source of truth for the in-view dot. Colors mirror the sidebar STATUS_COLOR map (Wave @theme tokens).
const COLOR: Record<AgentState, string> = {
    asking: "var(--color-warning)",
    working: "var(--color-accent)",
    idle: "var(--color-muted)",
};

export function StatusDot({ state, quiet, className }: { state: AgentState; quiet?: boolean; className?: string }) {
    const hollow = state === "working" && quiet;
    return (
        <motion.span
            className={cn("h-2 w-2 shrink-0 rounded-full", hollow ? "border border-muted bg-transparent" : "", className)}
            style={hollow ? undefined : { backgroundColor: COLOR[state] }}
            animate={
                state === "working" && !quiet
                    ? { scale: [1, 1.25, 1], opacity: [1, 0.7, 1] }
                    : state === "asking"
                      ? { opacity: [1, 0.5, 1] }
                      : { scale: 1, opacity: 1 }
            }
            transition={
                state === "idle" || hollow
                    ? { duration: 0 }
                    : { duration: state === "working" ? 1.6 : 1.2, repeat: Infinity, ease: "easeInOut" }
            }
        />
    );
}
