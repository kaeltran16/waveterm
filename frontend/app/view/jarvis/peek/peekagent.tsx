// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { useEffect } from "react";
import { reportPeekFacts, type PeekTarget } from "../peekstore";

export function PeekAgentBody({ target }: { model: AgentsViewModel; target: PeekTarget }) {
    useEffect(() => {
        reportPeekFacts(target, { gone: false, focus: null });
    }, [target]);
    const id = target.kind === "agent" ? target.tabId : "";
    return (
        <div className="px-3.5 py-3 text-[12px] text-secondary">
            agent <span className="font-mono text-muted">{id}</span>
        </div>
    );
}
