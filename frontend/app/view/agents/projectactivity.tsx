// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's Activity region: tokens per day over the last 53 weeks.

import { RegionHead, RegionSkeleton, type OverviewRegionProps } from "./overviewregion";

export function ProjectActivity(_props: OverviewRegionProps) {
    return (
        <section aria-label="Activity" className="flex flex-col gap-1.5">
            <RegionHead label="Activity" />
            <RegionSkeleton rows={4} />
        </section>
    );
}
