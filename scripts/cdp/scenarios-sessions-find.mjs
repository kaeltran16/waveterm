// Opening a session at a search hit: the find bar over the transcript and the highlighted activity event.
// kit holds scenarios.mjs's sessions helpers (SESSIONS_KIT); the fixtures are in sessions-search-fixtures.mjs.
//
// The hits come from the real searchsessions RPC and open through openSessionHit, imported from the URL the app
// loaded it from so it acts on the app's own model, not through the list or the palette.
import { setTimeout as delay } from "node:timers/promises";
import { removeSessionsSearchFixtures, seedSessionsSearchRun, writeSessionsSearchFixtures } from "./sessions-search-fixtures.mjs";

const NAME = "sessions-find";
const SEARCH_TIMEOUT_MS = 30_000;
// the index may still be warming after a restart; the fixtures are the newest sessions, so they come first
const SEARCH_WAIT_MS = 60_000;

// the app's module instance at path (under frontend/), the model the cockpit's UI route serves, and a poll
const PAGE_LIB = `
    const mod = async (path) => {
        const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
        const hit = names.filter((n) => n.endsWith("/" + path)).pop();
        const base = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
        if (hit == null && base == null) throw new Error("no app module url for " + path);
        return import(hit ?? base.replace("app/store/jotaiStore.ts", path));
    };
    const model = (await mod("app/store/wshrpcutil.ts")).DefaultRouter.routeMap.get("cockpit")?.model;
    if (model == null) throw new Error("the cockpit route serves no model");
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 10000) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await nap(150)) if (fn()) return true;
        return !!fn();
    };
`;
const pageEval = (h, body) => h.ev(`(async () => { ${PAGE_LIB} ${body} })()`);

// what the find bar and its highlights show for the session body keyed key
const READ_FIND = (key) => `
    const body = document.querySelector('[data-session-key=${JSON.stringify(key)}]');
    const bar = body?.querySelector("[data-sessions-find]");
    const input = bar?.querySelector("input");
    const all = CSS.highlights.get("sessions-find");
    const current = CSS.highlights.get("sessions-find-current");
    const range = current ? [...current][0] : null;
    let visible = false;
    if (range && body) {
        const r = range.getBoundingClientRect();
        const box = body.getBoundingClientRect();
        visible = r.height > 0 && r.top >= box.top && r.bottom <= box.bottom;
    }
    const read = () => ({
        body: body != null,
        bar: bar != null,
        pos: bar?.querySelector("[data-find-pos]")?.textContent ?? null,
        focused: input != null && document.activeElement === input,
        all: all?.size ?? null,
        current: current?.size ?? null,
        currentText: range ? range.toString() : null,
        visible,
    });
`;

