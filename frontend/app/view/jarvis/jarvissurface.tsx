// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one Jarvis surface: Subjects · Stage · context rail. Channels, records, threads and the graph all
// live here — the graph as an overlay, a record as a band, never as separate destinations.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { BriefSurface } from "./briefsurface";
import { JarvisFixtureBar } from "./jarvisfixturebar";
import { layoutFor, RAIL_NARROW_PX, RAIL_WIDE_PX } from "./jarvislayout";
import { jarvisCompositionAtom, profileRailOpenAtom, stageRailOpenAtom } from "./jarvisstore";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { Stage } from "./stage";
import { composeStage } from "./stagecompose";
import { StageRail } from "./stagerail";
import { SubjectsColumn } from "./subjectscolumn";

export function JarvisSurface({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const comp = subject != null ? composeStage(subject.kind) : null;

    // the one width observer for the surface. The Subjects column's width is driven from here through the
    // pure jarvislayout.layoutFor — before this nothing was width-responsive, so the Stage was the only
    // region that ever lost space.
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
    // The rail's width is an *input* to the layout, never an output: it is whatever the user last chose.
    // This used to write the rail's open atom shut on every transition into narrow, which — because the
    // first measurement counts as a transition and this surface unmounts on every nav switch — left the
    // rail a 44px strip at every width until the user clicked it open again, measured all the way out to a
    // 1600px window. The width has no business voting on it; it just routes around whatever the rail is.
    //
    // The ⚙ profile drawer shares the right-edge slot and force-collapses the rail while it is open
    // (see StageRail / ProfilePanel), so either panel being open costs the same 300px.
    const railOpen = useAtomValue(stageRailOpenAtom);
    const profileOpen = useAtomValue(profileRailOpenAtom);
    const railPx = railOpen || profileOpen ? RAIL_WIDE_PX : RAIL_NARROW_PX;
    const layout = layoutFor(surfaceWidth, railPx);

    // the Brief lands beside the three panes, not on top of them, so that neither composition is ever
    // half-built. Only the dev fixture bar can select it, and that bar folds away in production.
    const composition = useAtomValue(jarvisCompositionAtom);

    return (
        <div className="absolute inset-0 flex flex-col bg-background">
            {/* dev-only, compiled out of production: the fixture states the CDP harness renders */}
            <JarvisFixtureBar />
            {composition === "brief" ? (
                <div className="relative flex min-h-0 flex-1">
                    <BriefSurface model={model} />
                </div>
            ) : (
                /* relative so an overlaid rail positions against the surface row, not an ancestor */
                <div ref={rowRef} data-jarvis-region="surface" className="relative flex min-h-0 flex-1">
                    <SubjectsColumn model={model} widthPx={layout.subjectsPx} icons={layout.subjectsIcons} />
                    <Stage model={model} />
                    {/* always mounted, comp or not: the rail carries Needs you, which must not wait on the
                        user selecting a subject. Its other sections are subject-derived and stay absent. */}
                    <StageRail model={model} comp={comp} overlay={layout.railOverlay} />
                </div>
            )}
        </div>
    );
}
