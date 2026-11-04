// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's right rail: the Events rail. Plan usage sits in the app bar (UsageMeters).

import { CollapsibleRail } from "@/app/element/collapsiblerail";
import type { AgentsViewModel } from "./agents";
import { CockpitEventsRail, useRailRows } from "./cockpiteventsrail";
import { ICON } from "./navrail";
import type { Lineage } from "./runlineage";

export function CockpitRail({
    model,
    lineage,
    runEvents,
    tags,
    onSelectAgent,
}: {
    model: AgentsViewModel;
    lineage: Lineage;
    runEvents: Record<string, RunEvent[]>;
    tags: Record<string, string>;
    onSelectAgent: (id: string) => void;
}) {
    const unread = useRailRows(model, lineage, runEvents).fresh.length;
    return (
        <CollapsibleRail
            openAtom={model.railOpenAtom}
            ariaLabel="Events"
            strip={{ content: <EventsStrip unread={unread} />, title: "Events" }}
            sections={[
                {
                    id: "events",
                    label: "Events",
                    icon: ICON.sessions,
                    content: (
                        <CockpitEventsRail
                            model={model}
                            lineage={lineage}
                            runEvents={runEvents}
                            tags={tags}
                            onSelect={onSelectAgent}
                        />
                    ),
                },
            ]}
        />
    );
}

// the collapsed rail: its glyph, badged with the unread count so new events read while it is closed
function EventsStrip({ unread }: { unread: number }) {
    return (
        <span className="relative flex h-[20px] w-[20px] items-center justify-center text-accent">
            {ICON.sessions}
            {unread > 0 ? (
                <span
                    data-rail-unread={unread}
                    className="absolute -right-[8px] -top-[6px] flex h-[16px] min-w-[16px] items-center justify-center rounded-[8px] border-2 border-surface bg-accent px-[3px] font-mono text-[10.5px] font-bold leading-none text-background"
                >
                    {unread}
                </span>
            ) : null}
        </span>
    );
}
