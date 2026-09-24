// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Placeholder for a graph that has not laid out yet (vault graph, DAG): a few node-shaped blocks, not a
// "Loading graph…" line.

import { Skeleton } from "@/app/element/skeleton";

export function GraphSkeleton() {
    return (
        <div aria-hidden="true" className="flex h-full w-full items-center justify-center gap-10">
            <Skeleton className="h-[44px] w-[140px] rounded-[10px]" />
            <div className="flex flex-col gap-6">
                <Skeleton className="h-[44px] w-[140px] rounded-[10px]" />
                <Skeleton className="h-[44px] w-[140px] rounded-[10px]" />
            </div>
            <Skeleton className="h-[44px] w-[140px] rounded-[10px]" />
        </div>
    );
}
