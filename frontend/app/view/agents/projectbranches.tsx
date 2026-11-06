// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's Branches region: the newest commits across every branch, drawn as a graph.

import { RegionHead, RegionSkeleton, type OverviewRegionProps } from "./overviewregion";

export function ProjectBranches(_props: OverviewRegionProps & { changedFiles: number }) {
    return (
        <section aria-label="Branches" className="flex flex-col gap-1.5">
            <RegionHead label="Branches" />
            <RegionSkeleton rows={4} />
        </section>
    );
}
