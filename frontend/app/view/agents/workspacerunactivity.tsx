// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run tab's Activity view: every event of the run, newest first.

import { runLog } from "./runrail";
import { ActivityRow } from "./runrailsections";
import type { RunViewProps } from "./workspaceruntab";

export function ActivityView({ events }: RunViewProps) {
    const log = runLog(events, events.length);
    if (log.length === 0) {
        return (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">Nothing has happened on this run yet.</div>
        );
    }
    return (
        <div data-workspace-run-activity className="flex flex-col gap-[8px] px-[18px] py-[14px]">
            {log.map((l) => (
                <ActivityRow key={l.id} ts={l.ts} text={l.text} className="gap-[12px] text-[11.5px]" />
            ))}
        </div>
    );
}
