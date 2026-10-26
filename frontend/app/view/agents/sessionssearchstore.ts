// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Sessions list's search: one SearchSessions call per settled query, debounced as the user types. A response
// for an older query than the latest is dropped, so a slow search never overwrites a newer one.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useRef, useState } from "react";
import { isSearchQuery } from "./sessionssearch";

const DEBOUNCE_MS = 250;
// a search may wait on the index reading transcripts
const SEARCH_TIMEOUT_MS = 30_000;

interface SearchState {
    results: SessionSearchResult[] | null; // null = no search done for the current query
    terms: string[];
    incomplete: boolean;
    loading: boolean;
    error: string | null;
}

const IDLE: SearchState = { results: null, terms: [], incomplete: false, loading: false, error: null };

export function useSessionsSearch(query: string, runAgents: boolean): SearchState & { retry: () => void } {
    const [state, setState] = useState<SearchState>(IDLE);
    const [attempt, setAttempt] = useState(0);
    const seq = useRef(0);

    useEffect(() => {
        const mine = ++seq.current;
        if (!isSearchQuery(query)) {
            setState(IDLE);
            return;
        }
        setState((s) => ({ ...s, loading: true, error: null }));
        const t = setTimeout(async () => {
            try {
                const rtn = await RpcApi.SearchSessionsCommand(
                    TabRpcClient,
                    { query, runagents: runAgents },
                    { timeout: SEARCH_TIMEOUT_MS }
                );
                if (mine === seq.current) {
                    setState({
                        results: rtn.results ?? [],
                        terms: rtn.terms ?? [],
                        incomplete: !!rtn.incomplete,
                        loading: false,
                        error: null,
                    });
                }
            } catch (e) {
                if (mine === seq.current) {
                    setState((s) => ({ ...s, loading: false, error: String((e as Error)?.message ?? e) }));
                }
            }
        }, DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [query, runAgents, attempt]);

    return { ...state, retry: () => setAttempt((n) => n + 1) };
}
