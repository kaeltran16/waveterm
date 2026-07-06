// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";

export function skeletonClass(className?: string): string {
    return cn("rounded-[6px] bg-surface-hover animate-pulse motion-reduce:animate-none", className);
}

export function Skeleton({ className }: { className?: string }) {
    return <div aria-hidden="true" className={skeletonClass(className)} />;
}

export function SkeletonLine({ className }: { className?: string }) {
    return <Skeleton className={cn("h-3", className)} />;
}
