// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    closeContextMenu,
    closeSubmenu,
    firstActionable,
    focusedItem,
    initialPath,
    type MenuPath,
    moveHighlight,
    openSubmenu,
    roleAction,
    visibleItems,
    type ContextMenuState,
} from "@/app/store/contextmenu";
import { cn } from "@/util/util";
import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import { useEffect, useRef, useState } from "react";

const PANEL = "z-[1000] min-w-[180px] rounded-[8px] border border-edge-mid bg-surface-raised py-1 shadow-lg";
const ITEM =
    "relative flex cursor-pointer items-center gap-2 px-3 py-1 font-mono text-[12.5px] text-secondary";
const ITEM_ACTIVE = "bg-accent/10 text-primary";
const ITEM_DANGER = "text-error";
const ITEM_DANGER_ACTIVE = "bg-error/10 text-error";
const ITEM_DISABLED = "cursor-default opacity-50";

function runClick(item: ContextMenuItem) {
    if (item.enabled === false) {
        return;
    }
    const act = item.click ?? roleAction(item.role);
    act?.();
    closeContextMenu();
}

function Marker({ item }: { item: ContextMenuItem }) {
    if (item.type === "checkbox") {
        return <span className="w-3 text-accent">{item.checked ? "x" : ""}</span>;
    }
    if (item.type === "radio") {
        return <span className="w-3 text-accent">{item.checked ? "•" : ""}</span>;
    }
    return null;
}

// One menu level. `basePath` is the path prefix that reaches this level's parent
// (empty at root). `active` is the whole highlight path. A row is highlighted when
// active[level] === its index; its submenu is open when the active path goes deeper.
function MenuLevel({
    items,
    basePath,
    active,
    setActive,
}: {
    items: ContextMenuItem[];
    basePath: MenuPath;
    active: MenuPath;
    setActive: (p: MenuPath) => void;
}) {
    const level = basePath.length;
    const vis = visibleItems(items);
    return (
        <>
            {vis.map((item, i) => {
                if (item.type === "separator") {
                    return <div key={i} className="my-1 h-px bg-edge-mid" />;
                }
                if (item.type === "header") {
                    return (
                        <div
                            key={i}
                            className="px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-muted"
                        >
                            {item.label}
                        </div>
                    );
                }
                const rowPath = [...basePath, i];
                const onPath = active[level] === i;
                const submenuOpen = onPath && item.submenu != null && active.length > level + 1;
                const disabled = item.enabled === false;
                const danger = item.danger === true;
                return (
                    <MenuRow
                        key={i}
                        item={item}
                        rowPath={rowPath}
                        highlighted={onPath}
                        submenuOpen={submenuOpen}
                        disabled={disabled}
                        danger={danger}
                        active={active}
                        setActive={setActive}
                    />
                );
            })}
        </>
    );
}

function MenuRow({
    item,
    rowPath,
    highlighted,
    submenuOpen,
    disabled,
    danger,
    active,
    setActive,
}: {
    item: ContextMenuItem;
    rowPath: MenuPath;
    highlighted: boolean;
    submenuOpen: boolean;
    disabled: boolean;
    danger: boolean;
    active: MenuPath;
    setActive: (p: MenuPath) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [flipLeft, setFlipLeft] = useState(false);
    const hasSub = item.submenu != null;

    const onEnter = () => {
        if (disabled) {
            return;
        }
        if (hasSub) {
            const r = ref.current?.getBoundingClientRect();
            if (r) {
                setFlipLeft(r.right + 200 > window.innerWidth);
            }
            // hovering a submenu row opens it (parity with prior behavior); index into the
            // VISIBLE children via firstActionable so the path stays aligned with MenuLevel
            const first = firstActionable(item.submenu!);
            setActive(first < 0 ? rowPath : [...rowPath, first]);
        } else {
            setActive(rowPath);
        }
    };

    const activeCls = danger ? ITEM_DANGER_ACTIVE : ITEM_ACTIVE;
    return (
        <div
            ref={ref}
            className={cn(ITEM, danger && !highlighted && ITEM_DANGER, highlighted && activeCls, disabled && ITEM_DISABLED)}
            onMouseEnter={onEnter}
            onClick={() => (hasSub ? undefined : runClick(item))}
        >
            <Marker item={item} />
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            {hasSub ? <span className="ml-4 text-muted">&gt;</span> : null}
            {item.sublabel ? <span className="ml-4 text-muted">{item.sublabel}</span> : null}
            {submenuOpen ? (
                <div className={cn(PANEL, "absolute top-[-5px]", flipLeft ? "right-full mr-1" : "left-full ml-1")}>
                    <MenuLevel items={item.submenu!} basePath={rowPath} active={active} setActive={setActive} />
                </div>
            ) : null}
        </div>
    );
}

export function ContextMenu({ state }: { state: ContextMenuState }) {
    const { items, x, y } = state;
    const [active, setActive] = useState<MenuPath>(() => initialPath(items));
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

    // grab focus so the menu receives keydown immediately
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        panelRef.current?.focus();
    }, []);

    const descendOrActivate = () => {
        const item = focusedItem(items, active);
        if (item == null) {
            return;
        }
        if (item.submenu != null) {
            const opened = openSubmenu(items, active);
            if (opened) {
                setActive(opened);
            }
        } else {
            runClick(item);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                setActive(moveHighlight(items, active, 1));
                break;
            case "ArrowUp":
                e.preventDefault();
                setActive(moveHighlight(items, active, -1));
                break;
            case "ArrowRight":
            case "Enter":
                e.preventDefault();
                descendOrActivate();
                break;
            case "ArrowLeft": {
                e.preventDefault();
                const closed = closeSubmenu(active);
                if (closed) {
                    setActive(closed);
                } else {
                    closeContextMenu();
                }
                break;
            }
            case "Escape":
                e.preventDefault();
                closeContextMenu();
                break;
        }
    };

    return (
        <FloatingPortal>
            <div
                ref={(node) => {
                    refs.setFloating(node);
                    panelRef.current = node;
                }}
                tabIndex={-1}
                style={floatingStyles}
                className={cn(PANEL, "outline-none")}
                onKeyDown={onKeyDown}
                {...getFloatingProps()}
            >
                <MenuLevel items={items} basePath={[]} active={active} setActive={setActive} />
            </div>
        </FloatingPortal>
    );
}
