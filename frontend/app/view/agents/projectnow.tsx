// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's Now region: what runs in the project, and what finished that is not read yet.

import { RegionHead, RegionSkeleton, type OverviewRegionProps } from "./overviewregion";

export function ProjectNow(_props: OverviewRegionProps) {
    return (
        <section aria-label="Now" className="flex flex-col gap-1.5">
            <RegionHead label="Now" />
            <RegionSkeleton rows={3} />
        </section>
    );
}
