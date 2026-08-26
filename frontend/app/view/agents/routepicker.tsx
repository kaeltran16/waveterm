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
import { buildPickerSections, filterPickerSections, modelFace } from "./route";
import { harnessesAtom, refreshHarnessCatalog } from "./harnessstore";

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
    const [query, setQuery] = useState("");
    const [customId, setCustomId] = useState<{ runtime: string; draft: string } | null>(null);
    useEffect(() => {
        if (openRequest > 0) {
            setOpen(true);
        }
    }, [openRequest]);
    // custom/free-form ids may be namespace-valid without catalog presence, so the face never
    // claims "unavailable" — resolution happens server-side at dispatch.
    const harness = value == null ? undefined : harnesses.find((h) => h.runtime === value.runtime);
    const face = value == null ? inheritedLabel : `${harness?.label ?? value.runtime} · ${modelFace(value)}`;
    const sections = useMemo(() => filterPickerSections(buildPickerSections(harnesses), query), [harnesses, query]);
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
                    open ? "border-accent-700 text-primary" : "border-border text-secondary hover:text-primary"
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
                        <div className="flex items-center justify-between px-[9px] pb-1.5 pt-1">
                            <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">Run route</span>
                            <button
                                type="button"
                                onClick={() => void refreshHarnessCatalog()}
                                aria-label="Refresh model catalog"
                                title="Refresh model catalog"
                                className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-hover hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            >
                                ↻
                            </button>
                        </div>
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="filter models…"
                            aria-label="Filter models"
                            className="mb-1 w-full rounded-[7px] border border-edge-mid bg-surface px-2 py-1 text-[11.5px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        />
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
                        {sections.map((section) => (
                            <div key={section.runtime} className="mt-1 border-t border-border pt-1">
                                <div className="px-[9px] py-1 text-[11px] font-semibold text-secondary">{section.label}</div>
                                {section.rows.map((row) => {
                                    const selectedRow = value?.runtime === row.runtime && value.model === row.model;
                                    return (
                                        <button
                                            key={row.model}
                                            type="button"
                                            aria-pressed={selectedRow}
                                            data-testid={`route-option-${row.runtime}-${row.model}`}
                                            onClick={() => choose({ runtime: row.runtime, tier: "", model: row.model })}
                                            className={cn(
                                                "flex w-full cursor-pointer items-start gap-2 rounded px-[9px] py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                                selectedRow ? "bg-surface-raised" : "hover:bg-surface-hover"
                                            )}
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className={cn("block font-mono text-[11.5px]", selectedRow ? "text-accent" : "text-primary")}>{row.model}</span>
                                                <span className="mt-[2px] block text-[10px] text-muted">
                                                    {row.provider && row.provider !== row.runtime ? `provider ${row.provider} · ` : ""}
                                                    {row.contexthint ? `ctx ${row.contexthint} · ` : ""}
                                                    {row.default ? "CLI default" : ""}
                                                </span>
                                            </span>
                                            {selectedRow ? <span className="pt-[3px] font-mono text-[11px] text-accent">✓</span> : null}
                                        </button>
                                    );
                                })}
                                {customId?.runtime === section.runtime ? (
                                    <div className="flex items-center gap-1.5 px-[9px] py-1.5">
                                        <input
                                            autoFocus
                                            value={customId.draft}
                                            onChange={(e) => setCustomId({ runtime: section.runtime, draft: e.target.value })}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" && customId.draft.trim()) {
                                                    choose({ runtime: section.runtime, tier: "", model: customId.draft.trim() });
                                                }
                                            }}
                                            aria-label={`Custom model id for ${section.label}`}
                                            className="min-w-0 flex-1 rounded-[7px] border border-edge-mid bg-surface px-2 py-1 text-[11px] font-mono text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => customId.draft.trim() && choose({ runtime: section.runtime, tier: "", model: customId.draft.trim() })}
                                            aria-label="Use custom model"
                                            className="cursor-pointer rounded-md border border-edge-mid px-2 py-1 text-[10.5px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                        >
                                            Use
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => setCustomId({ runtime: section.runtime, draft: "" })}
                                        className="flex w-full cursor-pointer items-center gap-2 rounded px-[9px] py-1.5 text-left text-[11px] text-muted hover:bg-surface-hover hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    >
                                        ＋ custom model id…
                                    </button>
                                )}
                            </div>
                        ))}
                        {sections.length === 0 && !query ? <div className="px-[9px] py-2 text-[11px] text-muted">No run routes available.</div> : null}
                    </div>
                </PopoverReveal>
            </div>
        </div>
    );
}
