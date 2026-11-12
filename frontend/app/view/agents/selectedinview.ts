// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type RefObject } from "react";

// A selection that moves after mount (j/k, the list cursor) stays in view, and scrolling to it is what pages a
// list on past its first page. Not on mount: a list's own scroll restore owns that frame. The selected row is the
// one under root marked aria-current="true".
export function useSelectedInView(root: RefObject<HTMLElement>, selected: string | null): void {
    const shown = useRef(selected);
    useEffect(() => {
        if (shown.current === selected) {
            return;
        }
        shown.current = selected;
        root.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
    }, [selected]);
}