export default function (kit) {
    async function search(h, word) {
        const t0 = Date.now();
        for (;;) {
            const r = await h.rpc(
                "searchsessions",
                { query: word, runagents: true },
                { timeout: SEARCH_TIMEOUT_MS }
            );
            const results = r?.results ?? [];
            if ((results.length >= 3 && !r.incomplete) || Date.now() - t0 > SEARCH_WAIT_MS) {
                return { terms: r?.terms ?? [], results, incomplete: !!r?.incomplete };
            }
            await delay(1000);
        }
    }

    // opens r at hit (null = openSessionHit's default) under query/terms, then reads the find bar of key once
    // ready says so
    const openAt = (h, r, query, terms, hit, key, ready) =>
        pageEval(
            h,
            `
            const { openSessionHit } = await mod("app/view/agents/sessionsfind.ts");
            openSessionHit(model, ${JSON.stringify(r)}, ${JSON.stringify(query)}, ${JSON.stringify(terms)}, ${
                hit == null ? "undefined" : JSON.stringify(hit)
            });
            let s;
            await until(() => {
                ${READ_FIND(key)}
                s = read();
                return ${ready};
            });
            await nap(200);
            ${READ_FIND(key)}
            return read();
        `
        );

    // a key on the find bar's input as the input receives it (CDP key events may never reach the WebView)
    const keyInFind = (h, key, shift, ready) =>
        pageEval(
            h,
            `
            const input = document.querySelector("[data-sessions-find] input");
            input?.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, shiftKey: ${!!shift}, bubbles: true, cancelable: true }));
            await until(() => ${ready}, 3000);
            return document.querySelector("[data-sessions-find] [data-find-pos]")?.textContent ?? null;
        `
        );
    const posIs = (text) => `document.querySelector("[data-sessions-find] [data-find-pos]")?.textContent === ${JSON.stringify(text)}`;
    const clickFind = (h, label, ready) =>
        pageEval(
            h,
            `
            document.querySelector('[data-sessions-find] button[aria-label=${JSON.stringify(label)}]')?.click();
            await until(() => ${ready}, 3000);
            return document.querySelector("[data-sessions-find] [data-find-pos]")?.textContent ?? null;
        `
        );

    return [
        {
            name: NAME,
            surface: "cockpit",
            async arrange(h) {
                const fx = writeSessionsSearchFixtures();
                const run = await seedSessionsSearchRun(h, kit, fx);
                return { fx, run };
            },
            async assert(h, { fx, run }) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: JSON.stringify(detail) });
                const solo = `claude:${fx.solo.id}`;
                const worker = `claude:${fx.worker.id}`;

                const found = await search(h, fx.word);
                const soloR = found.results.find((r) => r.session.id === fx.solo.id);
                const workerR = found.results.find((r) => r.session.id === fx.worker.id);
                const soloTurns = soloR?.hits.filter((x) => x.kind === "turn") ?? [];
                const soloEvent = soloR?.hits.find((x) => x.kind === "event");

                // 1. the solo at its second turn hit
                const s1 =
                    soloTurns.length >= 2
                        ? await openAt(h, soloR, fx.word, found.terms, soloTurns[1], solo, `s.pos === "2 of 4"`)
                        : null;
                await h.shot(`cdp-shots/${NAME}-1-second-hit.png`);
                rec(
                    "1. opening the solo at its second turn hit: the find bar is focused and reads 2 of 4, 4 matches are painted and 1 current, inside the visible scroll box",
                    s1 != null &&
                        s1.pos === "2 of 4" &&
                        s1.focused &&
                        s1.all === 4 &&
                        s1.current === 1 &&
                        s1.currentText?.toLowerCase() === fx.word &&
                        s1.visible,
                    { search: { terms: found.terms, incomplete: found.incomplete, turnhits: soloR?.turnhits }, find: s1 }
                );

                // 2. Enter and Shift+Enter in the bar, then its buttons
                const enter = await keyInFind(h, "Enter", false, posIs("3 of 4"));
                await keyInFind(h, "Enter", true, posIs("2 of 4"));
                const back = await keyInFind(h, "Enter", true, posIs("1 of 4"));
                const next = await clickFind(h, "Next match", posIs("2 of 4"));
                const prev = await clickFind(h, "Previous match", posIs("1 of 4"));
                const wrap = await clickFind(h, "Previous match", posIs("4 of 4"));
                const s2 = await pageEval(h, `${READ_FIND(solo)} return read();`);
                await h.shot(`cdp-shots/${NAME}-2-stepped.png`);
                rec(
                    "2. Enter moves to 3 of 4 and Shift+Enter twice to 1 of 4; Next and Previous step the same way, and Previous from 1 wraps to 4",
                    enter === "3 of 4" &&
                        back === "1 of 4" &&
                        next === "2 of 4" &&
                        prev === "1 of 4" &&
                        wrap === "4 of 4" &&
                        s2.current === 1 &&
                        s2.visible,
                    { enter, back, next, prev, wrap, find: s2 }
                );

                // 3. the solo's event hit: the Activity view with the commit event marked
                const s3 = soloEvent
                    ? await pageEval(
                          h,
                          `
                        const { openSessionHit } = await mod("app/view/agents/sessionsfind.ts");
                        openSessionHit(model, ${JSON.stringify(soloR)}, ${JSON.stringify(fx.word)}, ${JSON.stringify(found.terms)}, ${JSON.stringify(soloEvent)});
                        const body = () => document.querySelector('[data-session-key=${JSON.stringify(solo)}]');
                        await until(() => body()?.querySelector('[aria-current="true"]') != null);
                        await nap(300);
                        const marked = [...(body()?.querySelectorAll('[aria-current="true"]') ?? [])];
                        const view = document.querySelector('[aria-label="Session view"] [aria-pressed="true"]')?.textContent ?? null;
                        const r = marked[0]?.getBoundingClientRect();
                        const box = body()?.getBoundingClientRect();
                        return {
                            view,
                            marked: marked.length,
                            text: (marked[0]?.textContent ?? "").replace(/\\s+/g, " ").trim(),
                            visible: r != null && box != null && r.top >= box.top && r.bottom <= box.bottom,
                        };
                    `
                      )
                    : null;
                await h.shot(`cdp-shots/${NAME}-3-event.png`);
                rec(
                    "3. opening the solo's event hit shows the Activity view with the commit event marked and in view",
                    s3 != null &&
                        s3.view === "Activity" &&
                        s3.marked === 1 &&
                        s3.text.includes(fx.word) &&
                        /committed/i.test(s3.text) &&
                        s3.visible,
                    { event: soloEvent, marks: s3 }
                );

                // 4. the worker's first hit: the run's detail with the worker in view
                const s4 = workerR?.hits?.length
                    ? await openAt(h, workerR, fx.word, found.terms, workerR.hits[0], worker, `s.pos === "1 of 2"`)
                    : null;
                const inRun = await h.ev(
                    `document.querySelector('[role="group"][aria-label="Sessions in this run"]') != null`
                );
                await h.shot(`cdp-shots/${NAME}-4-worker.png`);
                rec(
                    "4. opening the worker's first hit shows the run's detail with the worker's session in view and the find bar at 1 of 2",
                    run.arrangeError == null && s4 != null && inRun && s4.body && s4.pos === "1 of 2" && s4.all === 2,
                    { arrangeError: run.arrangeError, worker: workerR?.session, find: s4, inRun }
                );

                // 5. a term the transcript does not hold
                const s5 = soloR
                    ? await openAt(h, soloR, fx.absent, [fx.absent], null, solo, `s.pos === "No matches in transcript"`)
                    : null;
                await h.shot(`cdp-shots/${NAME}-5-no-matches.png`);
                rec(
                    "5. opening the solo for a term it does not hold shows No matches in transcript",
                    s5 != null && s5.pos === "No matches in transcript" && s5.all === 0,
                    { find: s5 }
                );

                // 6. Escape in the bar closes it, and stays on Sessions
                const s6 = await pageEval(
                    h,
                    `
                    const input = document.querySelector("[data-sessions-find] input");
                    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
                    await until(() => document.querySelector("[data-sessions-find]") == null, 3000);
                    const { globalStore } = await mod("app/store/jotaiStore.ts");
                    return {
                        hadInput: input != null,
                        bar: document.querySelector("[data-sessions-find]") != null,
                        find: globalStore.get(model.sessionsFindAtom),
                        surface: globalStore.get(model.surfaceAtom),
                        highlights: CSS.highlights.has("sessions-find"),
                    };
                `
                );
                await h.shot(`cdp-shots/${NAME}-6-closed.png`);
                rec(
                    "6. Escape in the find bar closes it and clears its highlights, staying on Sessions",
                    s6.hadInput && !s6.bar && s6.find == null && s6.surface === "sessions" && !s6.highlights,
                    s6
                );
                return steps;
            },
            async teardown(h, { fx, run }) {
                removeSessionsSearchFixtures(fx);
                await kit.teardownFixtureRun(h, run, NAME);
            },
        },
    ];
}
