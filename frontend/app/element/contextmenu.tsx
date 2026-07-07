// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { closeContextMenu, roleAction, visibleItems, type ContextMenuState } from "@/app/store/contextmenu";
import { cn } from "@/util/util";
import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import { useEffect, useRef, useState } from "react";

const PANEL = "z-[1000] min-w-[180px] rounded-[8px] border border-edge-mid bg-surface-raised py-1 shadow-lg";
const ITEM =
    "relative flex cursor-pointer items-center gap-2 px-3 py-1 font-mono text-[12.5px] text-secondary hover:bg-accent/10 hover:text-primary";
const ITEM_DISABLED = "cursor-default opacity-50 hover:bg-transparent hover:text-secondary";

function runClick(item: ContextMenuItem) {
    if (item.enabled === false) {
        return;
    }
    const act = item.click ?? roleAction(item.role);
    act?.();
    closeContextMenu();
}

function Row({ item }: { item: ContextMenuItem }) {
    if (item.type === "separator") {
        return <div className="my-1 h-px bg-edge-mid" />;
    }
    if (item.type === "header") {
        return (
            <div className="px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-muted">
                {item.label}
            </div>
        );
    }
    if (item.submenu) {
        return <SubmenuRow item={item} />;
    }
    const disabled = item.enabled === false;
    return (
        <div className={cn(ITEM, disabled && ITEM_DISABLED)} onClick={() => runClick(item)}>
            {item.type === "checkbox" ? <span className="w-3 text-accent">{item.checked ? "x" : ""}</span> : null}
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            {item.sublabel ? <span className="ml-4 text-muted">{item.sublabel}</span> : null}
        </div>
    );
}

function SubmenuRow({ item }: { item: ContextMenuItem }) {
    const [open, setOpen] = useState(false);
    const [flipLeft, setFlipLeft] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const disabled = item.enabled === false;
    const onEnter = () => {
        if (disabled) {
            return;
        }
        const r = ref.current?.getBoundingClientRect();
        if (r) {
            setFlipLeft(r.right + 200 > window.innerWidth);
        }
        setOpen(true);
    };
    return (
        <div
            ref={ref}
            className={cn(ITEM, disabled && ITEM_DISABLED)}
            onMouseEnter={onEnter}
            onMouseLeave={() => setOpen(false)}
        >
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            <span className="ml-4 text-muted">&gt;</span>
            {open ? (
                <div className={cn(PANEL, "absolute top-[-5px]", flipLeft ? "right-full mr-1" : "left-full ml-1")}>
                    {visibleItems(item.submenu!).map((sub, i) => (
                        <Row key={i} item={sub} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function ContextMenu({ state }: { state: ContextMenuState }) {
    const { items, x, y } = state;
    const { refs, floatingStyles, context } = useFloating({
        open: true,
        onOpenChange: (o) => {
            if (!o) {
                closeContextMenu();
            }
        },
        placement: "bottom-start",
        middleware: [offset({ mainAxis: 4 }), flip(), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    useEffect(() => {
        refs.setPositionReference({
            getBoundingClientRect: () => ({ width: 0, height: 0, x, y, top: y, left: x, right: x, bottom: y }),
        });
    }, [x, y, refs]);
    const dismiss = useDismiss(context);
    const { getFloatingProps } = useInteractions([dismiss]);
    return (
        <FloatingPortal>
            <div ref={refs.setFloating} style={floatingStyles} className={PANEL} {...getFloatingProps()}>
                {visibleItems(items).map((it, i) => (
                    <Row key={i} item={it} />
                ))}
            </div>
        </FloatingPortal>
    );
}
