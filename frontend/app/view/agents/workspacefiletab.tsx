// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { CodePeekCard } from "../code/codepeekcard";
import { closePeekAt, codePeekAtom, openPeek } from "../code/codepeekstore";
import { resolveCwd } from "./agentcwdresolve";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { tabKey, type WorkspaceTab } from "./workspacemodel";
import { closeWorkspaceTab } from "./workspacestore";

// a reply's peek is keyed apart from the terminal's own, which shares the agent's block
const replyPeekKey = (agent: AgentVM) => `rendered:${agent.blockId ?? agent.id}`;

// The workspace pane's File tab: a cited file in the Code peek, landed on the cited line. The one peek card is this
// tab's while it is active; Esc (codepeek:close) or Open in Code closing the peek closes the tab, and the tab leaving
// (closed, another tab activated, the pane collapsed or the view flipped) closes the peek, or its Enter and Esc would
// still be armed.
export function FileTab({
    model,
    agent,
    tab,
}: {
    model: AgentsViewModel;
    agent: AgentVM;
    tab: Extract<WorkspaceTab, { kind: "file" }>;
}) {
    const blockId = replyPeekKey(agent);
    const peek = useAtomValue(codePeekAtom);
    const mine = peek != null && peek.blockId === blockId && peek.raw === tab.path ? peek : null;

    useEffect(() => {
        // a tab that left while its cwd resolved opens nothing, or a peek no tab shows would hold the store
        let live = true;
        fireAndForget(async () => {
            const cwd = await resolveCwd(agent.transcriptPath, agent.blockId);
            if (live) {
                await openPeek({ blockId, bufferLine: 0, start: 0, raw: tab.path, line: tab.line, cwd });
            }
        });
        return () => {
            live = false;
        };
    }, [blockId, tab.path, tab.line, agent.transcriptPath, agent.blockId]);

    useEffect(() => () => closePeekAt({ blockId, raw: tab.path }), [blockId, tab.path]);

    // only a peek this tab has shown going away closes it: before its first load lands the atom is still empty
    const shownRef = useRef(false);
    useEffect(() => {
        if (mine != null) {
            shownRef.current = true;
        } else if (peek != null) {
            shownRef.current = false;
        } else if (shownRef.current) {
            shownRef.current = false;
            closeWorkspaceTab(agent.id, tabKey(tab));
        }
    }, [mine, peek, agent.id, tab]);

    return (
        <div data-workspace-file={tab.path} className="flex min-h-0 flex-1 flex-col">
            {mine != null ? (
                <CodePeekCard peek={mine} model={model} blockId={agent.blockId ?? agent.id} variant="tab" />
            ) : null}
        </div>
    );
}
