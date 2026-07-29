// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one Jarvis surface: Subjects · Stage · context rail. Channels, records, threads and the graph all
// live here — the graph as an overlay, a record as a band, never as separate destinations.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { JarvisFixtureBar } from "./jarvisfixturebar";
import { collapseFor } from "./jarvislayout";
import { stageRailOpenAtom } from "./jarvisstore";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { Stage } from "./stage";
import { composeStage } from "./stagecompose";
import { StageRail } from "./stagerail";
import { SubjectsColumn } from "./subjectscolumn";

export function JarvisSurface({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const comp = subject != null ? composeStage(subject.kind) : null;

    // the one width observer for the surface. Every region that yields on a narrow window is driven from
    // here in the design's order (jarvislayout.collapseFor) — before this nothing was width-responsive, so
    // the Stage was the only region that ever lost space.
    const rowRef = useRef<HTMLDivElement>(null);
    const [surfaceWidth, setSurfaceWidth] = useState(0);
    useEffect(() => {
        const el = rowRef.current;
        if (el == null) {
            return;
        }
        const ro = new ResizeObserver(([entry]) => setSurfaceWidth(entry.contentRect.width));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const collapse = collapseFor(surfaceWidth);

    // Step 1 of the order closes the rail by *writing* its open atom on the transition into narrow, rather
    // than overriding it while narrow. Overriding also killed the collapsed strip's expand button — the
    // rail became unopenable below ~1290px, which trades one broken layout for a dead control. This way
    // the width picks the default and the user still gets the last word (at the cost of the Stage's floor,
    // which is their call to make).
    //
    // The first measurement counts as a transition, so entering the surface on a narrow window reasserts
    // the default — and this surface unmounts on every nav switch, so that is every time you come back.
    // Deliberate: the persisted flag records a preference formed at some other width, and the point of the
    // order is that the Stage is usable on arrival. Re-opening it sticks for as long as you stay here.
    const setRailOpen = useSetAtom(stageRailOpenAtom);
    const wasCollapsed = useRef(collapse.railCollapsed);
    useEffect(() => {
        if (collapse.railCollapsed && !wasCollapsed.current) {
            setRailOpen(false);
        }
        wasCollapsed.current = collapse.railCollapsed;
    }, [collapse.railCollapsed, setRailOpen]);

    return (
        <div className="absolute inset-0 flex flex-col bg-background">
            {/* dev-only, compiled out of production: the fixture states the CDP harness renders */}
            <JarvisFixtureBar />
            <div ref={rowRef} data-jarvis-region="surface" className="flex min-h-0 flex-1">
                <SubjectsColumn model={model} collapsed={collapse.subjectsCollapsed} />
                <Stage model={model} />
                {/* always mounted, comp or not: the rail carries Needs you, which must not wait on the
                    user selecting a subject. Its other sections are subject-derived and stay absent. */}
                <StageRail model={model} comp={comp} />
            </div>
        </div>
    );
}
