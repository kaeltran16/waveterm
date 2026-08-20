// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import {
    autoUpdate,
    offset,
    useClick,
    useDismiss,
    useFloating,
    useInteractions,
    type Placement,
} from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState, type JSX } from "react";
import { capabilityFor, routePickerItems } from "./route";
import { harnessesAtom } from "./harnessstore";

export function RoutePicker({
    value,
    onChange,
    canInherit = false,
    inheritedLabel = "Inherit route",
    placement = "top-start",
    openRequest = 0,
}: {
    value: RoutePin | null;
    onChange: (route: RoutePin | null) => void;
    canInherit?: boolean;
    inheritedLabel?: string;
    placement?: Placement;
    openRequest?: number;
}): JSX.Element {
    const harnesses = useAtomValue(harnessesAtom);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (openRequest > 0) {
            setOpen(true);
        }
    }, [openRequest]);
    const items = useMemo(() => routePickerItems(harnesses), [harnesses]);
    const selected = value == null ? undefined : capabilityFor(value, harnesses);
    const harness = value == null ? undefined : harnesses.find((h) => h.runtime === value.runtime);
    const face = value == null
        ? inheritedLabel
        : selected == null
          ? `Unavailable: ${harness?.label ?? value.runtime} · ${value.tier}`
          : `${harness?.label ?? value.runtime} · ${value.tier} · ${selected.resolvedmodel}`;
    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: setOpen,
        placement,
        middleware: [offset(6)],
        whileElementsMounted: autoUpdate,
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context)]);

    const choose = (route: RoutePin | null) => {
        onChange(route);
        setOpen(false);
    };

    return (
        <div className="relative flex-none">
            <button
                ref={refs.setReference}
                {...getReferenceProps()}
                type="button"
                data-testid="route-picker"
                aria-expanded={open}
                aria-label="Run route"
                className={cn(
                    "flex max-w-[300px] cursor-pointer items-center gap-2 rounded-[7px] border bg-surface px-2.5 py-1 text-left text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    open ? "border-accent-700 text-primary" : "border-border text-secondary hover:text-primary",
                    value != null && selected == null && "border-error/60 text-error-soft"
                )}
            >
                <span className="min-w-0 truncate">{face}</span>
                <span className={cn("flex-none font-mono text-[10px] text-muted", open && "rotate-180")}>▾</span>
            </button>
            <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()} className="z-20">
                <PopoverReveal
                    open={open}
                    origin="bottom left"
                    className="w-[320px] rounded-[11px] border border-border bg-surface p-[5px] shadow-popover-md"
                >
                    <div role="group" aria-label="Available routes">
                        <div className="px-[9px] pb-1.5 pt-1 font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">
                            Run route
                        </div>
                        {canInherit ? (
                            <button
                                type="button"
                                aria-pressed={value == null}
                                data-testid="route-option-inherit"
                                onClick={() => choose(null)}
                                className={cn(
                                    "flex w-full cursor-pointer items-start rounded px-[9px] py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                    value == null ? "bg-surface-raised text-accent" : "text-primary hover:bg-surface-hover"
                                )}
                            >
                                <span className="min-w-0 flex-1 text-[12.5px] font-semibold">{inheritedLabel}</span>
                                {value == null ? <span className="font-mono text-[11px] text-accent">✓</span> : null}
                            </button>
                        ) : null}
                        {items.map((section) => (
                            <div key={section.runtime} className="mt-1 border-t border-border pt-1">
                                <div className="px-[9px] py-1 text-[11px] font-semibold text-secondary">{section.label}</div>
                                {section.capabilities.map((capability) => {
                                    const route = { runtime: capability.runtime, tier: capability.tier };
                                    const selectedRow = value?.runtime === route.runtime && value.tier === route.tier;
                                    return (
                                        <button
                                            key={`${capability.runtime}-${capability.tier}`}
                                            type="button"
                                            aria-pressed={selectedRow}
                                            data-testid={`route-option-${capability.runtime}-${capability.tier}`}
                                            onClick={() => choose(route)}
                                            className={cn(
                                                "flex w-full cursor-pointer items-start gap-2 rounded px-[9px] py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                                selectedRow ? "bg-surface-raised" : "hover:bg-surface-hover"
                                            )}
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className={cn("block text-[12px] font-semibold", selectedRow ? "text-accent" : "text-primary")}>
                                                    {capability.tier}
                                                </span>
                                                <span className="mt-[3px] block font-mono text-[10.5px] text-muted">{capability.resolvedmodel}</span>
                                            </span>
                                            {selectedRow ? <span className="pt-[3px] font-mono text-[11px] text-accent">✓</span> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                        {items.length === 0 ? <div className="px-[9px] py-2 text-[11px] text-muted">No run routes available.</div> : null}
                    </div>
                </PopoverReveal>
            </div>
        </div>
    );
}
