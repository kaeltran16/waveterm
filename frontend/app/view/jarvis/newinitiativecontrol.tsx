// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// New initiative: the app's only way to start an effort from the UI. EffortCreateForm has been complete and
// working the whole time — it lost its only mount when B5 deleted effortslistview.tsx, so the Brief listed
// initiatives it could not start one of. This is the mount, next to + Channel, because those are the two
// things the Brief can begin. The ⇧N binding presses it by data attribute (buildJarvisBindings), the same
// way `c` presses + Channel.

import { useState } from "react";
import { EffortCreateForm } from "./effortcreateform";

export function NewInitiativeControl() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                data-jarvis-new-initiative
                aria-expanded={open}
                onClick={() => setOpen(true)}
                className="flex h-[28px] flex-none cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-edge-mid px-2.5 text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                New initiative
                <kbd className="font-mono text-[10px] font-normal text-muted">⇧N</kbd>
            </button>
            {open ? <EffortCreateForm onClose={() => setOpen(false)} /> : null}
        </>
    );
}
