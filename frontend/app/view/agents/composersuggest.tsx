// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// the suggestion panel `/` and `@` open above the Rendered box. The caller owns the state and the keys
// (composersuggestmodel.ts) and renders this inside a `relative` box so it sits right above it.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import { Fragment, useEffect, useRef, type JSX, type ReactNode } from "react";

const KEY_LINE = "↑↓ move · Tab/Enter pick · Esc close";

export function ComposerSuggest<T>(props: {
    open: boolean;
    items: T[];
    at: number;
    groups?: { title: string; start: number }[];
    itemKey: (t: T) => string;
    renderItem: (t: T, active: boolean) => ReactNode;
    onPick: (index: number) => void;
    onHover: (index: number) => void;
    note?: ReactNode;
    footer?: ReactNode;
    label: string;
    dataAttr: string;
}): JSX.Element {
    const { open, items, at, groups, itemKey, renderItem, onPick, onHover, note, footer, label, dataAttr } = props;
    const listRef = useRef<HTMLDivElement>(null);
    const hasRows = items.length > 0;

    // the first row scrolls to the very top, or the group header above it stays out of view
    useEffect(() => {
        if (!open || !hasRows) return;
        if (at === 0) {
            listRef.current?.scrollTo({ top: 0 });
            return;
        }
        listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
    }, [open, at, hasRows, items]);

    const titleAt = new Map((groups ?? []).map((g) => [g.start, g.title]));
    return (
        <PopoverReveal
            open={open}
            origin="bottom"
            className="absolute bottom-full left-0 right-0 z-10 mb-1 overflow-hidden rounded border border-edge-mid bg-modalbg shadow-popover"
        >
            <div {...{ [dataAttr]: "" }} className="flex flex-col">
                {hasRows ? (
                    <div
                        ref={listRef}
                        role="listbox"
                        aria-label={label}
                        className="max-h-[240px] min-h-0 overflow-y-auto py-1"
                    >
                        {items.map((item, i) => {
                            const active = i === at;
                            const title = titleAt.get(i);
                            return (
                                <Fragment key={itemKey(item)}>
                                    {title != null ? (
                                        <div className="px-3 pb-[3px] pt-[7px] text-[10.5px] font-medium text-muted">
                                            {title}
                                        </div>
                                    ) : null}
                                    <div
                                        role="option"
                                        aria-selected={active}
                                        data-suggest-item=""
                                        data-active={active ? "" : undefined}
                                        // mousedown would move focus off the textarea before the click lands
                                        onMouseDown={(e) => e.preventDefault()}
                                        // mousemove, not mouseenter: a keyboard scroll under a still pointer must
                                        // not steal the highlight
                                        onMouseMove={() => {
                                            if (!active) onHover(i);
                                        }}
                                        onClick={() => onPick(i)}
                                        className={cn(
                                            "flex cursor-pointer items-center gap-2 px-3 py-[6px] text-[12.5px]",
                                            active ? "bg-surface-hover text-primary" : "text-secondary"
                                        )}
                                    >
                                        {renderItem(item, active)}
                                    </div>
                                </Fragment>
                            );
                        })}
                    </div>
                ) : note != null ? (
                    <div aria-label={label} className="px-3 py-[9px] text-[12px] text-muted">
                        {note}
                    </div>
                ) : null}
                {hasRows || footer != null ? (
                    <div className="flex items-center gap-3 border-t border-edge-mid px-3 py-[5px] text-[10.5px] text-muted">
                        {hasRows ? <span className="font-mono">{KEY_LINE}</span> : null}
                        {footer != null ? <span className="ml-auto truncate">{footer}</span> : null}
                    </div>
                ) : null}
            </div>
        </PopoverReveal>
    );
}
