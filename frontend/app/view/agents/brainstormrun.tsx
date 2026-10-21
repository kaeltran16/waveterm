// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The brainstorm's Run step: the design handed over and the run it started.

import { openTarget } from "@/app/view/jarvis/openref";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormFile } from "./brainstormmodel";
import type { BrainstormState } from "./brainstormstore";
import { DesignHead, StaleBanner, Toolbar } from "./brainstormui";
import { CANVAS_BTN } from "./canvaspane";

const RUN_ID_CHARS = 8;

export function RunStep({
    model,
    s,
    f,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile;
}) {
    const runId = f.run!;
    return (
        <>
            <Toolbar topic={s.topic} f={f} progress={false} />
            <StaleBanner s={s} />
            <div className="min-h-0 flex-1 overflow-y-auto bg-background px-[22px] pb-[40px] pt-[20px]">
                <DesignHead f={f} />
            </div>
            <div
                data-brainstorm-approve-bar
                className="flex flex-none items-center gap-[14px] border-t border-border bg-surface px-[22px] py-[12px]"
            >
                <span className="flex-1 text-[13px] font-semibold text-primary">
                    Run {runId.slice(0, RUN_ID_CHARS)} started
                </span>
                <button
                    type="button"
                    onClick={() => void openTarget(model, { kind: "run", runId })}
                    className={CANVAS_BTN}
                >
                    Open run
                </button>
            </div>
        </>
    );
}
