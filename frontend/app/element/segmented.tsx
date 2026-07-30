// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Mono segmented control: a small set of mutually-exclusive options in a bordered pill. Lifted out of
// usagesurface.tsx so the Usage surface and the Daily chart can share one control without the chart
// importing the surface. settingssurface.tsx keeps its own UI-font variant — a different look, not a
// duplicate of this one.

import { cn } from "@/util/util";

export function Segmented<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { key: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div className="flex flex-none rounded border border-border bg-surface-raised p-[3px]">
            {options.map((o) => (
                <button
                    key={o.key}
                    onClick={() => onChange(o.key)}
                    className={cn(
                        "cursor-pointer rounded-sm border-0 px-[12px] py-[5px] font-mono text-[11px] font-semibold",
                        value === o.key ? "bg-accentbg text-primary" : "bg-transparent text-muted"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}
