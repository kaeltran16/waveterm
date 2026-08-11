// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The shared harness picker: a fixed-width chip naming the current selection, opening an
// Autonomy-style popover of one descriptive row per harness. Used by the Run composer (run-worker
// operation, with the unattended-authority disclosure) and Pet Errand (consult operation, no
// disclosure). One component so both visible selectors read and write the same preference atom.
// The pure derivation functions live here too so the picker and the composer dispatch share one module.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import { autoUpdate, offset, useClick, useDismiss, useFloating, useInteractions, type Placement } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { harnessPreferenceAtom, harnessesAtom, setPreferredHarness } from "./harnessstore";

export type HarnessOperation = "consult" | "run-worker";

// harnessRuntimeIds is the catalog-derived runtime ID set the composer parser uses to recognize an
// explicit `@ask <runtime>` override — the catalog, never a hardcoded frontend list.
export function harnessRuntimeIds(harnesses: HarnessInfo[]): Set<string> {
    return new Set(harnesses.map((h) => h.runtime));
}

export function supportsOperation(h: HarnessInfo, operation: HarnessOperation): boolean {
    return operation === "consult" ? h.consultcapable : h.runworkercapable;
}

export interface HarnessPickerItem {
    runtime: string;
    label: string;
    selected: boolean;
    selectable: boolean;
    unavailableReason?: "unsupported" | "not-installed";
    disclosure?: string;
}

export function harnessPickerItems(
    harnesses: HarnessInfo[],
    runtime: string,
    operation: HarnessOperation
): HarnessPickerItem[] {
    return harnesses.map((h) => {
        const supported = supportsOperation(h, operation);
        return {
            runtime: h.runtime,
            label: h.label,
            selected: h.runtime === runtime,
            selectable: h.installed && supported,
            unavailableReason: !supported ? ("unsupported" as const) : !h.installed ? ("not-installed" as const) : undefined,
            disclosure: operation === "run-worker" ? "Can edit files and run commands without approval." : undefined,
        };
    });
}

export interface HarnessPickerFace {
    label: string;
    valid: boolean;
}

// harnessPickerFace derives the chip's face from the current runtime. An empty runtime means no
// preference exists; an unknown runtime renders its id so the operator sees exactly what is saved.
export function harnessPickerFace(runtime: string, harnesses: HarnessInfo[], operation: HarnessOperation): HarnessPickerFace {
    if (runtime === "") {
        return { label: "Choose harness", valid: false };
    }
    const item = harnesses.find((h) => h.runtime === runtime);
    if (item == null) {
        return { label: `Unknown: ${runtime}`, valid: false };
    }
    if (!item.installed || !supportsOperation(item, operation)) {
        return { label: item.label, valid: false };
    }
    return { label: item.label, valid: true };
}

interface HarnessPickerProps {
    operation: HarnessOperation;
    placement?: Placement;
    className?: string;
    // bumped by a blocked composer submission to focus and open the picker
    openRequest?: number;
}

export function HarnessPicker({ operation, placement = "top-start", className, openRequest = 0 }: HarnessPickerProps) {
    const pref = useAtomValue(harnessPreferenceAtom);
    const harnesses = useAtomValue(harnessesAtom);
    const [open, setOpen] = useState(false);
    useEffect(() => () => setOpen(false), []);
    useEffect(() => {
        if (openRequest > 0) {
            setOpen(true);
        }
    }, [openRequest]);

    const face = harnessPickerFace(pref.runtime, harnesses, operation);
    const items = harnessPickerItems(harnesses, pref.runtime, operation);
    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: setOpen,
        placement,
        middleware: [offset(6)],
        whileElementsMounted: autoUpdate,
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context)]);

    return (
        <div className={cn("relative flex-none", className)}>
            <button
                ref={refs.setReference}
                {...getReferenceProps()}
                type="button"
                data-testid="harness-picker"
                data-harness-operation={operation}
                data-harness-runtime={pref.runtime || ""}
                aria-expanded={open}
                title="Harness — which coding agent runs this"
                className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-[7px] border bg-surface px-2.5 py-1 text-[11px] font-semibold",
                    open ? "border-accent-700 text-primary" : "border-border text-secondary hover:text-primary"
                )}
            >
                <span className="flex-1 whitespace-nowrap text-left">{face.label}</span>
                {pref.saving ? (
                    <span className="font-mono text-[10px] font-normal text-muted">saving</span>
                ) : (
                    <span className={cn("flex-none font-mono text-[10px] text-muted", open && "rotate-180")}>▾</span>
                )}
            </button>
            <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()} className="z-20">
                <PopoverReveal
                    open={open}
                    origin="bottom left"
                    className="w-[300px] rounded-[11px] border border-border bg-surface p-[5px] shadow-[0_12px_34px_rgba(0,0,0,0.5)]"
                >
                    <div>
                        <div className="px-[9px] pb-1.5 pt-1 font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">
                            Harness
                        </div>
                        {items.map((item) => (
                            <button
                                key={item.runtime}
                                type="button"
                                aria-pressed={item.selected}
                                disabled={!item.selectable}
                                data-testid={`harness-option-${item.runtime}`}
                                onClick={() => setPreferredHarness(item.runtime)}
                                className={cn(
                                    "flex w-full items-start gap-2.5 rounded px-[9px] py-2 text-left",
                                    item.selectable ? "cursor-pointer hover:bg-surface-hover" : "cursor-default opacity-70",
                                    item.selected ? "bg-surface-raised" : "bg-transparent"
                                )}
                            >
                                <span className="min-w-0 flex-1">
                                    <span
                                        className={cn(
                                            "block text-[12.5px] font-semibold",
                                            item.selected ? "text-accent" : "text-primary"
                                        )}
                                    >
                                        {item.label}
                                    </span>
                                    {item.unavailableReason != null ? (
                                        <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted">
                                            {item.unavailableReason === "not-installed" ? "not installed" : "unsupported for this action"}
                                        </span>
                                    ) : item.disclosure != null ? (
                                        <span className="mt-[3px] block text-[11px] leading-[1.45] text-muted">{item.disclosure}</span>
                                    ) : null}
                                </span>
                                {item.selected ? (
                                    <span className="flex-none pt-[3px] font-mono text-[11px] text-accent">✓</span>
                                ) : null}
                            </button>
                        ))}
                        {pref.error != null ? (
                            <div className="mt-1 border-t border-border px-[9px] pb-1 pt-2 font-mono text-[10px] text-error">
                                saving failed: {pref.error}
                            </div>
                        ) : null}
                    </div>
                </PopoverReveal>
            </div>
        </div>
    );
}

