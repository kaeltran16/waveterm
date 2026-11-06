// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Setup surface: the instructions, skills and memory every harness reads. This is the shell (tabs,
// toolbar, panel); each tab lives in its own file: setupinstructions.tsx, setupskills.tsx, setupmemory.tsx.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion, MotionConfig } from "motion/react";
import { useEffect, type KeyboardEvent } from "react";
import type { AgentsViewModel } from "./agents";
import { InstructionsHeader, InstructionsTab } from "./setupinstructions";
import { MemoryHeader, MemoryTab } from "./setupmemory";
import { FADE_IN } from "./setupparts";
import { SkillsHeader, SkillsTab } from "./setupskills";
import { loadSetup, setupTabAtom, type SetupTab } from "./setupstore";
import { SurfaceToolbar } from "./surfacescaffold";

const TABS: { key: SetupTab; label: string }[] = [
    { key: "instructions", label: "Instructions" },
    { key: "skills", label: "Skills" },
    { key: "memory", label: "Memory" },
];

function Tabs() {
    const tab = useAtomValue(setupTabAtom);
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
            return;
        }
        e.preventDefault();
        const i = TABS.findIndex((t) => t.key === tab);
        const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
        globalStore.set(setupTabAtom, next.key);
        document.getElementById(`setup-tab-${next.key}`)?.focus();
    };
    return (
        <div
            role="tablist"
            aria-label="Setup"
            onKeyDown={onKey}
            className="flex gap-0.5 rounded border border-border bg-surface p-[3px]"
        >
            {TABS.map((t) => (
                <button
                    key={t.key}
                    id={`setup-tab-${t.key}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    aria-controls="setup-tabpanel"
                    tabIndex={tab === t.key ? 0 : -1}
                    onClick={() => globalStore.set(setupTabAtom, t.key)}
                    className={cn(
                        "cursor-pointer rounded-md border-0 px-3 py-[5px] text-[13px]",
                        tab === t.key
                            ? "bg-surface-selected font-semibold text-primary"
                            : "bg-transparent font-medium text-ink-mid hover:text-primary"
                    )}
                >
                    {t.label}
                </button>
            ))}
        </div>
    );
}

export function SetupSurface({ model }: { model: AgentsViewModel }) {
    const tab = useAtomValue(setupTabAtom);
    // re-read on every visit: a harness file edited outside Arc must not show stale
    useEffect(() => {
        fireAndForget(loadSetup);
    }, []);
    return (
        <MotionConfig reducedMotion="user">
            <div className="flex h-full min-h-0 flex-col bg-background">
                <SurfaceToolbar
                    title="Setup"
                    actions={
                        tab === "instructions" ? (
                            <InstructionsHeader />
                        ) : tab === "skills" ? (
                            <SkillsHeader />
                        ) : (
                            <MemoryHeader />
                        )
                    }
                >
                    <Tabs />
                </SurfaceToolbar>
                <motion.div
                    key={tab}
                    {...FADE_IN}
                    id="setup-tabpanel"
                    role="tabpanel"
                    aria-labelledby={`setup-tab-${tab}`}
                    className="flex min-h-0 flex-1"
                >
                    {tab === "instructions" ? (
                        <InstructionsTab />
                    ) : tab === "skills" ? (
                        <SkillsTab model={model} />
                    ) : (
                        <MemoryTab />
                    )}
                </motion.div>
            </div>
        </MotionConfig>
    );
}
