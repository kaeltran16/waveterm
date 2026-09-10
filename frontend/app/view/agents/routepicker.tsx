// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import {
    autoUpdate,
    flip,
    offset,
    shift,
    size as floatingSize,
    useClick,
    useDismiss,
    useFloating,
    useInteractions,
    type Placement,
} from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { buildPickerSections, filterPickerSections, modelFace, pickerTitleFor } from "./route";
import { harnessesAtom, refreshHarnessCatalog } from "./harnessstore";

const ROUTE_PICKER_MAX_HEIGHT = 360;

export function RoutePicker({
    value,
    onChange,
    canInherit = false,
    inheritedLabel = "Inherit route",
    placement = "top-start",
    openRequest = 0,
    title,
    size = "default",
    disabled = false,
}: {
    value: RoutePin | null;
    onChange: (route: RoutePin | null) => void;
    canInherit?: boolean;
    inheritedLabel?: string;
    placement?: Placement;
    openRequest?: number;
    title?: string;
    size?: "default" | "compact";
    disabled?: boolean;
}): JSX.Element {
    const harnesses = useAtomValue(harnessesAtom);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [customId, setCustomId] = useState<{ runtime: string; draft: string } | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const rowRefs = useRef(new Map<string, HTMLButtonElement>());
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
    const rowKeys = useMemo(
        () => sections.flatMap((section) => section.rows.map((row) => `${row.runtime}:${row.model}`)),
        [sections]
    );
    useEffect(() => {
        if (!open) {
            return;
        }
        const frame = requestAnimationFrame(() => searchRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [open]);
    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange(next, _event, reason) {
            setOpen(next);
            if (!next && reason === "escape-key") {
                requestAnimationFrame(() => triggerRef.current?.focus());
            }
        },
        placement,
        middleware: [
            offset(6),
            flip({ padding: 8 }),
            shift({ padding: 8 }),
            floatingSize({
                padding: 8,
                apply({ availableHeight, elements }) {
                    const maxHeight = Math.max(0, Math.min(ROUTE_PICKER_MAX_HEIGHT, availableHeight));
                    elements.floating.style.setProperty("--route-picker-max-height", `${maxHeight}px`);
                },
            }),
        ],
        whileElementsMounted: autoUpdate,
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context)]);

    const choose = (route: RoutePin | null) => {
        onChange(route);
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
    };
    const focusRow = (index: number) => {
        if (rowKeys.length === 0) {
            return;
        }
        const wrapped = (index + rowKeys.length) % rowKeys.length;
        rowRefs.current.get(rowKeys[wrapped])?.focus();
    };
    const navigateRow = (event: KeyboardEvent<HTMLElement>, index: number) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
            return;
        }
        event.preventDefault();
        focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
    };

    return (
        <div className="relative flex-none">
            <button
                ref={(node) => {
                    triggerRef.current = node;
                    refs.setReference(node);
                }}
                {...getReferenceProps()}
                type="button"
                data-testid="route-picker"
                disabled={disabled}
                aria-expanded={open}
                aria-label={pickerTitleFor(title)}
                className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-[6px] border bg-surface text-left font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40",
                    size === "compact"
                        ? "max-w-[200px] px-2 py-[3px] text-[10.5px]"
                        : "max-w-[300px] px-2.5 py-1 text-[11px]",
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
                    className="flex max-h-[var(--route-picker-max-height)] w-[320px] flex-col overflow-hidden rounded-[11px] border border-border bg-surface p-[5px] shadow-popover-md"
                >
                    <div role="group" aria-label="Available routes" className="flex min-h-0 flex-1 flex-col">
                        <div className="flex items-center justify-between px-[9px] pb-1.5 pt-1">
                            <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">{pickerTitleFor(title)}</span>
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
                            ref={searchRef}
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                    event.preventDefault();
                                    focusRow(event.key === "ArrowDown" ? 0 : rowKeys.length - 1);
                                }
                            }}
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
                        <div data-testid="route-picker-scroll" className="min-h-0 overflow-y-auto overscroll-contain">
                        {sections.map((section) => (
                            <div key={section.runtime} className="mt-1 border-t border-border pt-1">
                                <div className="px-[9px] py-1 text-[11px] font-semibold text-secondary">{section.label}</div>
                                {section.rows.map((row) => {
                                    const selectedRow = value?.runtime === row.runtime && value.model === row.model;
                                    const key = `${row.runtime}:${row.model}`;
                                    const index = rowKeys.indexOf(key);
                                    return (
                                        <button
                                            key={row.model}
                                            ref={(node) => {
                                                if (node == null) {
                                                    rowRefs.current.delete(key);
                                                } else {
                                                    rowRefs.current.set(key, node);
                                                }
                                            }}
                                            type="button"
                                            onKeyDown={(event) => navigateRow(event, index)}
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
                    </div>
                </PopoverReveal>
            </div>
        </div>
    );
}
