// The Sessions list: every session of 30 days in pages, and its search field, Run agents switch and result cards.
// kit holds scenarios.mjs's sessions helpers (SESSIONS_KIT); the fixtures are in sessions-search-fixtures.mjs.

import { removeSessionsSearchFixtures, seedSessionsSearchRun, writeSessionsSearchFixtures } from "./sessions-search-fixtures.mjs";

const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const LIST_PAGE = 60;
const FEED_PAGE = 200;
const COMPLETE_WAIT_MS = 120_000;

// an app module, imported from the URL the app loaded it from so the import is the app's instance
const MOD = `
    const mod = async (path) => {
        const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
        const hit = names.filter((n) => n.endsWith("/" + path)).pop();
        const base = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
        if (hit == null && base == null) throw new Error("no app module url for " + path);
        return import(hit ?? base.replace("app/store/jotaiStore.ts", path));
    };
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const store = await mod("app/view/agents/sessionsarchivestore.ts");
`;
const modEval = (h, body) => h.ev(`(async () => { ${MOD} ${body} })()`);
const RESTORE_INCOMPLETE = `globalStore.set(store.sessionsIncompleteAtom, window.__sessionsListPriorIncomplete ?? false); delete window.__sessionsListPriorIncomplete;`;
const nap = (h, ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

const LIST = `document.querySelector('[data-sessions-list]')`;
const CARDS = `[...(${LIST}?.querySelectorAll('[data-session-row]') ?? [])]`;
// every row the list holds, rendered or not: the list's j/k ids less the pinned "All activity"
const listState = (h) =>
    modEval(
        h,
        `
        const { listNavAtom } = await mod("app/store/keybindings/listnav.ts");
        const nav = globalStore.get(listNavAtom);
        const list = ${LIST};
        const cards = ${CARDS};
        const cursor = nav?.cursorId ?? null;
        const card = cursor ? cards.find((c) => c.getAttribute('data-session-row') === cursor) : null;
        const lr = list?.getBoundingClientRect();
        const cr = card?.getBoundingClientRect();
        return {
            total: nav?.surface === 'sessions' ? nav.navigableIds.length - 1 : -1,
            rendered: cards.length,
            cursor,
            cursorRendered: card != null,
            cursorInView: !!(lr && cr && cr.top >= lr.top - 1 && cr.bottom <= lr.bottom + 1),
        };
    `
    );
const scrollToEnd = async (h, sel) => {
    await h.ev(`(() => { const el = document.querySelector('${sel}'); if (el) el.scrollTop = el.scrollHeight; })()`);
    await nap(h, 800);
};
// a fresh mount: the page count is the surface's own state, so leaving and coming back resets it
const remount = async (h) => {
    await h.goto("cockpit");
    await h.goto("sessions");
    await nap(h, 600);
};

const sessionsList = {
    name: "sessions-list",
    surface: "sessions",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        const skip = (step, detail) => steps.push({ step, skip: true, detail });
        await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
        // start from All activity and the All status filter, so the cursor sits above the first page
        await h.ev(`[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('All activity'))?.click()`);
        await h.ev(`document.querySelector('[role="group"][aria-label="Status filter"] button')?.click()`);
        await remount(h);

        // 1. the loading line, while the archive reads as incomplete
        const loading = await modEval(
            h,
            `
            window.__sessionsListPriorIncomplete = globalStore.get(store.sessionsIncompleteAtom);
            globalStore.set(store.sessionsIncompleteAtom, true);
            await new Promise((r) => setTimeout(r, 300));
            return document.querySelector('[data-sessions-loading]')?.textContent?.trim() ?? null;
        `
        );
        await h.shot("cdp-shots/sessions-list-1-loading.png");
        await modEval(h, RESTORE_INCOMPLETE);
        rec("1. an incomplete archive shows Loading older sessions… at the list's end", loading === "Loading older sessions…", { loading });

        // 2. the archive completes
        const t0 = Date.now();
        let complete = false;
        while (Date.now() - t0 < COMPLETE_WAIT_MS) {
            complete = await modEval(h, `return globalStore.get(store.sessionsArchiveAtom) != null && !globalStore.get(store.sessionsIncompleteAtom);`);
            if (complete) break;
            await nap(h, 1000);
        }
        const loadingGone = await h.ev(`document.querySelector('[data-sessions-loading]') == null`);
        await h.shot("cdp-shots/sessions-list-2-complete.png");
        rec("2. the archive completes and the loading line goes", complete && loadingGone, {
            complete,
            loadingGone,
            waitedMs: Date.now() - t0,
        });

        // 3. the first page, then more on scrolling to the end
        const first = await listState(h);
        await h.shot("cdp-shots/sessions-list-3-first-page.png");
        const firstOk = first.total >= 0 && first.rendered === Math.min(first.total, LIST_PAGE);
        if (first.total > LIST_PAGE) {
            await scrollToEnd(h, "[data-sessions-list]");
            const grown = await listState(h);
            await h.shot("cdp-shots/sessions-list-3-grown.png");
            rec(`3. the list renders ${LIST_PAGE} of its rows, and more after scrolling to the end`, firstOk && grown.rendered > first.rendered, {
                total: first.total,
                first: first.rendered,
                grown: grown.rendered,
            });
        } else {
            rec(`3. the list renders all its rows when it holds ${LIST_PAGE} or fewer`, firstOk, first);
            skip(`3b. scrolling to the end renders more`, `this machine holds ${first.total} sessions; seed more than ${LIST_PAGE} to page`);
        }

        // 4. j past the last rendered card grows the page and brings the cursor's card into view
        if (first.total > LIST_PAGE) {
            await remount(h);
            const before = await listState(h);
            await h.ev(`(() => { const c = ${CARDS}.at(-1); (c?.matches('button') ? c : c?.querySelector('button'))?.click(); })()`);
            await nap(h, 300);
            // the last card scrolls to the list's bottom edge with the sentinel just past it, so the page is
            // still one page here and only the j can grow it
            const atLast = await listState(h);
            await h.ev(
                `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true, cancelable: true }))`
            );
            await nap(h, 800);
            const after = await listState(h);
            await h.shot("cdp-shots/sessions-list-4-j-past-page.png");
            const ok =
                before.rendered === LIST_PAGE &&
                atLast.rendered === LIST_PAGE &&
                atLast.cursorRendered &&
                after.cursor !== atLast.cursor &&
                after.rendered > LIST_PAGE &&
                after.cursorRendered &&
                after.cursorInView;
            rec("4. j past the last rendered card grows the page; the cursor's card renders in view", ok, { before: before.rendered, atLast, after });
        } else {
            skip("4. j past the last rendered card grows the page", `this machine holds ${first.total} sessions; seed more than ${LIST_PAGE} to page`);
        }

        // 5. All activity renders its first page of events and grows the same way
        await h.ev(`[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('All activity'))?.click()`);
        await nap(h, 600);
        const feedState = () =>
            h.ev(`(() => {
                const f = document.querySelector('[data-sessions-feed]');
                const head = [...(f?.querySelectorAll('span') ?? [])].find((s) => / events$/.test((s.textContent || '').trim()));
                return { total: head ? parseInt(head.textContent, 10) : -1, rendered: f?.querySelectorAll('[data-sessions-feed-row]').length ?? -1 };
            })()`);
        const feed = await feedState();
        await h.shot("cdp-shots/sessions-list-5-feed.png");
        const feedOk = feed.total >= 0 && feed.rendered === Math.min(feed.total, FEED_PAGE);
        if (feed.total > FEED_PAGE) {
            await scrollToEnd(h, "[data-sessions-feed]");
            const grown = await feedState();
            await h.shot("cdp-shots/sessions-list-5-feed-grown.png");
            rec(`5. All activity renders ${FEED_PAGE} events, and more after scrolling to the end`, feedOk && grown.rendered > feed.rendered, {
                total: feed.total,
                first: feed.rendered,
                grown: grown.rendered,
            });
        } else {
            rec(`5. All activity renders all its events when it holds ${FEED_PAGE} or fewer`, feedOk, feed);
            skip("5b. scrolling All activity to the end renders more", `this machine holds ${feed.total} events; seed more than ${FEED_PAGE} to page`);
        }
        return steps;
    },
    // step 1 restores the atom; this covers an assert that threw between setting and restoring it
    async teardown(h) {
        if (await h.ev(`window.__sessionsListPriorIncomplete !== undefined`)) {
            await modEval(h, RESTORE_INCOMPLETE);
        }
    },
};

