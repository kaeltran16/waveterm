// frontend/app/view/code/codesearchpane.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Content search results, in the left column rather than an overlay: results are read repeatedly
// while jumping between them, and an overlay that closes on each jump makes that a loop of
// reopening. Every result row goes through openInCode, the same primitive the finder and the two
// cockpit entry points use.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { groupMatches, summarize, type SearchGroup } from "./codesearch";
import { codeSearchAtom, codeSearchQueryAtom, runSearch, type SearchState } from "./codesearchstore";
import { codeProjectAtom, openInCode } from "./codestore";

export function CodeSearchPane({ model }: { model: AgentsViewModel }) {
    const project = useAtomValue(codeProjectAtom);
    const [query, setQuery] = useAtom(codeSearchQueryAtom);
    const state = useAtomValue(codeSearchAtom);
    const inputRef = useRef<HTMLInputElement>(null);

    // the surface unmounts on nav switch, so this runs on every return to Search mode — which is
    // what you want: the query survives in an atom, the caret comes back to it
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const groups = useMemo(() => (state.kind === "done" ? groupMatches(state.matches) : []), [state]);

    const submit = () => {
        if (project != null) {
            fireAndForget(() => runSearch(project, query));
        }
    };

    return (
        <div className="flex h-full flex-col border-r border-border">
            <div className="flex-none px-2 py-2">
                <input
                    ref={inputRef}
                    value={query}
                    placeholder="Search file contents"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            submit();
                        }
                    }}
                    className="w-full rounded-[8px] border border-border bg-surface px-2 py-1 text-[12px] text-primary outline-none placeholder:text-muted"
                />
            </div>
            <SearchBody model={model} state={state} groups={groups} onRetry={submit} />
        </div>
    );
}

function SearchBody({
    model,
    state,
    groups,
    onRetry,
}: {
    model: AgentsViewModel;
    state: SearchState;
    groups: SearchGroup[];
    onRetry: () => void;
}) {
    const project = useAtomValue(codeProjectAtom);
    if (state.kind === "idle") {
        return <div className="px-3 py-2 text-[11.5px] text-muted">Type a string and press Enter.</div>;
    }
    if (state.kind === "searching") {
        return <div className="px-3 py-2 text-[11.5px] text-muted">Searching…</div>;
    }
    if (state.kind === "error") {
        return (
            <div className="px-3 py-2 text-[11.5px] text-muted">
                <p className="text-error">Search failed: {state.message}</p>
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-1 cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[11px] hover:text-primary"
                >
                    Retry
                </button>
            </div>
        );
    }
    return (
        <>
            <div className="flex-none px-3 pb-1 text-[10.5px] text-muted">{summarize(groups, state.truncated)}</div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {groups.map((group) => (
                    <div key={group.path}>
                        <div className="sticky top-0 bg-surface px-2 py-1 font-mono text-[10.5px] text-muted">
                            {group.path}
                        </div>
                        {group.matches.map((match) => (
                            <div
                                key={`${match.path}:${match.line}`}
                                onClick={() => {
                                    if (project != null) {
                                        fireAndForget(() =>
                                            openInCode(model, {
                                                projectPath: project.path,
                                                rel: match.path,
                                                line: match.line,
                                            })
                                        );
                                    }
                                }}
                                className="flex cursor-pointer gap-2 px-3 py-[2px] text-[11.5px] hover:bg-accent/10"
                            >
                                <span className="w-[34px] flex-none text-right font-mono text-[10.5px] text-muted">
                                    {match.line}
                                </span>
                                <span className="min-w-0 truncate font-mono text-secondary">{match.text.trim()}</span>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
}
