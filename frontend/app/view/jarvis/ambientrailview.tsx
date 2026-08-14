// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one home for the three ambient views: the continuity resume narrative, the proactive "related prior
// work" suggestion, and the attribution engine's relevant past decisions. They used to hang off RunHeader
// and the run body's pipeline branch, so a sealed run — which renders RunCompletion instead — showed none of
// them, and a record subject never showed the narrative that names it. Which views apply is ambientrail's
// decision, not whichever branch happened to render.
//
// The three card components are reused unchanged, dismissal included: this file only chooses and frames them.

import type { RailSection } from "@/app/element/collapsiblerail";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { RelevantDecisions } from "@/app/view/agents/ambientviews";
import { ProactiveCard } from "@/app/view/agents/proactiveviews";
import { ResumeCard } from "@/app/view/agents/resumeviews";
import { Sparkles } from "lucide-react";
import { ambientRailFor, type AmbientRailInput } from "./ambientrail";

// "Ambient" is this codebase's word for these views, not a user's, and the rail's own title is already
// "Context" — so the section reads in the register of its siblings (Needs you, Consults, Fleet).
export const AMBIENT_SECTION_LABEL = "Worth knowing";

// the real AgentsViewModel is threaded in because the proactive card navigates via openORef,
// which needs the live model (surfaceAtom, openTerminal); AmbientRailInput stays pure data.
export function ambientSection(model: AgentsViewModel, input: AmbientRailInput): RailSection | null {
    const am = ambientRailFor(input);
    if (am == null) {
        return null;
    }
    return {
        id: "ambient",
        icon: <Sparkles size={18} strokeWidth={1.8} />,
        label: AMBIENT_SECTION_LABEL,
        content: (
            <div className="flex flex-col gap-2.5">
                <div className="font-mono text-[9px] uppercase tracking-[.09em] text-muted">
                    {AMBIENT_SECTION_LABEL}
                </div>
                {am.resumeRun != null ? <ResumeCard run={am.resumeRun} /> : null}
                {am.proactiveRun != null ? <ProactiveCard model={model} run={am.proactiveRun} /> : null}
                {am.decisionsORef != null ? <RelevantDecisions oref={am.decisionsORef} /> : null}
            </div>
        ),
    };
}
