// Ctrl+P's Sessions scope searching what was said.
// kit holds scenarios.mjs's sessions helpers (SESSIONS_KIT); the fixtures are in sessions-search-fixtures.mjs.

import { setTimeout as nap } from "node:timers/promises";
import {
    removeSessionsSearchFixtures,
    seedSessionsSearchRun,
    writeSessionsSearchFixtures,
} from "./sessions-search-fixtures.mjs";

const NAME = "sessions-palette";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const PALETTE_INPUT = `document.querySelector('input[data-palette-input]')`;
const PALETTE = `${PALETTE_INPUT}?.closest('[role="dialog"]')`;
const PALETTE_TOGGLE = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`;
const ESCAPE = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`;
// a cold index reads every transcript of the window, so the first answer can take a while
const SEARCH_WAIT_MS = 30_000;
const SEARCH_TRIES = 3;
const SCOPE_COUNT = 12;

async function waitFor(h, expr, ms) {
    for (let waited = 0; waited < ms; waited += 250) {
        if (await h.ev(expr).catch(() => false)) return true;
        await nap(250);
    }
    return false;
}

// React reads keys off the input's own keydown, so they are dispatched there rather than relying on page focus
const paletteKey = (key, mods = {}) => `(() => {
    const el = ${PALETTE_INPUT};
    if (!el) return false;
    el.dispatchEvent(new KeyboardEvent('keydown', { ...${JSON.stringify(mods)}, key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true }));
    return true;
})()`;

const typeQuery = (value) => `(() => {
    const el = ${PALETTE_INPUT};
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
})()`;

// the listbox's children are its groups, each led by its label; a row is a data-idx button
const PALETTE_STATE = `(() => {
    const d = ${PALETTE};
    if (!d) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const list = d.querySelector('[role="listbox"][aria-label="Results"]');
    const sel = list?.querySelector('button[data-idx][aria-selected="true"]');
    return {
        scope: d.querySelector('[data-palette-scope][aria-pressed="true"]')?.getAttribute('data-palette-scope') ?? null,
        drill: d.querySelector('[data-palette-drill]') ? flat(d.querySelector('[data-palette-drill]')) : null,
        query: d.querySelector('input[data-palette-input]')?.value ?? null,
        groups: [...(list?.children ?? [])].map((g) => ({
            label: flat(g.firstElementChild),
            rows: [...g.querySelectorAll('button[data-idx]')].map((b) => flat(b)),
        })),
        selected: sel ? flat(sel) : null,
        text: (d.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    };
})()`;

async function paletteStateWhen(h, ok, ms) {
    let state = null;
    for (let waited = 0; waited <= ms; waited += 250) {
        state = await h.ev(PALETTE_STATE).catch(() => null);
        if (state != null && ok(state)) break;
        await nap(250);
    }
    return state;
}

// The view model is not on window: the nav rail's component is handed it, so its fiber's props hold it. Reads the
// Sessions atoms the palette's Enter writes, and the surface it lands on.
const SESSIONS_ATOMS = `(async () => {
    const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
    const store = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
    if (store == null) return null;
    const { globalStore } = await import(store);
    const nav = document.querySelector('nav');
    const key = nav && Object.keys(nav).find((k) => k.startsWith('__reactFiber$'));
    let model = null;
    for (let f = key ? nav[key] : null; f != null && model == null; f = f.return) {
        if (f.memoizedProps?.model?.sessionsQueryAtom != null) model = f.memoizedProps.model;
    }
    if (model == null) return null;
    return {
        surface: globalStore.get(model.surfaceAtom),
        query: globalStore.get(model.sessionsQueryAtom),
        sel: globalStore.get(model.sessionsSelAtom),
        find: globalStore.get(model.sessionsFindAtom)?.sessionKey ?? null,
    };
})()`;

async function openPalette(h) {
    // Ctrl+P toggles, so a palette an earlier step left open is closed first
    if (await h.ev(`!!${PALETTE_INPUT}`)) {
        await h.ev(ESCAPE);
        await waitFor(h, `!${PALETTE_INPUT}`, 2000);
    }
    await h.ev(PALETTE_TOGGLE);
    return waitFor(h, `!!${PALETTE_INPUT}`, 3000);
}

const rowWith = (state, text) => state?.groups.flatMap((g) => g.rows).find((r) => r.includes(text));