// a search waits out the debounce and, before Task 3's warm-up finishes, the index reading transcripts
const SEARCH_WAIT_MS = 30_000;
const FIELD = `document.querySelector('[data-sessions-search]')`;
const SEARCH_STUB = "__sessionsSearchStub";

// a controlled React input takes a value through the native setter and an input event
const typeQuery = (h, q) =>
    h.ev(`(() => {
        const el = ${FIELD};
        if (!el) return false;
        el.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(q)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);

const searchState = (h) =>
    h.ev(`(() => {
        const list = ${LIST};
        const text = (sel) => list?.querySelector(sel)?.textContent?.trim() ?? null;
        return {
            query: ${FIELD}?.value ?? null,
            summary: text('[data-sessions-search-summary]') ?? '',
            incomplete: text('[data-sessions-search-incomplete]'),
            error: text('[data-sessions-search-error]'),
            retry: [...(list?.querySelectorAll('[data-sessions-search-error] button') ?? [])].some((b) => b.textContent.trim() === 'Retry'),
            empty: text('[data-sessions-search-empty]'),
            switchChecked: list?.querySelector('[role="switch"]')?.getAttribute('aria-checked') ?? null,
            cards: [...(list?.querySelectorAll('[data-session-row]') ?? [])].map((c) => ({
                key: c.getAttribute('data-session-row'),
                hits: [...c.querySelectorAll('[data-session-hit]')].map((b) => ({
                    who: b.getAttribute('data-session-hit'),
                    mark: b.querySelector('mark')?.textContent ?? null,
                })),
                more: c.querySelector('[data-session-hits-more]')?.textContent?.trim() ?? null,
            })),
        };
    })()`);

const waitState = async (h, pred) => {
    const t0 = Date.now();
    let s = await searchState(h);
    while (!pred(s) && Date.now() - t0 < SEARCH_WAIT_MS) {
        await nap(h, 300);
        s = await searchState(h);
    }
    return s;
};

const clickIn = (h, rowKey, sel) =>
    h.ev(`${LIST}?.querySelector('[data-session-row="' + CSS.escape(${JSON.stringify(rowKey)}) + '"] ${sel}')?.click()`);

// the app's RpcApi instance answers SearchSessions through `body` (an async function of the real call's promise)
const stubSearch = (h, body) =>
    modEval(
        h,
        `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const real = Object.getPrototypeOf(RpcApi).SearchSessionsCommand;
        window.${SEARCH_STUB} = true;
        RpcApi.SearchSessionsCommand = (...args) => (${body})(() => real.apply(RpcApi, args));
        return true;
    `
    );
const RESTORE_SEARCH = `const { RpcApi } = await mod("app/store/wshclientapi.ts"); delete RpcApi.SearchSessionsCommand; delete window.${SEARCH_STUB}; return true;`;

const sessionsSearch = (kit) => ({
    name: "sessions-search",
    surface: "sessions",
    async arrange(h) {
        const fx = writeSessionsSearchFixtures();
        const run = await seedSessionsSearchRun(h, kit, fx);
        return { fx, run };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        const { fx, run } = ctx;
        const solo = `claude:${fx.solo.id}`;
        const other = `claude:${fx.other.id}`;
        const runCard = run.runId ? `run:${run.runId}` : null;
        const card = (s, key) => s.cards.find((c) => c.key === key);
        await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
        await h.ev(`document.querySelector('[role="group"][aria-label="Status filter"] button')?.click()`);
        await remount(h);

        // 1. the fixture word narrows the list to the solo card and the run card
        await typeQuery(h, fx.word);
        const s1 = await waitState(h, (s) => s.summary === "2 sessions · 6 matches");
        await h.shot("cdp-shots/sessions-search-1-narrowed.png");
        const keys1 = s1.cards.map((c) => c.key);
        rec(
            "1. typing the fixture word leaves the solo and run cards; the summary reads 2 sessions · 6 matches",
            !run.arrangeError && s1.summary === "2 sessions · 6 matches" && keys1.length === 2 && keys1.includes(solo) && keys1.includes(runCard) && !keys1.includes(other),
            { arrangeError: run.arrangeError, summary: s1.summary, keys: keys1, solo, runCard, other }
        );

        // 2. the solo card lists 3 snippet rows and 2 more; expanding shows all 5. The run card has its lead's row
        const soloBefore = card(s1, solo);
        await clickIn(h, solo, "[data-session-hits-more]");
        await nap(h, 300);
        const s2 = await searchState(h);
        await h.shot("cdp-shots/sessions-search-2-snippets.png");
        const soloAfter = card(s2, solo);
        const word = fx.word.toLowerCase();
        rec(
            "2. the solo card shows 3 highlighted snippet rows and 2 more matches, then 5; the run card shows a lead row",
            soloBefore?.hits.length === 3 &&
                soloBefore.hits.every((x) => x.mark?.toLowerCase() === word) &&
                soloBefore.more === "2 more matches" &&
                soloAfter?.hits.length === 5 &&
                soloAfter.more == null &&
                !!card(s2, runCard)?.hits.some((x) => x.who === "lead"),
            { soloBefore, soloAfter, run: card(s2, runCard) }
        );

        // 3. Run agents folds the worker's hits onto the run card
        await h.ev(`${LIST}?.querySelector('[role="switch"]')?.click()`);
        const s3 = await waitState(h, (s) => s.summary === "2 sessions · 8 matches");
        await h.shot("cdp-shots/sessions-search-3-run-agents.png");
        const runHits = card(s3, runCard)?.hits ?? [];
        rec(
            "3. Run agents on: the switch is checked, the run card gains the worker's rows, and the summary reads 2 sessions · 8 matches",
            s3.switchChecked === "true" && s3.summary === "2 sessions · 8 matches" && runHits.filter((x) => x.who === "1").length === 2,
            { switchChecked: s3.switchChecked, summary: s3.summary, runHits }
        );

        // 4. a word in no session
        await typeQuery(h, fx.absent);
        const s4 = await waitState(h, (s) => s.empty != null);
        await h.shot("cdp-shots/sessions-search-4-no-match.png");
        const emptyText = `No sessions match “${fx.absent}”.`;
        rec("4. a word in no session shows No sessions match", s4.empty === emptyText && s4.cards.length === 0, { empty: s4.empty, cards: s4.cards.length });

        // 5. an incomplete index says so; a failed search shows Search failed and Retry, which recovers
        await stubSearch(h, `async (call) => ({ ...(await call()), incomplete: true })`);
        await typeQuery(h, fx.word);
        const s5a = await waitState(h, (s) => s.incomplete != null && s.cards.length > 0);
        await h.shot("cdp-shots/sessions-search-5-incomplete.png");
        await stubSearch(h, `async () => { throw new Error("stubbed search failure"); }`);
        await typeQuery(h, `${fx.word} `);
        const s5b = await waitState(h, (s) => s.error != null);
        await h.shot("cdp-shots/sessions-search-5-failed.png");
        await modEval(h, RESTORE_SEARCH);
        await h.ev(`[...(${LIST}?.querySelectorAll('[data-sessions-search-error] button') ?? [])].find((b) => b.textContent.trim() === 'Retry')?.click()`);
        const s5c = await waitState(h, (s) => s.error == null && s.cards.some((c) => c.key === solo));
        await h.shot("cdp-shots/sessions-search-5-retried.png");
        rec(
            "5. incomplete results say still indexing; a failed search shows Search failed with Retry, and Retry brings the results back",
            s5a.incomplete === "Results may be incomplete — still indexing" &&
                (s5b.error ?? "").startsWith("Search failed") &&
                s5b.retry &&
                s5b.cards.length === 0 &&
                s5c.error == null &&
                s5c.incomplete == null &&
                s5c.cards.some((c) => c.key === solo),
            { incomplete: s5a.incomplete, error: s5b.error, retry: s5b.retry, failedCards: s5b.cards.length, retried: s5c.cards.map((c) => c.key) }
        );

        // 6. Escape in the field clears the query and the full list returns
        await h.ev(`(() => { const el = ${FIELD}; el?.focus(); el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); })()`);
        const s6 = await waitState(h, (s) => s.query === "" && s.cards.some((c) => c.key === other));
        const list6 = await listState(h);
        await h.shot("cdp-shots/sessions-search-6-cleared.png");
        rec(
            "6. Escape in the field clears it and the full list returns",
            s6.query === "" && s6.summary === "" && s6.cards.some((c) => c.key === other) && s6.cards.every((c) => c.hits.length === 0),
            { query: s6.query, summary: s6.summary, rendered: s6.cards.length, total: list6.total }
        );
        return steps;
    },
    async teardown(h, ctx) {
        if (await h.ev(`window.${SEARCH_STUB} === true`)) {
            await modEval(h, RESTORE_SEARCH);
        }
        try {
            await kit.teardownFixtureRun(h, ctx.run ?? {}, "sessions-search");
        } finally {
            removeSessionsSearchFixtures(ctx.fx);
        }
    },
});

export default function (kit) {
    return [sessionsList, sessionsSearch(kit)];
}
