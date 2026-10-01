// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { useEffect } from "react";
import { reportPeekFacts, type PeekTarget } from "../peekstore";

export function PeekEffortBody({ target }: { model: AgentsViewModel; target: PeekTarget }) {
    useEffect(() => {
        reportPeekFacts(target, { gone: false, focus: null });
    }, [target]);
    const id = target.kind === "effort" ? target.effortId : "";
    return (
        <div className="px-3.5 py-3 text-[12px] text-secondary">
            initiative <span className="font-mono text-muted">{id}</span>
        </div>
    );
}
