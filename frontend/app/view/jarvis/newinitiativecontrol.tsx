// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// + Initiative: the app's only way to start an effort from the UI. EffortCreateForm has been complete and
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
                className="flex-none cursor-pointer rounded-[6px] border border-border px-2.5 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[.06em] text-secondary hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                + Initiative
            </button>
            {open ? <EffortCreateForm onClose={() => setOpen(false)} /> : null}
        </>
    );
}
