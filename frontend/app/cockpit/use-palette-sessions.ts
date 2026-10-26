// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Sessions scope's search of what was said: the same SearchSessions call as the Sessions list, without run
// agents, made only while the scope is showing.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useRef, useState } from "react";
import { errorText } from "./palette-action";
import { searchesSessions } from "./palette-items";

const DEBOUNCE_MS = 250;
// a cold index reads every transcript of the window once
const SEARCH_TIMEOUT_MS = 30_000;

export interface PaletteSessions {
    results: SessionSearchResult[] | null; // null: the current query has no answer yet, or does not search
    terms: string[];
    incomplete: boolean;
    error: string | undefined;
}

interface Answer {
    query: string;
    rtn?: CommandSearchSessionsRtnData;
    error?: string;
}

export function usePaletteSessions(open: boolean, inSessions: boolean, query: string): PaletteSessions {
    const [answer, setAnswer] = useState<Answer | null>(null);
    const latest = useRef(0);
    const active = open && inSessions && searchesSessions(query);

    useEffect(() => {
        // a new query, or leaving the scope, drops whatever is still in flight
        const id = ++latest.current;
        if (!active) {
            setAnswer(null);
            return;
        }
        const timer = setTimeout(() => {
            RpcApi.SearchSessionsCommand(
                TabRpcClient,
                { query, runagents: false },
                { timeout: SEARCH_TIMEOUT_MS }
            ).then(
                (rtn) => id === latest.current && setAnswer({ query, rtn }),
                (e) =>
                    id === latest.current &&
                    setAnswer({ query, error: `Session search failed: ${errorText(String(e))}` })
            );
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [active, query]);

    const current = active && answer?.query === query ? answer : null;
    return {
        results: current?.rtn?.results ?? (current?.error != null ? [] : null),
        terms: current?.rtn?.terms ?? [],
        incomplete: current?.rtn?.incomplete ?? false,
        error: current?.error,
    };
}
