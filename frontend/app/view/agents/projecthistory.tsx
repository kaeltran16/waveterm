// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's History region: the last 7 days of ended sessions, with the runs they started.

import { RegionHead, RegionSkeleton, type OverviewRegionProps } from "./overviewregion";

export function ProjectHistory(_props: OverviewRegionProps) {
    return (
        <section aria-label="History" className="flex flex-col gap-1.5">
            <RegionHead label="History" />
            <RegionSkeleton rows={6} />
        </section>
    );
}
