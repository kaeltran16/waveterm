// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The details rail's two label levels, on the Jarvis brief scale: a section heading, and the muted label under it.

import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
    return <h3 className={cn(REGION_LABEL, "text-ink-mid", className)}>{children}</h3>;
}

export function SubLabel({ children, className }: { children: React.ReactNode; className?: string }) {
    return <span className={cn(REGION_LABEL, "text-muted", className)}>{children}</span>;
}
