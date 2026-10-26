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
const FIND_WAIT_MS = 10_000;
const PALETTE_TRIES = 3;
const FIELD = `document.querySelector('[data-sessions-search]')`;
const SEARCH_STUB = "__sessionsSearchStub";
const RETRIED_FLAG = "__sessionsSearchRetried";

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

// the dev app indexes the whole ~/.claude/projects (about 50 s cold), and until then every search reports
// incomplete, which step 5's retried search must not
const INDEX_WAIT_MS = 180_000;
const INDEX_RPC_TIMEOUT_MS = 30_000;
const waitIndexWarm = async (h, query) => {
    const t0 = Date.now();
    for (;;) {
        const r = await h.rpc("searchsessions", { query }, { timeout: INDEX_RPC_TIMEOUT_MS }).catch(() => null);
        if (r != null && !r.incomplete) return true;
        if (Date.now() - t0 > INDEX_WAIT_MS) return false;
        await nap(h, 1000);
    }
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

// what the find bar and its highlights show for the session body keyed key
const findState = (h, key) =>
    h.ev(`(() => {
        const body = document.querySelector('[data-session-key="' + CSS.escape(${JSON.stringify(key)}) + '"]');
        const bar = body?.querySelector('[data-sessions-find]');
        const input = bar?.querySelector('input');
        const current = CSS.highlights.get('sessions-find-current');
        const range = current ? [...current][0] : null;
        const r = range?.getBoundingClientRect();
        const box = body?.getBoundingClientRect();
        return {
            body: body != null,
            pos: bar?.querySelector('[data-find-pos]')?.textContent ?? null,
            focused: input != null && document.activeElement === input,
            all: CSS.highlights.get('sessions-find')?.size ?? null,
            currentText: range ? range.toString() : null,
            visible: !!(r && box && r.height > 0 && r.top >= box.top && r.bottom <= box.bottom),
            inRun: document.querySelector('[role="group"][aria-label="Sessions in this run"]') != null,
        };
    })()`);

const waitFind = async (h, key, pos) => {
    const t0 = Date.now();
    let s = await findState(h, key);
    while (s.pos !== pos && Date.now() - t0 < FIND_WAIT_MS) {
        await nap(h, 250);
        s = await findState(h, key);
    }
    await nap(h, 300);
    return findState(h, key);
};

// Ctrl+P and its Sessions scope, driven on the palette's own input
const PALETTE_INPUT = `document.querySelector('input[data-palette-input]')`;
const PALETTE = `${PALETTE_INPUT}?.closest('[role="dialog"]')`;
const paletteKey = (h, key) =>
    h.ev(`${PALETTE_INPUT}?.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true }))`);
const paletteState = (h) =>
    h.ev(`(() => {
        const d = ${PALETTE};
        if (!d) return null;
        const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        const rows = [...d.querySelectorAll('[role="listbox"] button[data-idx]')];
        return {
            scope: d.querySelector('[data-palette-scope][aria-pressed="true"]')?.getAttribute('data-palette-scope') ?? null,
            rows: rows.map(flat),
            selected: flat(rows.find((b) => b.getAttribute('aria-selected') === 'true')),
        };
    })()`);
const paletteTypes = (h, q) =>
    h.ev(`(() => {
        const el = ${PALETTE_INPUT};
        if (!el) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(q)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
const paletteWhen = async (h, pred, ms) => {
    const t0 = Date.now();
    let s = await paletteState(h);
    while (!(s != null && pred(s)) && Date.now() - t0 < ms) {
        await nap(h, 250);
        s = await paletteState(h);
    }
    return s;
};

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
        const indexWarm = await waitIndexWarm(h, fx.word);
        await stubSearch(h, `async (call) => ({ ...(await call()), incomplete: true })`);
        await typeQuery(h, fx.word);
        const s5a = await waitState(h, (s) => s.incomplete != null && s.cards.length > 0);
        await h.shot("cdp-shots/sessions-search-5-incomplete.png");
        await stubSearch(h, `async () => { throw new Error("stubbed search failure"); }`);
        await typeQuery(h, `${fx.word} `);
        const s5b = await waitState(h, (s) => s.error != null);
        await h.shot("cdp-shots/sessions-search-5-failed.png");
        // the store keeps the failed attempt's stale results while Retry waits out the debounce, so the state
        // alone cannot tell the real reply from them: a pass-through stub flags that the real call answered
        await h.ev(`delete window.${RETRIED_FLAG}`);
        await stubSearch(h, `async (call) => { const r = await call(); window.${RETRIED_FLAG} = true; return r; }`);
        await h.ev(`[...(${LIST}?.querySelectorAll('[data-sessions-search-error] button') ?? [])].find((b) => b.textContent.trim() === 'Retry')?.click()`);
        const t5 = Date.now();
        let retriedReal = await h.ev(`window.${RETRIED_FLAG} === true`);
        while (!retriedReal && Date.now() - t5 < SEARCH_WAIT_MS) {
            await nap(h, 300);
            retriedReal = await h.ev(`window.${RETRIED_FLAG} === true`);
        }
        const s5c = await waitState(h, (s) => s.error == null && s.incomplete == null && s.cards.some((c) => c.key === solo));
        await modEval(h, RESTORE_SEARCH);
        await h.shot("cdp-shots/sessions-search-5-retried.png");
        rec(
            "5. incomplete results say still indexing; a failed search shows Search failed with Retry, and Retry brings the results back",
            indexWarm &&
                retriedReal &&
                s5a.incomplete === "Results may be incomplete — still indexing" &&
                (s5b.error ?? "").startsWith("Search failed") &&
                s5b.retry &&
                s5b.cards.length === 0 &&
                s5c.error == null &&
                s5c.incomplete == null &&
                s5c.cards.some((c) => c.key === solo),
            {
                index: indexWarm ? "warm" : `never finished indexing within ${INDEX_WAIT_MS / 1000} s`,
                incomplete: s5a.incomplete,
                error: s5b.error,
                retry: s5b.retry,
                failedCards: s5b.cards.length,
                retriedReal,
                retried: s5c.cards.map((c) => c.key),
                retriedIncomplete: s5c.incomplete,
            }
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

        // 7. a snippet row opens the transcript at its hit. The solo's rows are its prompt and replies in order, so
        // the second row is its second turn hit; its commit is an event row
        await typeQuery(h, fx.word);
        const s7a = await waitState(h, (s) => (card(s, solo)?.hits.length ?? 0) >= 2 && (card(s, runCard)?.hits.length ?? 0) >= 3);
        await h.ev(`${LIST}?.querySelector('[data-session-row="' + CSS.escape(${JSON.stringify(solo)}) + '"]')?.querySelectorAll('[data-session-hit]')[1]?.click()`);
        const s7 = await waitFind(h, solo, "2 of 4");
        await h.shot("cdp-shots/sessions-search-7-open-hit.png");
        rec(
            "7. clicking the solo's second snippet row opens its transcript with the find bar at 2 of 4 and the current highlight in view",
            s7.body && s7.pos === "2 of 4" && s7.all === 4 && s7.currentText?.toLowerCase() === word && s7.visible,
            { rows: card(s7a, solo)?.hits.length, find: s7 }
        );

        // 8. a worker's snippet row opens the run with the worker in view; the switch is still on from step 3
        const s8a = await searchState(h);
        await h.ev(`${LIST}?.querySelector('[data-session-row="' + CSS.escape(${JSON.stringify(runCard)}) + '"] [data-session-hit="1"]')?.click()`);
        const worker = `claude:${fx.worker.id}`;
        const s8 = await waitFind(h, worker, "1 of 2");
        await h.shot("cdp-shots/sessions-search-8-open-worker.png");
        rec(
            "8. Run agents on: clicking the run card's worker row opens the run with the worker in view and the find bar at 1 of 2",
            !run.arrangeError && s8a.switchChecked === "true" && s8.body && s8.inRun && s8.pos === "1 of 2" && s8.all === 2 && s8.visible,
            { arrangeError: run.arrangeError, switchChecked: s8a.switchChecked, find: s8 }
        );

        // 9. Ctrl+P's Sessions scope: Enter on the solo's row lands on Sessions with the word in the list's field
        await h.ev(`(() => { const el = ${FIELD}; el?.focus(); el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); })()`);
        await waitState(h, (s) => s.query === "");
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`);
        const opened = await paletteWhen(h, () => true, 3000);
        await h.ev(`document.querySelector('[data-palette-scope="sessions"]')?.click()`);
        let found = null;
        // a search answered while the index was still warming may predate the fixtures: ask again
        for (let i = 0; i < PALETTE_TRIES && !found?.rows.some((r) => r.includes(fx.solo.title)); i++) {
            await paletteTypes(h, "");
            await paletteTypes(h, fx.word);
            found = await paletteWhen(h, (s) => s.scope === "sessions" && s.rows.some((r) => r.includes(fx.solo.title)), SEARCH_WAIT_MS / PALETTE_TRIES);
        }
        for (let i = 0; i < (found?.rows.length ?? 0) && !(await paletteState(h))?.selected.includes(fx.solo.title); i++) {
            await paletteKey(h, "ArrowDown");
            await nap(h, 100);
        }
        await h.shot("cdp-shots/sessions-search-9-palette.png");
        await paletteKey(h, "Enter");
        const s9 = await waitFind(h, solo, "1 of 4");
        const s9Field = await searchState(h);
        await h.shot("cdp-shots/sessions-search-9-landed.png");
        rec(
            "9. Ctrl+P > Sessions, type the word, Enter on the solo's row: Sessions shows the word in the list's field and the find bar at 1 of 4",
            opened != null && found != null && s9.body && s9.pos === "1 of 4" && s9.all === 4 && s9Field.query === fx.word,
            { palette: found, query: s9Field.query, find: s9 }
        );

        // 10. a builder check carries its run's id but is a solo: its snippet row opens its own entry, not a run row.
        // The search keeps it only with Run agents on
        const check = `claude:${fx.check.id}`;
        await typeQuery(h, "");
        const s10a = await waitState(h, (s) => s.query === "");
        if (s10a.switchChecked !== "true") {
            await h.ev(`${LIST}?.querySelector('[role="switch"]')?.click()`);
        }
        await typeQuery(h, fx.checkWord);
        const s10b = await waitState(h, (s) => (card(s, check)?.hits.length ?? 0) > 0);
        await clickIn(h, check, "[data-session-hit]");
        const s10 = await waitFind(h, check, "1 of 1");
        await h.shot("cdp-shots/sessions-search-10-open-check.png");
        rec(
            "10. Run agents on: clicking a builder check's snippet row opens its own entry with the find bar at 1 of 1, not a run",
            !run.arrangeError && s10.body && s10.pos === "1 of 1" && !s10.inRun,
            { arrangeError: run.arrangeError, switchChecked: s10b.switchChecked, keys: s10b.cards.map((c) => c.key), check, find: s10 }
        );
        return steps;
    },
    async teardown(h, ctx) {
        if (await h.ev(`!!${PALETTE_INPUT}`).catch(() => false)) {
            await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`).catch(() => {});
        }
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
