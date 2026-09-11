// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The one Jarvis surface. While the Brief was being built it rendered BESIDE the three panes behind a dev
// toggle, so that a half-built Brief could never be the only Jarvis surface. B5 retired those panes, and
// the branch, the toggle and the width observer — which existed only to divide space between the column and
// the rail — went with them.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { BriefSurface } from "./briefsurface";
import { JarvisFixtureBar } from "./jarvisfixturebar";

export function JarvisSurface({ model }: { model: AgentsViewModel }) {
    return (
        <div className="absolute inset-0 flex flex-col bg-background">
            {/* dev-only, compiled out of production: the fixture states the CDP harness renders */}
            <JarvisFixtureBar />
            <div className="relative flex min-h-0 flex-1">
                <BriefSurface model={model} />
            </div>
        </div>
    );
}