export default function (kit) {
    return [
        {
            name: NAME,
            surface: "jarvis",
            async arrange(h) {
                const fx = writeSessionsSearchFixtures();
                const ctx = await seedSessionsSearchRun(h, kit, fx);
                return { ...ctx, fx };
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("0. the fixtures and their run were seeded", false, ctx.arrangeError);
                    return steps;
                }
                const { fx } = ctx;
                await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
                await h.goto("jarvis");
                const opened = await openPalette(h);
                if (!opened) {
                    rec("1. Ctrl+P opens the palette", false, "the palette input never showed");
                    return steps;
                }
                for (let i = 0; i < SCOPE_COUNT; i++) {
                    if ((await h.ev(PALETTE_STATE))?.scope === "sessions") break;
                    await h.ev(paletteKey("Tab"));
                    await nap(100);
                }

                // the worker's lines hold the word too, but a run agent never lists here; neither title holds it,
                // so a row holding it holds it in its second line, the snippet
                const listed = (s) =>
                    s.scope === "sessions" && rowWith(s, fx.solo.title) != null && rowWith(s, "Plan the export fix") != null;
                let found = null;
                for (let i = 0; i < SEARCH_TRIES && (found == null || !listed(found)); i++) {
                    // a search answered while the index was still warming may predate the fixtures: ask again
                    await h.ev(typeQuery(""));
                    await h.ev(typeQuery(fx.word));
                    found = await paletteStateWhen(h, listed, SEARCH_WAIT_MS / SEARCH_TRIES);
                }
                const rows = found?.groups.flatMap((g) => g.rows) ?? [];
                await h.shot("cdp-shots/sessions-palette-1-search.png");
                rec(
                    "1. Ctrl+P, Tab to Sessions, type the word: the solo and the lead list (not the worker), each holding the word under its title",
                    found != null &&
                        listed(found) &&
                        rows.length === 2 &&
                        rows.every((r) => r.includes(fx.word)) &&
                        !rows.some((r) => r.includes("Implement task t-1")),
                    JSON.stringify({ scope: found?.scope, query: found?.query, groups: found?.groups, text: found?.text.slice(0, 300) })
                );
                if (found == null || !listed(found)) return steps;

                // the solo is the newest fixture, so it is the first row; step down to it in case it is not
                for (let i = 0; i < rows.length; i++) {
                    if ((await h.ev(PALETTE_STATE))?.selected?.includes(fx.solo.title)) break;
                    await h.ev(paletteKey("ArrowDown"));
                    await nap(100);
                }
                await h.ev(paletteKey("ArrowRight"));
                const acts = await paletteStateWhen(h, (s) => s.drill != null && s.groups.length > 0, 3000);
                await h.shot("cdp-shots/sessions-palette-2-actions.png");
                const actRows = acts?.groups.flatMap((g) => g.rows) ?? [];
                rec(
                    "2. → on the solo's row lists its actions, Open in Sessions among them",
                    acts?.drill != null && actRows.some((r) => r.startsWith("Open in Sessions")),
                    JSON.stringify({ drill: acts?.drill, groups: acts?.groups })
                );

                await h.ev(paletteKey("ArrowLeft"));
                const back = await paletteStateWhen(
                    h,
                    (s) => s.drill == null && (s.selected ?? "").includes(fx.solo.title),
                    SEARCH_WAIT_MS / SEARCH_TRIES
                );
                await h.ev(paletteKey("Enter"));
                const closed = await waitFor(h, `!${PALETTE_INPUT}`, 3000);
                let landed = null;
                for (let waited = 0; waited < 3000; waited += 250) {
                    landed = await h.ev(SESSIONS_ATOMS).catch(() => null);
                    if (landed?.surface === "sessions") break;
                    await nap(250);
                }
                await nap(500);
                await h.shot("cdp-shots/sessions-palette-3-landed.png");
                rec(
                    "3. Enter on the solo's row lands on Sessions with the word as the list's query and the solo selected",
                    (back?.selected ?? "").includes(fx.solo.title) &&
                        closed &&
                        landed?.surface === "sessions" &&
                        landed.query === fx.word &&
                        landed.sel === `claude:${fx.solo.id}` &&
                        landed.find === `claude:${fx.solo.id}`,
                    JSON.stringify({ backSelected: back?.selected, closed, landed })
                );
                return steps;
            },
            async teardown(h, ctx) {
                await h.ev(ESCAPE).catch(() => {});
                removeSessionsSearchFixtures(ctx.fx);
                await kit.teardownFixtureRun(h, ctx, NAME);
            },
        },
    ];
}
