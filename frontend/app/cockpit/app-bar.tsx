// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { ProjectSwitcher } from "@/app/view/agents/projectswitcher";
import { SpaceSwitcher } from "@/app/view/agents/spaceswitcher";
import { formatChordString } from "@/util/keysym";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Handoff top app bar (46px). Replaces CockpitTitlebar + the old "+ New Agent" strip.
// Windows adaptation (spec D1): functional min/max/close on the right; no mac traffic-lights.
export function CockpitAppBar({ model }: { model: AgentsViewModel }) {
    const win = getCurrentWindow();
    return (
        <div
            data-tauri-drag-region
            className="flex h-[46px] shrink-0 items-center gap-4 border-b border-border bg-surface pl-4"
        >
            <div className="flex items-center gap-[9px]">
                <div className="flex h-[19px] w-[19px] items-center justify-center rounded-[6px] bg-gradient-to-br from-accent-300 to-accent-500">
                    <div className="h-[7px] w-[7px] rounded-full bg-surface" />
                </div>
                <span className="text-[14.5px] font-bold tracking-[-0.01em] text-primary">Arc</span>
                <span className="text-[13px] text-ink-faint">/</span>
                <ProjectSwitcher model={model} variant="bar" />
                <span className="text-[13px] text-ink-faint">/</span>
                <SpaceSwitcher model={model} />
            </div>

            <div className="flex min-w-0 flex-1 justify-center">
                <button
                    type="button"
                    onClick={() => globalStore.set(model.paletteOpenAtom, true)}
                    className="flex w-[min(520px,42%)] cursor-text items-center gap-2.5 rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-[7px] text-muted hover:border-edge-strong hover:bg-surface-hover"
                >
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <circle cx="5.5" cy="5.5" r="4" />
                        <path d="M9 9l3 3" strokeLinecap="round" />
                    </svg>
                    <span className="flex-1 text-left text-[13px]">Search agents, sessions, commands…</span>
                    <span className="rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px]">
                        {formatChordString("Ctrl:p")}
                    </span>
                </button>
            </div>

            <div className="flex h-full shrink-0 items-center gap-2.5">
                <button
                    type="button"
                    onClick={() => globalStore.set(model.newAgentOpenAtom, true)}
                    className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] bg-accent px-[clamp(9px,1.3vw,12px)] py-[7px] text-[clamp(11px,1.35vw,12.5px)] font-semibold text-background hover:bg-accenthover"
                >
                    <span className="-mt-px text-[15px] leading-none">+</span>New agent
                </button>

                <div className="flex h-full shrink-0 items-center border-l border-border">
                    <button
                        onClick={() => win.minimize()}
                        aria-label="Minimize"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-hover"
                    >
                        &#x2013;
                    </button>
                    <button
                        onClick={() => win.toggleMaximize()}
                        aria-label="Maximize"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-hover"
                    >
                        &#x25A1;
                    </button>
                    <button
                        onClick={() => win.close()}
                        aria-label="Close"
                        className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-error hover:text-white"
                    >
                        &#x2715;
                    </button>
                </div>
            </div>
        </div>
    );
}
