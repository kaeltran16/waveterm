// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one Jarvis surface: Subjects · Stage · context rail. Channels, records, threads and the graph all
// live here — the graph as an overlay, a record as a band, never as separate destinations.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { useAtomValue } from "jotai";
import { JarvisFixtureBar } from "./jarvisfixturebar";
import { activeSubjectAtom } from "./jarvissubjectstore";
import { Stage } from "./stage";
import { composeStage } from "./stagecompose";
import { StageRail } from "./stagerail";
import { SubjectsColumn } from "./subjectscolumn";

export function JarvisSurface({ model }: { model: AgentsViewModel }) {
    const subject = useAtomValue(activeSubjectAtom);
    const comp = subject != null ? composeStage(subject.kind) : null;
    return (
        <div className="absolute inset-0 flex flex-col bg-background">
            {/* dev-only, compiled out of production: the fixture states the CDP harness renders */}
            <JarvisFixtureBar />
            <div className="flex min-h-0 flex-1">
                <SubjectsColumn model={model} />
                <Stage model={model} />
                {/* always mounted, comp or not: the rail carries Needs you, which must not wait on the
                    user selecting a subject. Its other sections are subject-derived and stay absent. */}
                <StageRail model={model} comp={comp} />
            </div>
        </div>
    );
}
