// The Sessions list's states, on in-page fixture sessions (nothing is written to disk).
// kit holds scenarios-shared.mjs's sessions helpers (SESSIONS_KIT); the fixtures are in sessions-page-fixtures.mjs.

import { fixtureRun, fixtureSession, installRuns, installSessions, restoreSessions } from "./sessions-page-fixtures.mjs";

const NAME = "sessions-list-states";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const NARROW_VIEWPORT = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
// an unbroken path, longer than any feed row is wide
const WIDE_PATH = `C:\\arc-verify-sessions-fixture\\${"deeply-nested-directory-".repeat(7)}\\file.ts`;
const NINE_TASKS = 9;
const IDLE_MS = 10_000;
const LONG_TASK_BUDGET_MS = 1_000;
const ARCHIVE_WAIT_MS = 60_000;
const WAIT_MS = 5_000;
const POLL_MS = 200;
const SEARCH_STUB = "__sessionsListStatesSearchStub";

const LIST = `document.querySelector('[data-sessions-list]')`;
const FIELD = `document.querySelector('[data-sessions-search]')`;
const card = (key) => `${LIST}?.querySelector('[data-session-row="' + CSS.escape(${JSON.stringify(key)}) + '"]')`;
const nap = (h, ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

// the view model is not on window: the nav rail's fiber props hold it
const WITH_MODEL = `
    const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
    const { globalStore } = await import(names.find((n) => n.endsWith("/app/store/jotaiStore.ts")));
    const nav = document.querySelector('nav');
    const key = nav && Object.keys(nav).find((k) => k.startsWith('__reactFiber$'));
    let model = null;
    for (let f = key ? nav[key] : null; f != null && model == null; f = f.return) {
        if (f.memoizedProps?.model?.sessionsQueryAtom != null) model = f.memoizedProps.model;
    }
    if (model == null) throw new Error("no agents view model on the nav rail");
`;
const withModel = (h, body) => h.ev(`(async () => { ${WITH_MODEL} ${body} })()`);

const until = async (h, expr, ms = WAIT_MS) => {
    const t0 = Date.now();
    let v = await h.ev(expr);
    while (!v && Date.now() - t0 < ms) {
        await nap(h, POLL_MS);
        v = await h.ev(expr);
    }
    return v;
};

const clickFilter = (h, label) =>
    h.ev(`(() => {
        const b = [...(document.querySelectorAll('[role="group"][aria-label="Status filter"] button'))]
            .find((x) => (x.textContent || '').trim().startsWith(${JSON.stringify(label)}));
        b?.click();
        return b != null;
    })()`);
const filterButtons = (h) =>
    h.ev(`[...document.querySelectorAll('[role="group"][aria-label="Status filter"] button')]
        .map((b) => ({ text: (b.textContent || '').trim(), pressed: b.getAttribute('aria-pressed') === 'true' }))`);
const rowKeys = (h) =>
    h.ev(`[...(${LIST}?.querySelectorAll('[data-session-row]') ?? [])].map((c) => c.getAttribute('data-session-row'))`);

const typeQuery = (h, q) =>
    h.ev(`(() => {
        const el = ${FIELD};
        if (!el) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(q)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
// body: an expression for the stub's reply, given the call's args
const stubSearch = (h, body) =>
    h.ev(`(async () => {
        const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
        const { RpcApi } = await import(names.find((n) => n.endsWith("/app/store/wshclientapi.ts")));
        window.${SEARCH_STUB} = true;
        RpcApi.SearchSessionsCommand = (client, data) => (${body})(data);
        return true;
    })()`);
const restoreSearch = (h) =>
    h.ev(`(async () => {
        if (!window.${SEARCH_STUB}) return true;
        const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
        const { RpcApi } = await import(names.find((n) => n.endsWith("/app/store/wshclientapi.ts")));
        delete RpcApi.SearchSessionsCommand;
        delete window.${SEARCH_STUB};
        return true;
    })()`);

// a run's lead and one session per task, all ended, under the run's ids
function runSessions({ run, dag }, title) {
    const lead = fixtureSession({ runid: run.oid, channelid: run.channeloid, role: "lead", task: title });
    const tasks = dag.tasks.map((t) =>
        fixtureSession({ runid: run.oid, channelid: run.channeloid, role: "task", taskid: t.id, task: t.label })
    );
    return [lead, ...tasks];
}

function fixtures() {
    const cancelled = fixtureRun({
        status: "cancelled",
        dagStatus: "cancelled",
        tasks: [
            { id: "t-1", state: "failed" },
            { id: "t-2", state: "done", merged: true },
        ],
    });
    cancelled.dag.title = "Fixture cancelled run";
    const complete = fixtureRun({ status: "done", dagStatus: "done", tasks: [{ id: "t-1", state: "done", merged: true }] });
    complete.dag.title = "Fixture complete run";
    const solo = fixtureSession({ task: "Fixture solo session" });
    const nine = fixtureRun({
        status: "done",
        dagStatus: "done",
        tasks: Array.from({ length: NINE_TASKS }, (_, i) => ({ id: `t-${i + 1}`, state: "done", merged: true })),
    });
    nine.dag.title = "Fixture nine-task run";
    const wide = fixtureSession({
        task: "Fixture wide event session",
        events: [{ type: "committed", ts: Date.now(), text: `Edited ${WIDE_PATH}` }],
    });
    return {
        cancelled,
        complete,
        nine,
        solo,
        sessions: [
            ...runSessions(cancelled, "Fixture cancelled run"),
            ...runSessions(complete, "Fixture complete run"),
            ...runSessions(nine, "Fixture nine-task run"),
            solo,
            wide,
        ],
    };
}

export default function (kit) {
    return [
        {
            name: NAME,
            surface: "sessions",
            async arrange(h) {
                const prior = await withModel(
                    h,
                    `
                    const prior = { project: globalStore.get(model.projectFilterAtom) };
                    globalStore.set(model.projectFilterAtom, "all");
                    globalStore.set(model.sessionsQueryAtom, "");
                    globalStore.set(model.sessionsStatusFilterAtom, "all");
                    globalStore.set(model.sessionsSelAtom, "all");
                    return prior;
                `
                );
                return { prior, fx: fixtures() };
            },
            async assert(h, { fx }) {
                const steps = [];
                const rec = (step, ok, detail) =>
                    steps.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
                await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
                await nap(h, 600);

                // 1. idle on All activity over the real archive: the 1 s clock must not re-derive the archive
                const readArchive = () =>
                    withModel(
                        h,
                        `
                        const names2 = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
                        const store = await import(names2.find((n) => n.endsWith("/app/view/agents/sessionsarchivestore.ts")));
                        const list = globalStore.get(store.sessionsArchiveAtom);
                        return { sessions: list?.length ?? null, complete: list != null && !globalStore.get(store.sessionsIncompleteAtom) };
                    `
                    );
                const t0 = Date.now();
                let archive = await readArchive();
                while (!archive.complete && Date.now() - t0 < ARCHIVE_WAIT_MS) {
                    await nap(h, 500);
                    archive = await readArchive();
                }
                archive.waitedMs = Date.now() - t0;
                const idle = await h.ev(`(async () => {
                    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return { supported: false };
                    const tasks = [];
                    const po = new PerformanceObserver((l) => tasks.push(...l.getEntries().map((e) => Math.round(e.duration))));
                    po.observe({ type: 'longtask' });
                    await new Promise((r) => setTimeout(r, ${IDLE_MS}));
                    po.takeRecords().forEach((e) => tasks.push(Math.round(e.duration)));
                    po.disconnect();
                    return { supported: true, totalMs: tasks.reduce((a, b) => a + b, 0), count: tasks.length, longest: Math.max(0, ...tasks) };
                })()`);
                rec(
                    "an idle 10 s on All activity spends under 1 s in long tasks",
                    idle.supported && idle.totalMs < LONG_TASK_BUDGET_MS,
                    { ...idle, archive }
                );

                // the fixtures replace the archive from here on
                await installRuns(h, [fx.cancelled, fx.complete, fx.nine]);
                await installSessions(h, fx.sessions);
                const cancelledKey = `run:${fx.cancelled.run.oid}`;
                const completeKey = `run:${fx.complete.run.oid}`;
                await until(h, `!!${card(cancelledKey)} && !!${card(completeKey)}`);
                await h.shot(`cdp-shots/${NAME}-1-fixtures.png`);

                // 2. the cancelled run
                const cancelledCard = await h.ev(`(() => {
                    const c = ${card(cancelledKey)};
                    if (!c) return null;
                    const head = c.querySelector('button > span:first-child');
                    return {
                        head: head?.lastElementChild?.textContent?.trim() ?? null,
                        needsRows: c.querySelectorAll('[role="group"][aria-label^="Needs you in"] button').length,
                    };
                })()`);
                const buttons = await filterButtons(h);
                const needsButton = buttons.find((b) => b.text.startsWith("Needs you"))?.text ?? null;
                await clickFilter(h, "Needs you");
                await nap(h, 400);
                const underNeeds = await rowKeys(h);
                await h.shot(`cdp-shots/${NAME}-2-needs.png`);
                rec(
                    "a cancelled run with a failed task reads cancelled, has no needs-you row and is not counted in Needs you",
                    cancelledCard?.head === "cancelled" &&
                        cancelledCard.needsRows === 0 &&
                        needsButton === "Needs you" &&
                        !underNeeds.includes(cancelledKey),
                    { cancelledCard, needsButton, underNeeds }
                );

                // 3. Done
                await clickFilter(h, "Done");
                await nap(h, 400);
                const underDone = await rowKeys(h);
                await h.shot(`cdp-shots/${NAME}-3-done.png`);
                rec(
                    "Done lists a complete run and leaves out the cancelled one",
                    underDone.includes(completeKey) && !underDone.includes(cancelledKey),
                    { underDone }
                );

                // 4. the run card's time
                const meta = await h.ev(`(() => {
                    const c = ${card(completeKey)};
                    return c?.querySelector('button > span:nth-child(2) > span.truncate')?.textContent?.trim() ?? null;
                })()`);
                rec("the run card's time reads ran <n>", /\bran \d+[a-z]+( · |$)/.test(meta ?? ""), { meta });

                // 5. Live with nothing live, then Show all
                await clickFilter(h, "Live");
                await nap(h, 400);
                const liveEmpty = await h.ev(`(() => {
                    const e = ${LIST}?.querySelector('[data-sessions-empty]');
                    return e ? { text: e.textContent.trim(), button: [...e.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null;
                })()`);
                await h.shot(`cdp-shots/${NAME}-5-live-empty.png`);
                await h.ev(`[...(${LIST}?.querySelectorAll('[data-sessions-empty] button') ?? [])].find((b) => b.textContent.trim() === 'Show all')?.click()`);
                await nap(h, 400);
                const afterShowAll = await filterButtons(h);
                const rowsAfter = await rowKeys(h);
                rec(
                    "Live with no live session says No live sessions, and Show all returns to All",
                    (liveEmpty?.text ?? "").startsWith("No live sessions") &&
                        liveEmpty.button.includes("Show all") &&
                        afterShowAll.find((b) => b.pressed)?.text === "All" &&
                        rowsAfter.includes(cancelledKey),
                    { liveEmpty, pressed: afterShowAll.find((b) => b.pressed)?.text, rows: rowsAfter.length }
                );

                // 6. / focuses the search field
                await h.ev(`document.activeElement?.blur?.(), true`);
                await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true, cancelable: true }))`);
                await nap(h, 200);
                const focused = await h.ev(`document.activeElement === ${FIELD}`);
                rec("/ focuses the search field", focused, { focused });

                // 7. a pending search over old results, then a failed one
                const hitSession = JSON.stringify(fx.solo);
                await stubSearch(h, `async () => ({ terms: ["fixture"], results: [{ session: ${hitSession}, hits: [], turnhits: 0, eventhits: 0 }] })`);
                await typeQuery(h, "fixture");
                const shown = await until(h, `!!${card(`claude:${fx.solo.id}`)} && !${LIST}?.querySelector('[data-sessions-search-pending]')`);
                await stubSearch(h, `() => new Promise(() => {})`);
                await typeQuery(h, "fixture solo");
                await until(h, `!!${LIST}?.querySelector('[data-sessions-search-pending]')`);
                // the dim is an opacity transition: read it once settled
                await nap(h, 500);
                const pending = await h.ev(`(() => {
                    const g = ${LIST}?.querySelector('[data-sessions-search-pending]');
                    return g ? { opacity: getComputedStyle(g).opacity, oldCard: !!g.querySelector('[data-session-row]') } : null;
                })()`);
                await h.shot(`cdp-shots/${NAME}-7-pending.png`);
                rec(
                    "a pending search dims the old results",
                    shown && pending?.oldCard && Math.abs(Number(pending.opacity) - 0.6) < 0.01,
                    { shown, pending }
                );
                await stubSearch(h, `async () => { throw new Error("stubbed search failure"); }`);
                await typeQuery(h, "fixture session");
                await until(h, `!!${LIST}?.querySelector('[data-sessions-search-error]')`);
                const error = await h.ev(`${LIST}?.querySelector('[data-sessions-search-error] span')?.textContent?.trim() ?? null`);
                await h.shot(`cdp-shots/${NAME}-7-failed.png`);
                rec("a failed search names its reason", (error ?? "").startsWith("Search failed:") && error.includes("stubbed search failure"), {
                    error,
                });

                // 8. the window the list covers
                const fact = await h.ev(`[...document.querySelectorAll('span')].some((s) => s.textContent.trim() === 'last 30 days')`);
                rec("the toolbar says last 30 days", fact, { fact });

                // 9. the feed and a full run card at the narrow and the wide viewport
                await withModel(
                    h,
                    `globalStore.set(model.sessionsQueryAtom, "");
                    globalStore.set(model.sessionsStatusFilterAtom, "all");
                    globalStore.set(model.sessionsSelAtom, "all");
                    return true;`
                );
                const nineKey = `run:${fx.nine.run.oid}`;
                await until(h, `!!${card(nineKey)} && !!document.querySelector('[data-sessions-feed-row]')`);
                // the landed span, the segment strip and the trailing text of the nine-task card
                const readCard = () =>
                    h.ev(`(() => {
                        const c = ${card(nineKey)};
                        const row = c?.querySelector('button > span:nth-child(2)');
                        if (!row) return null;
                        const landed = [...row.children].find((s) => s.textContent.includes('9/9 landed'));
                        const strip = row.firstElementChild;
                        const trail = row.querySelector('span.truncate');
                        const lr = landed?.getBoundingClientRect();
                        const sr = strip?.getBoundingClientRect();
                        return {
                            landed: landed?.textContent.trim() ?? null,
                            landedHeight: lr?.height ?? null,
                            fontSize: landed ? parseFloat(getComputedStyle(landed).fontSize) : null,
                            stripRight: sr?.right ?? null,
                            landedLeft: lr?.left ?? null,
                            trail: trail?.textContent.replace(/^\\S+\\s/, '').trim() ?? null,
                        };
                    })()`);
                const cardOk = (c) =>
                    c != null &&
                    c.landed === "9/9 landed" &&
                    c.landedHeight < c.fontSize * 2 &&
                    c.stripRight <= c.landedLeft &&
                    /^ran \d+[a-z]+/.test(c.trail ?? "");
                for (const [label, vp] of [
                    ["1000x700", NARROW_VIEWPORT],
                    ["1600x950", VIEWPORT],
                ]) {
                    await h.cdp("Emulation.setDeviceMetricsOverride", vp);
                    await nap(h, 600);
                    const run = await readCard();
                    await h.shot(`cdp-shots/${NAME}-9-run-card-${label}.png`);
                    rec(
                        `at ${label} a 9/9 run card keeps landed on one line and its trailing text leads with the elapsed time`,
                        cardOk(run),
                        run
                    );
                    if (vp === NARROW_VIEWPORT) {
                        const feed = await h.ev(`(() => {
                            const f = document.querySelector('[data-sessions-feed]');
                            const wide = [...document.querySelectorAll('[data-sessions-feed-row]')]
                                .find((r) => r.textContent.includes(${JSON.stringify(WIDE_PATH.slice(0, 40))}));
                            return f ? { scrollWidth: f.scrollWidth, clientWidth: f.clientWidth, wideRow: wide != null } : null;
                        })()`);
                        await h.shot(`cdp-shots/${NAME}-9-feed-${label}.png`);
                        rec(
                            "at 1000x700 a feed event with an unbroken 150-character path does not scroll the feed sideways",
                            feed?.wideRow === true && feed.scrollWidth <= feed.clientWidth,
                            feed
                        );
                    }
                }
                return steps;
            },
            async teardown(h, { prior }) {
                await h.cdp("Emulation.clearDeviceMetricsOverride", {});
                await restoreSearch(h);
                await withModel(
                    h,
                    `
                    globalStore.set(model.sessionsQueryAtom, "");
                    globalStore.set(model.sessionsStatusFilterAtom, "all");
                    globalStore.set(model.sessionsSelAtom, "all");
                    globalStore.set(model.projectFilterAtom, ${JSON.stringify(prior?.project ?? "all")});
                    return true;
                `
                );
                await restoreSessions(h);
            },
        },
    ];
}
