// Ctrl+P's Sessions scope resuming a session, on in-page fixture sessions (nothing is written to disk).
// the fixtures are in sessions-page-fixtures.mjs.

import { randomUUID } from "node:crypto";
import { setTimeout as nap } from "node:timers/promises";
import { fixtureSession, installSessions, restoreSessions } from "./sessions-page-fixtures.mjs";
import { openPalette, paletteKey, paletteStateWhen, PALETTE, PEEKS_ESC } from "./scenarios-shared.mjs";

const NAME = "sessions-palette-resume";
const SCOPE_COUNT = 12;
const ROWS_WAIT_MS = 5_000;
// the toast lives 6s (TOAST_TTL_MS), so it is read well inside that
const TOAST_WAIT_MS = 4_000;
const SCOPE = `${PALETTE}?.querySelector('[data-palette-scope][aria-pressed="true"]')?.getAttribute('data-palette-scope') ?? null`;
const ERROR_TOASTS = `[...document.querySelectorAll('[data-notification-toast="error"]')].map((t) => (t.textContent ?? '').replace(/\\s+/g, ' ').trim())`;
// the app's own module instance, as sessions-page-fixtures.mjs imports it
const TAB_COUNT = `(async () => {
    const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
    const mod = (path) => {
        const hit = names.filter((n) => n.endsWith("/" + path)).pop();
        const base = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
        return import(hit ?? base.replace("app/store/jotaiStore.ts", path));
    };
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { atoms } = await mod("app/store/global-atoms.ts");
    return globalStore.get(atoms.workspace)?.tabids?.length ?? null;
})()`;

const rowsOf = (state) => state?.groups.flatMap((g) => g.rows) ?? [];
const rowWith = (state, text) => rowsOf(state).find((r) => r.includes(text));

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "sessions",
            async arrange(h) {
                const tag = randomUUID().slice(0, 8);
                const fx = {
                    resumable: fixtureSession({ task: `Palette resumable ${tag}` }),
                    blocked: fixtureSession({
                        task: `Palette cwd gone ${tag}`,
                        resumeblocker: "its working directory C:\\arc-verify-sessions-fixture\\gone no longer exists",
                    }),
                    // the index saw its cwd, but it was deleted after the list loaded: no blocker, a missing path
                    vanished: fixtureSession({
                        task: `Palette cwd vanished ${tag}`,
                        projectpath: `C:\\arc-verify-sessions-fixture\\vanished-${tag}`,
                    }),
                };
                await installSessions(h, [fx.resumable, fx.blocked, fx.vanished]);
                return { fx };
            },
            async assert(h, { fx }) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (!(await openPalette(h))) {
                    rec("1. Ctrl+P opens the palette", false, "the palette input never showed");
                    return steps;
                }
                for (let i = 0; i < SCOPE_COUNT; i++) {
                    if ((await h.ev(SCOPE)) === "sessions") break;
                    await h.ev(paletteKey("Tab"));
                    await nap(100);
                }
                const listed = await paletteStateWhen(
                    h,
                    (s) => rowWith(s, fx.resumable.task) != null && rowWith(s, fx.vanished.task) != null,
                    ROWS_WAIT_MS
                );
                const scope = await h.ev(SCOPE);
                await h.shot("cdp-shots/sessions-palette-resume-1-rows.png");
                rec(
                    "1. the palette's session rows leave out a session whose cwd is gone",
                    scope === "sessions" &&
                        rowWith(listed, fx.resumable.task) != null &&
                        rowWith(listed, fx.vanished.task) != null &&
                        rowWith(listed, fx.blocked.task) == null,
                    JSON.stringify({ scope, rows: rowsOf(listed) })
                );
                if (rowWith(listed, fx.vanished.task) == null) return steps;

                const rowCount = rowsOf(listed).length;
                for (let i = 0; i <= rowCount; i++) {
                    if ((await paletteStateWhen(h, () => true, 0))?.selected?.includes(fx.vanished.task)) break;
                    await h.ev(paletteKey("ArrowDown"));
                    await nap(100);
                }
                const selected = (await paletteStateWhen(h, () => true, 0))?.selected ?? null;
                const tabsBefore = await h.ev(TAB_COUNT);
                await h.ev(paletteKey("Enter"));
                let toasts = [];
                for (let waited = 0; waited < TOAST_WAIT_MS; waited += 250) {
                    toasts = (await h.ev(ERROR_TOASTS).catch(() => [])) ?? [];
                    if (toasts.length > 0) break;
                    await nap(250);
                }
                await h.shot("cdp-shots/sessions-palette-resume-2-toast.png");
                const tabsAfter = await h.ev(TAB_COUNT);
                const reason = `Working directory no longer exists: ${fx.vanished.projectpath}`;
                rec(
                    "2. Resume from the palette on a session whose cwd vanished after loading shows the error toast",
                    (selected ?? "").includes(fx.vanished.task) &&
                        toasts.some((t) => t.includes("Couldn't start the agent") && t.includes(reason)) &&
                        tabsBefore != null &&
                        tabsAfter === tabsBefore,
                    JSON.stringify({ selected, toasts, tabsBefore, tabsAfter })
                );
                return steps;
            },
            async teardown(h) {
                await h.ev(PEEKS_ESC).catch(() => {});
                await restoreSessions(h);
            },
        },
    ];
}
