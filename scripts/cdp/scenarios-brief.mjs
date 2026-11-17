// Jarvis brief scenarios: the brief surface, its composer, profile, design parity, resource links and live initiative.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";
import { seedBriefDesign } from "./seed-brief.mjs";
import {
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    PEEKS_ESC,
    PROFILE_MODAL,
    arrangeHeldRun,
    closeProfile,
    failRpc,
    flatText,
    floorStep,
    fstWriteRun,
    holdRpc,
    lookEval,
    lookPlaceholders,
    lookShot,
    openProfileOn,
    placeholderStep,
    polishNap,
    polishReload,
    polishWaitFor,
    releaseRpc,
    reloadApp,
    setInputExpr,
    setPageRoster,
    skipStep,
    teardownHeldRuns,
    waitForProjectInConfig,
} from "./scenarios-shared.mjs";

// --- jarvis fleet, the rail's roster and the ambient feeds: RETIRED BY B5 -----------------------
// Their subjects are gone with the retired panes: the per-worker fleet roster and the ambient rail's
// resume/proactive cards were mounted only by the context rail, and the layout scenarios
// (jarvis-collapse-order, jarvis-narrow, jarvis-measure, jarvis-drawer) existed only to assert the
// three-pane allocation. Their capabilities are recorded as deferred in docs/deferred.md rather than
// re-homed, so there is nothing left here to assert against.

// --- jarvis attribution: RETIRED by B5, subject re-homed -------------------------------------------
// This scenario walked the Subjects column's Records group, selected each record until one had an attributed
// run, then corrected it from the run rows on the record's thread ("not this record") and put it back. B5
// deleted all three of those surfaces: the column, the record thread, and the run row inside it.
//
// The CAPABILITY survives: the same detach/restore controls are on the record band that the run's sheet
// renders (recordbandview.tsx EdgeControls, reached through the sheet's body). What is gone is the
// navigation that used to reach them, and this round trip WRITES TO THE USER'S OWN VAULT — so it is not
// something to re-author blind from a deleted-surface diff. Recorded in docs/deferred.md as needing
// re-authoring against the sheet: record peek -> attributed run -> the run's sheet -> its band -> detach,
// restore, and the two lists agreeing at each end.
//
// The two halves of the walk B5 re-homed ARE asserted live, which is why retiring this is a coverage note
// rather than a silent loss: brief-peek step 3 (a record's attributed run opens the run's sheet and
// resolves) and brief-surface step 4 (a queue row opens what it names).

// The design's narrow-window collapse order (JC16). This is the check the previous conformance pass
// could not make: "the thread is still mounted" passed on the broken layout, where the chrome held a
// constant 572px and the Stage went 1270 -> 70px. So rule 5 is asserted as a *width* — the Stage never
// drops below its floor while the order still has a region left to yield — plus the order itself, which
// must run rail-then-Subjects and never the other way round.

// stageRailOpenAtom is persisted, and the surface writes it false the first time it collapses. So any run
// that drove a narrow width - including a previous run of one of these two scenarios - leaves the rail
// already collapsed at 1920, where step 3 then cannot observe it yield. Pin the flag and reload so the
// width scan starts from a known rail, rather than inheriting a preference formed at some other width.

// The width no longer has a vote on the rail (jarvissurface.tsx), so a scenario about the Stage's floor has
// to pin the rail itself: with a 300px rail the user opened, the floor is legitimately unreachable below a
// ~1074px window and that is the design's answer, not a regression.

// --- jarvis-states: RETIRED BY B5 ----------------------------------------------------------------------
// It drove the fixture bar's `data-fixture` row — nine fabricated CONVERSATIONS — and asserted the content
// region rendered non-empty text for each. That mechanism is gone: the conversation fixtures were read by
// `activeConversationAtom`, whose only renderer was the Stage's ConversationView, so B5 deleted the atom and
// the row with them, and the fixture set followed once its own test was the only thing left reading it.
// What this scenario was protecting — that each surface state renders something rather than an empty region
// — is covered against the Brief by its own seam: `data-briefing-fixture` buttons and `brief-surface`'s
// steps 1-3 and 6 walk the seeded, empty and stale states on the live surface.

// --- brief surface: the Brief is the Jarvis surface ----------------------------------------------
// B5 retired the three-pane composition, so the Brief is the whole surface. Against the briefing fixtures
// this walks its four regions, the compact Waiting summary and the queue rows it reveals (each opens what
// it names and carries the design's one action), the j/k cursor, an initiative expanding in place, and
// a blocked chunk opening its initiative's sheet.

export const briefSurface = {
    name: "brief-surface",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        try {
            // the label matches the fixture's blocked chunk, so its row lands on a chunk the real plan has
            ctx.effortId = (await h.rpc("effortcreate", { title: "verify brief-surface: a blocked chunk", chunks: [{ label: "Phase 5" }] })).effortoid;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, arranged) {
        const steps = [];
        await h.goto("jarvis");

        // B5 retired the three-pane composition, so the Brief is no longer one of two: the region every
        // other jarvis-* scenario selects against is gone, and nothing may still offer to switch to it.
        const dflt = await h.ev(`(() => ({
            surface: !!document.querySelector('[data-jarvis-region="surface"]'),
            brief: !!document.querySelector('[data-jarvis-region="brief"]'),
            toggles: [...document.querySelectorAll('[data-jarvis-composition]')].length,
        }))()`);
        steps.push({
            step: "1. the Brief is the surface, and nothing still offers to switch composition",
            ok: dflt.brief === true && dflt.surface === false && dflt.toggles === 0,
            detail: JSON.stringify(dflt),
        });

        // the fixture seam bypasses the rpc, so these checks do not race FetchWorkState (which walks
        // transcript scans over ~/.claude and is documented at ~14s warm).
        await h.ev(`document.querySelector('[data-briefing-fixture="normal"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))");
        const regions = await h.ev(
            `[...document.querySelectorAll('[data-jarvis-brief-region]')].map((s) => s.dataset.jarvisBriefRegion)`
        );
        steps.push({
            step: "2. the Brief renders its four regions",
            ok: ["waiting", "initiatives", "sessions", "behind"].every((r) => regions.includes(r)),
            detail: JSON.stringify(regions),
        });

        // the disclosure is module state, so normalize it closed before asserting the compact default.
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        const seeded = await h.ev(`(() => {
            const m = {};
            document.querySelectorAll('[data-jarvis-brief-row]').forEach((r) => {
                const k = r.dataset.jarvisBriefRow;
                m[k] = (m[k] || 0) + 1;
            });
            const summary = document.querySelector('[data-jarvis-brief-attention-summary]');
            return {
                rows: m,
                summary: summary != null,
                open: summary?.getAttribute('aria-expanded') ?? null,
                queueRows: document.querySelectorAll('[data-jarvis-brief-row="queue"]').length,
            };
        })()`);
        steps.push({
            step: "3. attention starts compact while the other seeded regions stay visible",
            ok:
                seeded.summary === true &&
                seeded.open === "false" &&
                seeded.queueRows === 0 &&
                ["initiative", "session", "delta", "shipped"].every((kind) => (seeded.rows[kind] ?? 0) > 0),
            detail: JSON.stringify(seeded),
        });

        // Review reveals the existing actionable rows; the disclosure changes presentation, not where a
        // decision lands. A row opens what it names, and its only controls are its actions: the design's one
        // (Approve, Open, Retry), or a blocked chunk's Unblock and Done.
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        const q = await h.ev(`(() => {
            const summary = document.querySelector('[data-jarvis-brief-attention-summary]');
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')];
            const controls = (r) => r.querySelectorAll('button, a, input, select, textarea');
            return {
                expanded: summary?.getAttribute('aria-expanded') ?? null,
                rows: rows.length,
                openable: rows.filter((r) => r.classList.contains('cursor-pointer')).length,
                oneAction: rows.filter(
                    (r) => controls(r).length >= 1 && controls(r).length === r.querySelectorAll('[data-jarvis-queue-act]').length
                ).length,
            };
        })()`);
        steps.push({
            step: "4. Review reveals queue rows that open what they name, with only their actions as controls",
            ok: q.expanded === "true" && q.rows > 0 && q.openable === q.rows && q.oneAction === q.rows,
            detail: JSON.stringify(q),
        });

        const fleet = await h.ev(
            `(document.querySelector('[data-jarvis-brief-band="fleet"]') || {}).innerText ?? null`
        );
        steps.push({
            step: "5. the header fleet line is derived, not hardcoded",
            ok: typeof fleet === "string" && fleet.trim() !== "" && !/\$2\.41/.test(fleet),
            detail: JSON.stringify(fleet),
        });

        // j/k is the surface's only list navigation once the subjects column is gone (meta spec 4a
        // item 9). The cursor has to cross region boundaries, because the four regions are one column.
        const cursorNow = `(() => {
            const el = document.querySelector('[data-jarvis-brief-cursor="true"]');
            if (!el) return null;
            return {
                row: el.dataset.jarvisBriefRow,
                text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 32),
                n: document.querySelectorAll('[data-jarvis-brief-cursor="true"]').length,
            };
        })()`;
        const press = async (key) => {
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`
            );
            await h.ev("new Promise((r) => setTimeout(r, 150))");
        };
        // the cursor is module state and outlives a scenario run, so walk it back to the top first:
        // otherwise this step asserts where the PREVIOUS run left it. k clamps at the first row.
        for (let i = 0; i < 15; i++) {
            await press("k");
        }
        const trail = [await h.ev(cursorNow)];
        await press("j");
        trail.push(await h.ev(cursorNow));
        await press("j");
        trail.push(await h.ev(cursorNow));
        await press("k");
        trail.push(await h.ev(cursorNow));
        const text = trail.map((t) => (t == null ? null : t.text));
        steps.push({
            step: "6. j/k walk the cursor down the column and back, one cursor at a time",
            ok:
                trail.every((t) => t != null && t.n === 1) &&
                trail[0].row === "queue" && // the cursor starts on the first row of "Waiting on you"
                text[0] !== text[1] &&
                text[1] !== text[2] &&
                text[3] === text[1], // k returns to the row j came from
            detail: JSON.stringify(trail.map((t) => (t == null ? null : `${t.row}/${t.text}`))),
        });

        // An initiative row is one line, and a click expands its plan in place (cd1a9ce4): it has no sheet to
        // open any more. The row is the one affordance for opening; its only nested control is Work on (6089a445).
        // The expansion and the sheet are module state, so whatever a previous run left open is closed first.
        await h.ev(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close detail sheet')?.click()`);
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"][aria-expanded="true"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))");
        const card = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')];
            return {
                rows: rows.length,
                buttons: rows.filter((r) => r.getAttribute('role') === 'button').length,
                nested: rows.reduce(
                    (n, r) => n + r.querySelectorAll('button:not([data-jarvis-work-on]), a, input, select, textarea').length,
                    0
                ),
                expanded: rows[0]?.getAttribute('aria-expanded') ?? null,
                sheet: !!document.querySelector('[data-jarvis-brief-sheet]'),
            };
        })()`);
        steps.push({
            step: "7. an initiative row is one line that expands in place and opens no sheet",
            ok:
                card.rows > 0 &&
                card.buttons === card.rows &&
                card.nested === 0 &&
                card.expanded === "true" &&
                card.sheet === false,
            detail: JSON.stringify(card),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"][aria-expanded="true"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");

        // A blocked chunk's row lands on that chunk in its initiative's plan, with its notes open, rather than on
        // the initiative's sheet. The plan loads from the store, and the fixture's own initiative is not in it, so
        // the blocked chunk's initiative is pointed at the one the arrange made, on a copy of the normal fixture.
        await lookEval(h, `
            const { BRIEFING_FIXTURES } = await mod("app/view/jarvis/briefingfixtures.ts");
            const { briefingFixtureAtom } = await mod("app/view/jarvis/briefingstore.ts");
            const normal = BRIEFING_FIXTURES.normal;
            const state = {
                ...normal.load.snapshot.state,
                efforts: normal.load.snapshot.state.efforts.map((e) =>
                    e.oref === "effort:scenario-gate" ? { ...e, oref: ${JSON.stringify(`effort:${arranged.effortId}`)} } : e
                ),
            };
            BRIEFING_FIXTURES.briefSurfaceBlocked = { ...normal, load: { ...normal.load, snapshot: { ...normal.load.snapshot, state } } };
            (await mod("app/store/jotaiStore.ts")).globalStore.set(briefingFixtureAtom, "briefSurfaceBlocked");
        `);
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        await h.ev(
            `[...document.querySelectorAll('[data-jarvis-brief-row="queue"]')].find((r) => /Scenario gate clearance/.test(r.innerText || ""))?.click()`
        );
        await h.ev("new Promise((r) => setTimeout(r, 800))");
        const sheet = await lookEval(h, `
            await until(() => document.querySelector('[data-jarvis-chunk-sidebar]') != null, 5000);
            return {
                sheet: !!document.querySelector('[data-jarvis-brief-sheet]'),
                chunk: document.querySelector('[data-jarvis-tracker-chunk="Phase 5"]')?.getAttribute("aria-pressed") ?? null,
                sidebar: (document.querySelector('[data-jarvis-chunk-sidebar]')?.innerText || "").includes("Phase 5"),
            };
        `);
        steps.push({
            step: "8. a blocked chunk's row lands on that chunk in its initiative's plan, notes open",
            ok: arranged.arrangeError == null && sheet.sheet === false && sheet.chunk === "true" && sheet.sidebar,
            detail: arranged.arrangeError ?? JSON.stringify(sheet),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"][aria-expanded="true"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        await lookEval(h, `
            const { BRIEFING_FIXTURES } = await mod("app/view/jarvis/briefingfixtures.ts");
            const { briefingFixtureAtom } = await mod("app/view/jarvis/briefingstore.ts");
            (await mod("app/store/jotaiStore.ts")).globalStore.set(briefingFixtureAtom, "normal");
            delete BRIEFING_FIXTURES.briefSurfaceBlocked;
        `);
        await h.ev("new Promise((r) => setTimeout(r, 300))");

        // F8: the row states what it is waiting on and what it belongs to, on its one line. The "attention"
        // fixture is the one that carries wire attention items; "normal" has none, so the queue there is only
        // blocked chunks, which carry no attribution by design. The row itself opens (step 4), so its nested
        // controls are its actions. A one-line row has no room for cites, so it no longer draws them.
        await h.ev(`document.querySelector('[data-briefing-fixture="attention"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        const ctx = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')];
            const txt = (e) => (e.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                rows: rows.length,
                oneAction: rows.filter((r) => {
                    const n = r.querySelectorAll('button, a, input, select, textarea').length;
                    return n >= 1 && n === r.querySelectorAll('[data-jarvis-queue-act]').length;
                }).length,
                first: rows.length ? txt(rows[0]) : null,
            };
        })()`);
        steps.push({
            step: "9. a queue row names its initiative and why it is waiting, on one line",
            ok:
                ctx.rows >= 3 &&
                ctx.oneAction === ctx.rows &&
                // the effort title is joined on the frontend from the efforts already on the surface,
                // so a raw oid here would mean the join silently failed
                (ctx.first ?? "").includes("Scenario gate clearance \u00b7 Phase 3") &&
                /The work is on wave\/r-briefing-1/.test(ctx.first ?? ""),
            detail: JSON.stringify(ctx),
        });
        await h.shot("cdp-shots/brief-queue-context.png");

        await h.shot("cdp-shots/brief-surface.png");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);
        steps.push(await floorStep(h, `10. no visible text on the Brief is under ${MIN_FONT_PX}px`, `document.querySelector('[data-jarvis-region="brief"]')`));

        // the first load's frame, through a briefing fixture made for it on the app's own fixture table
        await lookEval(h, `
            const { BRIEFING_FIXTURES } = await mod("app/view/jarvis/briefingfixtures.ts");
            const { briefingFixtureAtom } = await mod("app/view/jarvis/briefingstore.ts");
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            BRIEFING_FIXTURES.uiDriftLoading = { load: { snapshot: null, loading: true, error: null }, agents: [], attention: [] };
            window.__uiDriftPriorFixture = globalStore.get(briefingFixtureAtom);
            globalStore.set(briefingFixtureAtom, "uiDriftLoading");
        `);
        const first = await lookPlaceholders(h, `document.querySelector('[data-jarvis-brief-state="loading"]')`);
        await h.shot(lookShot("brief-surface-loading"));
        await lookEval(h, `
            const { BRIEFING_FIXTURES } = await mod("app/view/jarvis/briefingfixtures.ts");
            const { briefingFixtureAtom } = await mod("app/view/jarvis/briefingstore.ts");
            (await mod("app/store/jotaiStore.ts")).globalStore.set(briefingFixtureAtom, window.__uiDriftPriorFixture ?? null);
            delete BRIEFING_FIXTURES.uiDriftLoading;
        `);
        steps.push({
            ...placeholderStep("11. the Brief's first load holds one 48px-floor block under each region's label", first, { minHeight: 48, radius: "10px" }),
            ok: first.length === 4 && first.every((_, i) => placeholderStep("", first, { minHeight: 48, radius: "10px" }, i).ok),
        });
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx?.effortId) {
            await h.rpc("effortdelete", { effortoid: ctx.effortId }).catch((e) => {
                console.error(`brief-surface teardown: delete the initiative failed: ${e?.message ?? e}`);
            });
        }
        await h.goto("cockpit");
    },
};

// --- brief-composer-steer-only: no composer without a live lead to message --------------------------
// The Brief's composer only steers a running session's lead (briefcomposertarget.ts); the Ask audiences it
// used to have were retired. So with no session sheet open there is no composer at all. Step 2 opens a held dag'd
// run whose devMock lead's tab name differs from the plan title, and sends to a block no terminal has: the server
// refuses it, the composer names the lead by the plan title, as the run is named everywhere else, gives the draft
// back, and posts no directive to the run's channel.
const STEER_PLAN_TITLE = "Steer-only plan title";
const STEER_LEAD_ID = "fx-steer-lead";
const STEER_LEAD_TAB = "steer-only lead tab";
// no terminal has this block and the store holds none: the real server refuses the prompt
const STEER_LEAD_BLOCK = "fx-blk-steer-gone";
const STEER_TEXT = "steer-only check: hold the lane";
const STEER_INPUT = `document.querySelector('[data-jarvis-brief-composer="input"]')`;

export const briefComposerSteerOnly = {
    name: "brief-composer-steer-only",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        try {
            const run = await arrangeHeldRun(h, ctx, {
                key: "brief-steer",
                title: STEER_PLAN_TITLE,
                tasks: [{ id: "t-1", label: "noop" }],
            });
            // steerTarget takes the lead from the current phase's first tab oref; teardown puts the run back first,
            // since a cancel fails on a tab that does not exist
            await fstWriteRun(h, run.runId, (r) => {
                ctx.original = { status: r.status, phases: r.phases };
                return {
                    ...r,
                    status: "executing",
                    phases: [{ kind: "execute", state: "running", startedts: Date.now(), workerorefs: [`tab:${STEER_LEAD_ID}`] }],
                };
            });
            // the Brief reads a boot-primed snapshot, so the RPC-created channel needs a reload
            await reloadApp(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        // start with no sheet open: Escape closes whatever a previous scenario left behind
        await h.goto("jarvis");
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        await h.goto("jarvis");
        await h.ev("new Promise((r) => setTimeout(r, 700))");
        steps.push({
            step: "1. the Brief shows no composer while no session sheet is open",
            ok:
                (await h.ev(`!!document.querySelector('[data-jarvis-region="brief"]')`)) === true &&
                (await h.ev(`document.querySelector('[data-jarvis-brief-composer]') == null`)) === true,
            detail: "",
        });
        await h.shot("cdp-shots/brief-composer-steer-only.png");

        const step2 = "2. a send that cannot reach a dag'd run's lead names the plan title, not the tab name, and gives the draft back";
        if (ctx.arrangeError != null) {
            steps.push({ step: step2, ok: false, detail: `arrange: ${ctx.arrangeError}` });
            return steps;
        }
        const runId = ctx.held[0].runId;
        await setPageRoster(h, [
            {
                id: STEER_LEAD_ID,
                name: STEER_LEAD_TAB,
                project: "verify-brief-steer",
                task: "lead the steer-only run",
                state: "working",
                agent: "claude",
                model: "opus",
                activeMs: 60_000,
                runId,
                blockId: STEER_LEAD_BLOCK,
            },
        ]);
        const directives = async () =>
            ((await h.rpc("getchannelmessages", { channelid: ctx.held[0].channelId }))?.messages ?? []).filter(
                (m) => m.kind === "directive"
            ).length;
        const directivesBefore = await directives();
        const seen = await lookEval(h, `
                await until(() => typeof window.__openAddress === "function", 5000);
                await window.__openAddress(${JSON.stringify(`run:${runId}`)});
                const input = () => ${STEER_INPUT};
                if (!(await until(() => input() != null, 8000))) return { composer: false };
                // send as soon as the composer mounts, before the run's dag may have loaded: the run carries its
                // plan title, so the lead goes by it from the first frame
                const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
                set.call(input(), ${JSON.stringify(STEER_TEXT)});
                input().dispatchEvent(new Event("input", { bubbles: true }));
                const send = () => document.querySelector('[data-jarvis-brief-composer="send"]');
                await until(() => send() != null && !send().disabled, 3000);
                send().click();
                const status = () => document.querySelector('[data-jarvis-brief-composer="status"]');
                await until(() => status() != null && input()?.value === ${JSON.stringify(STEER_TEXT)}, 8000);
                return { composer: true, status: flat(status()), draft: input()?.value ?? null };
            `);
        await h.shot("cdp-shots/brief-composer-steer-only-gone.png");
        const directivesAfter = await directives();
        steps.push({
            step: step2,
            ok:
                seen?.composer === true &&
                seen.status === `${STEER_PLAN_TITLE} is no longer live — nothing was sent.` &&
                !seen.status.includes(STEER_LEAD_TAB) &&
                seen.draft === STEER_TEXT &&
                directivesAfter === directivesBefore,
            detail: JSON.stringify({ ...seen, directivesBefore, directivesAfter }),
        });
        return steps;
    },
    async teardown(h, ctx) {
        const run = ctx.held?.[0];
        if (run?.runId && ctx.original) {
            await fstWriteRun(h, run.runId, (r) => ({ ...r, ...ctx.original })).catch((e) =>
                console.error(`brief-composer-steer-only teardown: take the lead off the run failed: ${e?.message ?? e}`)
            );
        }
        await teardownHeldRuns(h, ctx, "brief-composer-steer-only");
        // drops the page roster and the closed channel
        await reloadApp(h);
    },
};

// --- brief-profile: both scopes of the profile modal -------------------------------------------
// Only step 13 presses Save (global lands, the project write is refused); teardown restores the global profile
// it wrote. A store with no projects opens the modal on
// Global only, so the scenario registers two of its own; the principles editor steps write the first one's
// override over RPC, and teardown clears it with the project.
const BRIEF_PROFILE_PROJECT = "verify-brief-profile";
const BRIEF_PROFILE_PROJECT_2 = "verify-brief-profile-2";
// a disabled id no global principle has, so the project carries a missing-disabled stale row
const BRIEF_PROFILE_MISSING_ID = "verify-brief-profile-removed-principle";

// the profile modal's footer, its principle editors' markers, and whether an error sits above the scroll body
const PROFILE_FOOTER = `(() => {
    const m = ${PROFILE_MODAL};
    if (!m) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const footer = m.querySelector('footer');
    const buttons = [...(footer?.querySelectorAll('button') ?? [])];
    const body = m.querySelector('.overflow-y-auto');
    const err = m.querySelector('[data-jarvis-brief-modal-state="error"]');
    const meta = [...m.querySelectorAll('section')].find((s) => flat(s.querySelector('h2')) === 'Principles')?.querySelector('h2 + span');
    return {
        scope: m.dataset.jarvisProfileScope,
        status: flat(footer?.firstElementChild),
        confirm: flat(footer?.querySelector('[data-jarvis-profile-confirm]')) || null,
        buttons: buttons.map((b) => flat(b)),
        saveDisabled: buttons.at(-1)?.disabled ?? null,
        blankNotes: m.querySelectorAll('[data-jarvis-principle-blank]').length,
        errorAbove: !!err && !!body && err.getBoundingClientRect().bottom <= body.getBoundingClientRect().top,
        principlesMeta: flat(meta),
        customizing: !!m.querySelector('textarea[aria-label="Customized principle text"]'),
        additions: m.querySelectorAll('textarea[aria-label="Project principle text"]').length,
        removed: [...m.querySelectorAll('[data-jarvis-removed-principle]')].map(flat),
        stale: [...m.querySelectorAll('[data-jarvis-stale-principle] > span')].map(flat),
    };
})()`;
const profileButton = (label) => `[...(${PROFILE_MODAL}?.querySelectorAll('button') ?? [])].filter((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
const clickProfileButton = (h, label, which = "[0]") => h.ev(`${profileButton(label)}${which}?.click()`);
const setTextareaExpr = (elExpr, value) => `(() => {
    const el = ${elExpr};
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
})()`;
// the removed note's copy cuts a principle to its first line
const firstLine = (text) => {
    const lines = text.trim().split("\n");
    return lines[0].trim() + (lines.length > 1 ? "…" : "");
};

// Steps 7-12, the principles editors (leftovers review F1, F2, F11, F12), at the harness's 1600 width.
async function principlesEditorSteps(h, ctx, rec) {
    const footer = () => h.ev(PROFILE_FOOTER);
    const waitFooter = (cond, ms = 3000) => polishWaitFor(h, `(() => { const f = ${PROFILE_FOOTER}; return !!f && (${cond}); })()`, ms);
    const global = (await h.rpc("getjarvisprofile", { channelid: ctx.channelId }))?.global?.principles ?? [];

    // 7. (F1) a blank project principle holds Save and the footer names it; the error is not up in the body
    await openProfileOn(h, BRIEF_PROFILE_PROJECT);
    await clickProfileButton(h, "Add a project principle");
    await waitFooter(`f.status.endsWith('is empty')`);
    const blank = await footer();
    const blankWant = `Principle ${global.length + 1} is empty`;
    rec(
        "7. a blank project principle disables Save, the footer names it, and no error sits above the viewport",
        blank?.status === blankWant && blank.saveDisabled === true && blank.blankNotes === 1 && blank.errorAbove === false,
        JSON.stringify({ want: blankWant, ...blank })
    );
    await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-principle-blank]')?.scrollIntoView({ block: 'center' })`);
    await h.shot("cdp-shots/brief-profile-blank.png");
    await clickProfileButton(h, "Delete", ".at(-1)");

    // 8. (F2) an unsaved project edit is named from Global, and Esc arms the discard confirm instead of closing
    await clickProfileButton(h, "Customize");
    await h.ev(setTextareaExpr(`${PROFILE_MODAL}?.querySelector('textarea[aria-label="Customized principle text"]')`, "verify edited wording"));
    await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-profile-tab="global"]')?.click()`);
    await waitFooter(`f.scope === 'global' && f.status.startsWith('Unsaved')`);
    const fromGlobal = await footer();
    await h.ev(PEEKS_ESC);
    await waitFooter(`f.confirm != null`);
    const armed = await footer();
    await h.shot("cdp-shots/brief-profile-discard-confirm.png");
    await clickProfileButton(h, "Keep editing");
    await waitFooter(`f.confirm == null`);
    const kept = await footer();
    rec(
        "8. a project edit reads 'Unsaved changes · Project' from Global; Esc asks to discard and Keep editing keeps the modal",
        fromGlobal?.status === "Unsaved changes · Project" &&
            armed?.confirm === "Discard unsaved changes to Project?" &&
            armed.buttons.join(",") === "Keep editing,Discard" &&
            kept?.status === "Unsaved changes · Project",
        JSON.stringify({ fromGlobal: fromGlobal?.status, armed: armed && { confirm: armed.confirm, buttons: armed.buttons }, kept: kept?.status })
    );
    const discarded = await closeProfile(h);

    // 9. (F11) Customize alone changes nothing
    await openProfileOn(h, BRIEF_PROFILE_PROJECT);
    await clickProfileButton(h, "Customize");
    await waitFooter(`f.customizing`);
    const customize = await footer();
    await clickProfileButton(h, "Cancel");
    const closedClean = await polishWaitFor(h, `!${PROFILE_MODAL}`, 3000);
    rec(
        "9. Customize without editing is not customized and not a change, and Cancel closes at once",
        discarded === true &&
            customize?.customizing === true &&
            !customize.principlesMeta.includes("customized") &&
            customize.status === "No changes" &&
            closedClean === true,
        JSON.stringify({ discardedBefore: discarded, meta: customize?.principlesMeta, status: customize?.status, closedClean })
    );
    if (!closedClean) await closeProfile(h);

    if (global.length === 0) {
        for (const step of ["10. deleting a principle a project disables notes it", "11. a stale missing-disabled row names no id"]) {
            rec(step, false, "the global profile has no principles - seed one before reading this as a pass");
        }
    } else {
        await h.rpc("setchannelprofile", {
            channelid: ctx.channelId,
            override: { principles: { disabled: [global[0].id, BRIEF_PROFILE_MISSING_ID] } },
        });
        ctx.wroteOverride = true;

        // 10. (F12) a global delete names the project that disabled the principle
        await openProfileOn(h, BRIEF_PROFILE_PROJECT);
        await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-profile-tab="global"]')?.click()`);
        // the per-project overrides load after the face: the first principle's note says when they are in
        await polishWaitFor(h, `${flatText(`${PROFILE_MODAL}?.querySelector('[data-jarvis-global-principles="editor"]')`)}.includes('Disabled in')`, 5000);
        await h.ev(`${PROFILE_MODAL}?.querySelector('button[aria-label="Delete principle 1"]')?.click()`);
        await waitFooter(`f.removed.length > 0`);
        const removed = await footer();
        const removedWant = `Removed "${firstLine(global[0].text)}" · disabled in `;
        rec(
            "10. deleting a global principle a project disables notes it under the editor",
            (removed?.removed ?? []).some((t) => t.startsWith(removedWant)) && removed.status === "Unsaved changes · Global",
            JSON.stringify({ want: removedWant, removed: removed?.removed, status: removed?.status })
        );
        await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-removed-principle]')?.scrollIntoView({ block: 'center' })`);
        await h.shot("cdp-shots/brief-profile-removed.png");
        await closeProfile(h);

        // 11. (F12) the project's stale row says what it did, not which id
        await openProfileOn(h, BRIEF_PROFILE_PROJECT);
        await waitFooter(`f.stale.length > 0`);
        const stale = await footer();
        rec(
            "11. a principle the project disabled and global removed reads as such, with no raw id",
            (stale?.stale ?? []).includes("This project disabled a principle that was removed from the global set.") &&
                stale.stale.every((t) => !t.includes(BRIEF_PROFILE_MISSING_ID)),
            JSON.stringify(stale?.stale)
        );
        await closeProfile(h);
    }

    // 12. (F2) a project switch with a dirty project draft asks first; Discard lands on the picked project clean
    await openProfileOn(h, BRIEF_PROFILE_PROJECT);
    await clickProfileButton(h, "Add a project principle");
    await h.ev(setTextareaExpr(`[...(${PROFILE_MODAL}?.querySelectorAll('textarea[aria-label="Project principle text"]') ?? [])].at(-1)`, "verify chip switch"));
    await waitFooter(`f.status === 'Unsaved changes · Project'`);
    const chip2 = `${PROFILE_MODAL}?.querySelector('button[title="${BRIEF_PROFILE_PROJECT_2}"]')`;
    if (!(await h.ev(`!!${chip2}`))) {
        await h.ev(setInputExpr(`${PROFILE_MODAL}?.querySelector('input[aria-label="Search projects"]')`, BRIEF_PROFILE_PROJECT_2));
        await polishWaitFor(h, `!!${chip2}`, 3000);
    }
    await h.ev(`${chip2}?.click()`);
    await waitFooter(`f.confirm != null`);
    const held = await footer();
    const heldPressed = await h.ev(`${chip2}?.getAttribute('aria-pressed')`);
    await clickProfileButton(h, "Discard");
    await polishWaitFor(h, `${chip2}?.getAttribute('aria-pressed') === 'true' && !!${PROFILE_MODAL}?.querySelector('[role="group"][aria-label="Approvals"]')`, 5000);
    await polishNap(300);
    const switched = await footer();
    const switchedPressed = await h.ev(`${chip2}?.getAttribute('aria-pressed')`);
    rec(
        "12. a chip click with a dirty project draft asks to discard, and Discard opens the picked project clean",
        held?.confirm === "Discard unsaved changes to Project?" &&
            held.additions === 1 &&
            heldPressed !== "true" &&
            switchedPressed === "true" &&
            switched?.status === "No changes" &&
            switched.additions === 0,
        JSON.stringify({ held: held && { confirm: held.confirm, additions: held.additions }, heldPressed, switchedPressed, switched: switched && { status: switched.status, additions: switched.additions } })
    );
    await closeProfile(h);
}

const PARTIAL_SAVE_REFUSAL = "verify: project profile save refused";
const SHAPE_VALUE = { Quick: "quick", Orchestrator: "orchestrator" };

// Step 13 (D14, F17): both scopes dirty and the project write refused. Global is written first, so it lands and
// reads saved while the project stays dirty with the refusal in the footer. This one writes the global profile
// (the Final's own store); ctx.globalBefore is what teardown puts back.
async function partialSaveStep(h, ctx, rec) {
    const step = "13. a refused project save after the global one landed leaves global saved, the project dirty and the footer naming the refusal";
    const footer = () => h.ev(PROFILE_FOOTER);
    const waitFooter = (cond, ms = 3000) => polishWaitFor(h, `(() => { const f = ${PROFILE_FOOTER}; return !!f && (${cond}); })()`, ms);
    const storedShape = async () => (await h.rpc("getjarvisprofile", { channelid: ctx.channelId }))?.global?.defaultmode;
    const shapeGroup = `${PROFILE_MODAL}?.querySelector('[role="group"][aria-label="Default shape"]')`;
    const otherShape = `[...(${shapeGroup}?.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('aria-pressed') !== 'true')`;

    ctx.globalBefore = (await h.rpc("getjarvisprofile", { channelid: ctx.channelId }))?.global;
    await openProfileOn(h, BRIEF_PROFILE_PROJECT);
    await clickProfileButton(h, "Add a project principle");
    await h.ev(setTextareaExpr(`[...(${PROFILE_MODAL}?.querySelectorAll('textarea[aria-label="Project principle text"]') ?? [])].at(-1)`, "verify partial save"));
    await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-profile-tab="global"]')?.click()`);
    await polishWaitFor(h, `${PROFILE_MODAL}?.dataset.jarvisProfileScope === 'global' && !!${otherShape}`, 5000);
    const shapeLabel = await h.ev(`${otherShape}?.textContent.trim() ?? null`);
    const wantShape = SHAPE_VALUE[shapeLabel];
    await h.ev(`${otherShape}?.click()`);
    await waitFooter(`f.status === 'Unsaved changes · Project and Global'`);
    const dirty = await footer();

    let refused = null;
    let stored = null;
    let globalTab = null;
    let projectTab = null;
    await failRpc(h, "SetChannelProfileCommand", PARTIAL_SAVE_REFUSAL);
    try {
        await clickProfileButton(h, "Save global profile");
        await waitFooter(`f.status === ${JSON.stringify(PARTIAL_SAVE_REFUSAL)}`, 5000);
        refused = await footer();
        await h.shot("cdp-shots/brief-profile-partial-save.png");
        stored = await storedShape();
        // switching scope clears the footer's error, which leaves what each scope still owes
        await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-profile-tab="global"]')?.click()`);
        await waitFooter(`f.scope === 'global' && f.status.startsWith('Unsaved')`);
        globalTab = await footer();
        await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-profile-tab="project"]')?.click()`);
        await waitFooter(`f.scope === 'project' && f.status.startsWith('Unsaved')`);
        projectTab = await footer();
    } finally {
        await releaseRpc(h, "SetChannelProfileCommand");
    }
    rec(
        step,
        wantShape != null &&
            dirty?.status === "Unsaved changes · Project and Global" &&
            refused?.status === PARTIAL_SAVE_REFUSAL &&
            refused.saveDisabled === false &&
            stored === wantShape &&
            globalTab?.status === "Unsaved changes · Project" &&
            projectTab?.status === "Unsaved changes · Project" &&
            projectTab.additions === 1,
        JSON.stringify({
            shapeLabel,
            wantShape,
            stored,
            dirty: dirty?.status,
            refused: refused && { status: refused.status, saveDisabled: refused.saveDisabled },
            globalTab: globalTab?.status,
            projectTab: projectTab && { status: projectTab.status, additions: projectTab.additions },
        })
    );
    await closeProfile(h);
}

// the run-defaults rows: a row is the grid holding a label, its control and the source or reach cell
const PROFILE_STATE = `(() => {
    const m = ${PROFILE_MODAL};
    if (!m) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const footer = m.querySelector('footer');
    const save = [...(footer?.querySelectorAll('button') ?? [])].at(-1);
    return {
        scope: m.dataset.jarvisProfileScope,
        subtitle: flat(m.querySelector('header span:nth-child(2)')),
        tabs: [...m.querySelectorAll('[data-jarvis-profile-tab]')].map((b) => ({ tab: b.dataset.jarvisProfileTab, disabled: b.disabled })),
        sections: [...m.querySelectorAll('section h2')].map(flat),
        rows: [...(m.querySelector('section')?.querySelectorAll(':scope > div > .grid') ?? [])].map((r) => ({
            label: flat(r.firstElementChild?.firstElementChild),
            aside: flat(r.lastElementChild),
        })),
        globalPrinciples: !!m.querySelector('[data-jarvis-global-principles="editor"]'),
        status: flat(footer?.firstElementChild),
        save: flat(save),
        saveDisabled: save?.disabled ?? null,
    };
})()`;

// the Light reviewers route row: its label, the picker's face and the source cell
const PROFILE_LIGHT_ROW = `(() => {
    const row = ${PROFILE_MODAL}?.querySelector('[data-light-reviewers-row]');
    if (!row) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    return {
        label: flat(row.firstElementChild?.firstElementChild),
        face: flat(row.querySelector('[data-testid="route-picker"]')),
        aside: flat(row.lastElementChild),
    };
})()`;

export const briefProfile = {
    name: "brief-profile",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-brief-profile-"));
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.rpc("createproject", { name: BRIEF_PROFILE_PROJECT, path: cwd });
            ctx.project = BRIEF_PROFILE_PROJECT;
            await waitForProjectInConfig(h, BRIEF_PROFILE_PROJECT);
            const ch = await h.rpc("createchannel", { name: BRIEF_PROFILE_PROJECT, projectpath: cwd });
            ctx.channelId = ch.oid;
            ctx.cwd2 = mkdtempSync(join(tmpdir(), "verify-brief-profile-2-"));
            await h.rpc("createproject", { name: BRIEF_PROFILE_PROJECT_2, path: ctx.cwd2 });
            ctx.project2 = BRIEF_PROFILE_PROJECT_2;
            await waitForProjectInConfig(h, BRIEF_PROFILE_PROJECT_2);
            const ch2 = await h.rpc("createchannel", { name: BRIEF_PROFILE_PROJECT_2, projectpath: ctx.cwd2 });
            ctx.channelId2 = ch2.oid;
            // the modal lists projects from the boot-primed channel list
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a project with its channel was made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.goto("jarvis");
        const opened = await openProfileOn(h, BRIEF_PROFILE_PROJECT);
        const project = await h.ev(PROFILE_STATE);
        rec(
            "1. the modal opens on the project's Project scope, both scopes offered, with nothing to save",
            opened &&
                project?.scope === "project" &&
                project.tabs.map((t) => `${t.tab}:${t.disabled}`).join(",") === "project:false,global:false" &&
                project.subtitle === "Defaults Jarvis uses for future runs" &&
                project.sections.join(",") === "Run defaults,Principles" &&
                project.status === "No changes" &&
                project.save === "Save profile" &&
                project.saveDisabled === true,
            JSON.stringify({ opened, ...project, rows: undefined })
        );

        // a project that never said anything inherits every row
        const labels = project?.rows.map((r) => r.label) ?? [];
        rec(
            "2. the run defaults list Lead route and Approvals among their rows, every one inheriting Global",
            labels.includes("Lead route") &&
                labels.includes("Approvals") &&
                project.rows.every((r) => r.aside === "Global"),
            JSON.stringify(project?.rows)
        );
        await h.shot("cdp-shots/brief-profile-project.png");
        const projectLight = await h.ev(PROFILE_LIGHT_ROW);

        await h.ev(`${PROFILE_MODAL}?.querySelector('[data-jarvis-profile-tab="global"]')?.click()`);
        await polishWaitFor(h, `${PROFILE_MODAL}?.dataset.jarvisProfileScope === 'global' && !!${PROFILE_MODAL}?.querySelector('[data-jarvis-global-principles="editor"]')`, 5000);
        const global = await h.ev(PROFILE_STATE);
        const globalLabels = global?.rows.map((r) => r.label) ?? [];
        rec(
            "3. the global face edits the run defaults and the principles every project inherits, with no lead route",
            global?.scope === "global" &&
                global.subtitle === "The base every project inherits" &&
                global.sections.join(",") === "Run defaults,Principles" &&
                globalLabels.includes("Approvals") &&
                !globalLabels.includes("Lead route") &&
                global.globalPrinciples === true &&
                global.status === "No changes" &&
                global.save === "Save global profile" &&
                global.saveDisabled === true,
            JSON.stringify(global)
        );
        await h.shot("cdp-shots/brief-profile.png");

        const globalLight = await h.ev(PROFILE_LIGHT_ROW);
        rec(
            "4. profile shows the Light reviewers route row on both scopes, unset on Global",
            projectLight?.label === "Light reviewers route" &&
                projectLight.aside === "Global" &&
                ["Sonnet (default)", "Same as global"].includes(projectLight.face) &&
                globalLight?.label === "Light reviewers route" &&
                globalLight.face !== "",
            JSON.stringify({ project: projectLight, global: globalLight })
        );
        steps.push(await floorStep(h, `5. no visible text in the profile modal is under ${MIN_FONT_PX}px`, PROFILE_MODAL));

        // the modal's loading frame: reopened with the profile read held
        await closeProfile(h);
        await holdRpc(h, "GetJarvisProfileCommand");
        await openProfileOn(h, BRIEF_PROFILE_PROJECT);
        const loading = await lookPlaceholders(h, PROFILE_MODAL);
        await h.shot(lookShot("brief-profile-loading"));
        await releaseRpc(h, "GetJarvisProfileCommand");
        await closeProfile(h);
        steps.push(placeholderStep("6. while the profile reads, the modal holds its 96px block", loading, { height: 96, radius: "8px" }));

        await principlesEditorSteps(h, ctx, rec);
        await partialSaveStep(h, ctx, rec);
        return steps;
    },
    async teardown(h, ctx) {
        const undo = [
            ["release the refused project save", () => releaseRpc(h, "SetChannelProfileCommand")],
            ["close the profile", () => closeProfile(h)],
            ["restore the global profile", () => ctx.globalBefore && h.rpc("setglobalprofile", { profile: ctx.globalBefore })],
            ["clear the project's override", () => ctx.wroteOverride && h.rpc("setchannelprofile", { channelid: ctx.channelId, override: {} })],
            ["delete the channel", () => ctx.channelId && h.rpc("deletechannel", { channelid: ctx.channelId })],
            ["delete the project", () => ctx.project && h.rpc("deleteproject", { name: ctx.project })],
            ["remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true })],
            ["delete the second channel", () => ctx.channelId2 && h.rpc("deletechannel", { channelid: ctx.channelId2 })],
            ["delete the second project", () => ctx.project2 && h.rpc("deleteproject", { name: ctx.project2 })],
            ["remove the second temp dir", () => ctx.cwd2 && rmSync(ctx.cwd2, { recursive: true, force: true })],
        ];
        for (const [what, fn] of undo) {
            try {
                await fn();
            } catch (e) {
                console.error(`brief-profile teardown: ${what} failed: ${e?.message ?? e}`);
            }
        }
        await h.goto("cockpit");
    },
};

// --- brief-design-parity: the Brief drawn to its handoff design ----------------------------------
// The structural half of the parity review against docs/prototype/jarvis-brief-editing.dc.html
// (variant A); the visual half is cdp-shots/design/ (scripts/cdp/design-states.mjs) beside these shots.
// Runs against the design's data: arrange seeds the initiatives the store lacks (seed-brief.mjs), and
// teardown deletes only those it seeded. The autonomy chip (step b) draws only over a registered project, so
// a store with none (Final's) gets a throwaway project, removed with its channel in teardown.
const PARITY_INITIATIVE = "Scenario gate clearance";
const PARITY_CHUNK = "N1 box upgrade";
const PARITY_PROJECT = "brief-design-parity";
const parityNap = (h, ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
// wstore's normProjectPath, so a channel's path compares to the one the project was registered at
const parityNormPath = (p) => (p ?? "").replaceAll("\\", "/").replace(/\/+$/, "");

async function seedParityProject(h) {
    const projects = (await h.rpc("getfullconfig", null))?.projects ?? {};
    if (Object.values(projects).some((p) => p?.path)) return null;
    const path = mkdtempSync(join(tmpdir(), "arc-brief-parity-"));
    await h.rpc("createproject", { name: PARITY_PROJECT, path });
    const channels = (await h.rpc("getchannels", null))?.channels ?? [];
    const channelId = channels.find((c) => parityNormPath(c.projectpath) === parityNormPath(path))?.oid ?? null;
    return { path, channelId };
}

export const briefDesignParity = {
    name: "brief-design-parity",
    surface: "jarvis",
    async arrange(h) {
        const project = await seedParityProject(h);
        return { project, seeded: await seedBriefDesign(h) };
    },
    async assert(h, ctx) {
        const steps = [];
        await h.goto("jarvis");
        // a briefing fixture another scenario left on hides the live data, and only a reload clears it
        const fixtureOn = await h.ev(
            `[...document.querySelectorAll('[data-briefing-fixture]')].some((b) => b.className.includes('bg-accentbg'))`
        );
        if (fixtureOn) {
            try {
                await h.ev("location.reload()");
            } catch {
                /* the evaluate is cut off by the navigation it just started */
            }
            for (let waited = 0; waited < 30000; waited += 500) {
                const up = await h.ev("!!window.TabRpcClient && !!document.querySelector('nav button')").catch(() => false);
                if (up) break;
                await new Promise((r) => setTimeout(r, 500));
            }
            await h.goto("jarvis");
        }
        // a cold dev app draws the regions as empty skeletons first; wait for the seeded initiative's row
        for (let waited = 0; waited < 15000; waited += 500) {
            const up = await h.ev(
                `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].some((r) => r.innerText.includes(${JSON.stringify(PARITY_INITIATIVE)}))`
            );
            if (up) break;
            await parityNap(h, 500);
        }
        await parityNap(h, 900);

        // (a) the four region labels, as rendered (uppercase comes from CSS, which innerText applies).
        // a region's head is its first child: a button for waiting/initiatives, the button beside the kind
        // filter for runs, a div for behind; the label is its first span with text
        const labels = await h.ev(`[...document.querySelectorAll('section[data-jarvis-brief-region]')].map((s) =>
            [...s.querySelectorAll(':scope > :first-child span')].map((x) => x.innerText.trim()).find((t) => t !== '') ?? null)`);
        await h.shot("cdp-shots/brief-design-parity-a-regions.png");
        steps.push({
            step: "a. the region labels read WAITING ON YOU, INITIATIVES, RUNS, BEHIND YOU",
            ok: JSON.stringify(labels) === JSON.stringify(["WAITING ON YOU", "INITIATIVES", "RUNS", "BEHIND YOU"]),
            detail: JSON.stringify(labels),
        });

        // (b) header order, by document position inside the header
        const order = await h.ev(`(() => {
            const header = document.querySelector('[data-jarvis-region="brief"] > header');
            if (!header) return null;
            const all = [...header.querySelectorAll('*')];
            const at = (sel) => all.indexOf(header.querySelector(sel));
            return {
                fleet: at('[data-jarvis-brief-band="fleet"]'),
                filter: at('[data-jarvis-brief-filter]'),
                tier: at('[data-jarvis-autonomy="chip"]'),
                profile: at('[data-jarvis-brief-profile]'),
                initiative: at('[data-jarvis-new-initiative]'),
            };
        })()`);
        const seq = order ? [order.fleet, order.filter, order.tier, order.profile, order.initiative] : [];
        await h.shot("cdp-shots/brief-design-parity-b-header.png");
        steps.push({
            step: "b. the header runs fleet line, filter, autonomy, Profile, New initiative",
            ok: seq.length === 5 && seq.every((i, n) => i >= 0 && (n === 0 || i > seq[n - 1])),
            detail: JSON.stringify(order),
        });

        // (c) the expanded initiative: the row head carries the fraction, next chunk and blocked count, so the
        // plan beneath does not repeat them; its stages carry n/m fractions
        const ROW = `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => r.innerText.includes(${JSON.stringify(PARITY_INITIATIVE)}))`;
        const DETAIL = `${ROW}?.parentElement?.querySelector('[data-jarvis-initiative-detail="true"]')`;
        ctx.wasExpanded = (await h.ev(`${ROW}?.getAttribute('aria-expanded') ?? null`)) === "true";
        if (!ctx.wasExpanded) await h.ev(`${ROW}?.click()`);
        for (let waited = 0; waited < 3000 && !(await h.ev(`!!${DETAIL}`)); waited += 250) await parityNap(h, 250);
        const card = await h.ev(`(() => {
            const d = ${DETAIL};
            if (!d) return null;
            const text = d.innerText.replace(/\\s+/g, " ");
            const head = (${ROW}?.innerText ?? "").replace(/\\s+/g, " ");
            return {
                head: /2\\/6/.test(head) && /— N1 box upgrade/.test(head) && /1 blocked/.test(head),
                repeated: /of 6 done|Next:/.test(text),
                // a stage head's direct spans are the empty bar, then the fraction
                fractions: [...d.querySelectorAll('[data-jarvis-tracker-stage]')].map((s) =>
                    [...s.querySelectorAll(':scope > span')].map((x) => x.innerText.trim()).find((t) => t !== "") ?? null),
                footerId: d.querySelector('button[title="copy this initiative\\'s id"]')?.innerText.trim() ?? null,
            };
        })()`);
        await h.shot("cdp-shots/brief-design-parity-c-initiative.png");
        steps.push({
            step: `c. "${PARITY_INITIATIVE}" heads with 2/6, N1 box upgrade and 1 blocked, unrepeated below, with n/m stage fractions`,
            ok:
                card != null &&
                card.head &&
                !card.repeated &&
                card.fractions.length > 0 &&
                card.fractions.every((f) => typeof f === "string" && /^\d+\/\d+$/.test(f)),
            detail: JSON.stringify(card),
        });

        // (d) the footer id is the short oid
        await h.shot("cdp-shots/brief-design-parity-d-footer.png");
        steps.push({
            step: "d. the initiative footer shows an 8-character id",
            ok: typeof card?.footerId === "string" && /^[0-9a-f]{8}$/.test(card.footerId),
            detail: String(card?.footerId),
        });

        // (e) a Runs row carries its type badge
        const badges = await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-row="session"]')]
            .map((r) => r.querySelector(':scope > div > div > span')?.innerText.trim() ?? null)`);
        await h.shot("cdp-shots/brief-design-parity-e-runs.png");
        steps.push(
            badges.length > 0
                ? {
                      step: "e. a Runs row leads with a quick run / orchestrator / agent badge",
                      ok: badges.every((b) => ["quick run", "orchestrator", "agent"].includes(b)),
                      detail: JSON.stringify(badges),
                  }
                : skipStep(
                      "e. a Runs row leads with a quick run / orchestrator / agent badge",
                      "no run in this dev store - start any quick run (+ Run) and rerun"
                  )
        );

        // (f) Behind you's meta names the window it covers
        const behindMeta = await h.ev(
            `document.querySelector('section[data-jarvis-brief-region="behind"] > div:first-child > span:last-of-type')?.innerText.trim() ?? null`
        );
        await h.shot("cdp-shots/brief-design-parity-f-behind.png");
        steps.push({
            step: "f. Behind you's meta reads since … or the last 7 days",
            ok: typeof behindMeta === "string" && /^since |^the last 7 days$/.test(behindMeta),
            detail: String(behindMeta),
        });

        // (g) the Chunk sidebar's position
        await h.ev(`${DETAIL}?.querySelector('[data-jarvis-tracker-chunk="' + CSS.escape(${JSON.stringify(PARITY_CHUNK)}) + '"]')?.click()`);
        await parityNap(h, 500);
        const position = await h.ev(
            `document.querySelector('[data-jarvis-chunk-sidebar]')?.querySelector(':scope > div > span:nth-of-type(2)')?.innerText.trim() ?? null`
        );
        await h.shot("cdp-shots/brief-design-parity-g-sidebar.png");
        steps.push({
            step: "g. the Chunk sidebar shows its position as n / total",
            ok: typeof position === "string" && /^\d+ \/ \d+$/.test(position),
            detail: String(position),
        });

        // (h) the Runs kind filter narrows Runs to one badge, then all brings every row back
        const KIND = (k) => `document.querySelector('[data-jarvis-run-kind] [data-filter-option="${k}"]')`;
        const runBadges = `[...document.querySelectorAll('[data-jarvis-brief-row="session"]')].map((r) => r.querySelector(':scope > div > div > span')?.innerText.trim() ?? null)`;
        const before = await h.ev(runBadges);
        await h.ev(`${KIND("orchestrator")}?.click()`);
        await parityNap(h, 700);
        const orchOnly = await h.ev(runBadges);
        await h.shot("cdp-shots/brief-design-parity-h-runkind.png");
        await h.ev(`${KIND("all")}?.click()`);
        await parityNap(h, 700);
        const after = await h.ev(runBadges);
        steps.push({
            step: "h. the orchestrator filter leaves only orchestrator runs, and all restores the list",
            ok: orchOnly.every((b) => b === "orchestrator") && after.length === before.length,
            detail: JSON.stringify({ before: before.length, orchOnly, after: after.length }),
        });

        // (i) the Initiatives project filter narrows to one project's initiatives, then all brings every row back
        const PROJECT = (p) => `document.querySelector('[data-jarvis-initiative-project] [data-filter-option="${p}"]')`;
        const initiativeProjects = `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].map((r) => r.querySelector(':scope > div:first-child > span:nth-of-type(3)')?.innerText.trim().split(' · ').pop() ?? null)`;
        const options = await h.ev(
            `[...document.querySelectorAll('[data-jarvis-initiative-project] [data-filter-option]')].map((b) => b.dataset.filterOption)`
        );
        const picked = options.find((o) => o !== "all" && o !== "no project") ?? null;
        const allRows = await h.ev(initiativeProjects);
        if (picked != null) {
            await h.ev(`${PROJECT(picked)}?.click()`);
            await parityNap(h, 700);
        }
        const pickedRows = await h.ev(initiativeProjects);
        await h.shot("cdp-shots/brief-design-parity-i-project.png");
        await h.ev(`${PROJECT("all")}?.click()`);
        await parityNap(h, 700);
        const restored = await h.ev(initiativeProjects);
        steps.push({
            step: "i. the Initiatives project filter leaves only that project's initiatives, and all restores the list",
            ok:
                picked != null &&
                pickedRows.length > 0 &&
                pickedRows.every((p) => p === picked) &&
                pickedRows.length < allRows.length &&
                restored.length === allRows.length,
            detail: JSON.stringify({ options, picked, all: allRows.length, pickedRows, restored: restored.length }),
        });

        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(
            `[...(document.querySelector('[data-jarvis-chunk-sidebar]')?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === 'Close')?.click()`
        );
        if (ctx.wasExpanded === false) {
            await h.ev(
                `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"][aria-expanded="true"]')].find((r) => r.innerText.includes(${JSON.stringify(PARITY_INITIATIVE)}))?.click()`
            );
        }
        await h.goto("cockpit");
        for (const effortoid of ctx.seeded ?? []) {
            await h.rpc("effortdelete", { effortoid }).catch((e) => {
                console.warn(`brief-design-parity teardown: delete ${effortoid} failed: ${e?.message ?? e}`);
            });
        }
        if (ctx.project) {
            const warn = (what) => (e) => console.warn(`brief-design-parity teardown: ${what} failed: ${e?.message ?? e}`);
            // the project first: while it is registered, the config watcher recreates its channel
            await h.rpc("deleteproject", { name: PARITY_PROJECT }).catch(warn("delete the project"));
            if (ctx.project.channelId) {
                await h.rpc("deletechannel", { channelid: ctx.project.channelId }).catch(warn("delete its channel"));
            }
            try {
                rmSync(ctx.project.path, { recursive: true, force: true });
            } catch (e) {
                warn("remove its folder")(e);
            }
        }
    },
};

// --- resource linking: an address opens what it names --------------------------------------------------------
// The router's live check, driven through the DEV hook in linkingdevhooks.ts (the citation chips that used to
// carry these addresses went with the Ask thread). The addresses name real objects read from this profile,
// because every landing proves its target exists first — invented ids would only ever exercise the failure
// path. Nothing here writes. A profile missing a kind (no record holding a
// decision) SKIPS that step and names what to seed: the landing was
// never attempted, so neither a pass nor a failure would be a true reading of it.
export const resourceLinking = {
    name: "resource-linking",
    surface: "jarvis",
    async arrange(h) {
        const dossiers = (await h.rpc("listtaskdossiers", null))?.dossiers ?? [];
        let decided = null;
        for (const d of dossiers.slice(0, 25)) {
            const detail = await h.rpc("getdossier", { dossierid: d.id }).catch(() => null);
            const decision = detail?.decisions?.[0];
            if (decision) {
                decided = { dossierId: d.id, objective: d.objective, decisionId: decision.id };
                break;
            }
        }
        return {
            dossier: dossiers[0] ? { id: dossiers[0].id, objective: dossiers[0].objective } : null,
            decided,
        };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const waitFor = async (expr, ms) => {
            for (let waited = 0; waited < ms; waited += 250) {
                if ((await h.ev(expr)) === true) return true;
                await settle(250);
            }
            return false;
        };
        const toastText = () =>
            h.ev(`[...document.querySelectorAll('[data-notification-toast]')].map((t) => t.innerText).join(' | ')`);
        // the hook installs when the Brief mounts, and a reload undoes it, so every step re-arms it first
        const open = async (address, hint) => {
            await h.goto("jarvis");
            if (!(await waitFor(`typeof window.__openAddress === 'function'`, 5000))) return null;
            return h.ev(`window.__openAddress(${JSON.stringify(address)}, ${JSON.stringify(hint ?? null)})`);
        };
        const peekShows = (objective) =>
            waitFor(
                `(document.querySelector('[data-jarvis-brief-band="peek"]')?.innerText || '').includes(${JSON.stringify(
                    (objective || "").slice(0, 40)
                )})`,
                5000
            );
        // Escape closes the peek; waiting on the peek band keeps the next step from reading the previous step's
        // overlay
        const dismissOverlay = async () => {
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
            );
            await waitFor(`!document.querySelector('[data-jarvis-brief-band="peek"]')`, 2000);
        };

        await h.goto("jarvis");
        rec(
            "1. the DEV hook that opens an address is installed on the Brief",
            (await waitFor(`typeof window.__openAddress === 'function'`, 5000)) === true,
            ""
        );

        if (!ctx.dossier) {
            rec(
                "2. a record address opens the record's peek",
                false,
                "no record in this profile - seed one before reading this as a pass"
            );
        } else {
            const result = await open(`task:${ctx.dossier.id}`, { sourceType: "dossier" });
            const shown = await peekShows(ctx.dossier.objective);
            rec(
                "2. a record address opens the record's peek",
                result?.ok === true && shown,
                JSON.stringify({ result, shown, toasts: await toastText() })
            );
            await dismissOverlay();
        }

        if (!ctx.decided) {
            steps.push(
                skipStep(
                    "3. a decision address opens its record's peek",
                    "no record with a decision among the first 25 - record one before reading this as a pass"
                )
            );
        } else {
            const result = await open(`task:${ctx.decided.dossierId}`, {
                sourceType: "decision",
                anchor: ctx.decided.decisionId,
            });
            const shown = await peekShows(ctx.decided.objective);
            rec(
                "3. a decision address opens its record's peek",
                result?.ok === true && shown,
                JSON.stringify({ result, shown, toasts: await toastText() })
            );
            await dismissOverlay();
        }

        {
            // persisted work refs still carry memnote: addresses; one the vault no longer serves toasts and
            // opens nothing (a note that exists shows in the avatar popup)
            const result = await open("memnote:a-note-the-vault-no-longer-serves", { sourceType: "memory" });
            const surface = await h.activeSurfaceLabel();
            rec(
                "4. a memory address opens nothing and leaves the surface where it was",
                result?.ok === false && surface === SURFACE_LABEL.jarvis,
                JSON.stringify({ result, surface })
            );
        }

        await h.goto("jarvis");
        await waitFor(`typeof window.__openAddress === 'function'`, 5000);
        const result = await h.ev(`window.__openAddress("bogus:resource-linking-probe")`);
        await settle(400);
        const toasts = await toastText();
        const surface = await h.activeSurfaceLabel();
        rec(
            "5. an address nothing can open shows the toast and leaves the surface where it was",
            result?.reason === "unsupported" &&
                toasts.includes("This item can't be opened") &&
                surface === SURFACE_LABEL.jarvis,
            JSON.stringify({ result, toasts, surface })
        );
        await h.shot("cdp-shots/resource-linking.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// brief-live-initiative: the Brief follows initiatives changed out of band. Every change is a raw TabRpcClient call,
// the way `wsh effort` or an agent's tick reaches wavesrv, never the cockpit's effort store, so only wavesrv's
// effort:update event can bring it to the open Brief, which is never left or remounted.
const LIVE_TITLE = "verify brief-live-initiative: made out of band";
const LIVE_WAIT_MS = 60000; // a briefing reload is a FetchWorkState, ~14s warm
const LIVE_BURST = 5;
const LIVE_BURST_MAX_LOADS = 2; // a burst may straddle one window edge
const LIVE_SETTLE_MS = 3000;
const LIVE_ROW = `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => r.textContent.includes(${JSON.stringify(LIVE_TITLE)}))`;
const LIVE_BRIEF = `document.querySelector('[data-jarvis-region="brief"]')`;
const liveSettled = (h) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { briefingStateAtom } = await mod("app/view/jarvis/briefingstore.ts");
        const st = globalStore.get(briefingStateAtom);
        return !st.loading && st.snapshot != null;
    `);
async function liveWaitSettled(h, ms) {
    for (let waited = 0; waited < ms; waited += 250) {
        if (await liveSettled(h).catch(() => false)) return true;
        await polishNap(250);
    }
    return false;
}
// the Brief region node carries a mark set once: a remount or a surface switch drops it
const liveStillOpen = (h) => h.ev(`${LIVE_BRIEF}?.__liveMark === true`);
const liveLoads = (h) => h.ev(`window.__liveBriefLoads ?? -1`);
const liveCached = (h, oref) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
        const e = globalStore.get(effortDetailAtom).get(${JSON.stringify(oref)});
        if (!e) return null;
        const chunks = e.chunks ?? [];
        return { chunks: chunks.map((c) => c.label + ":" + c.status), notes: chunks.reduce((n, c) => n + (c.notes?.length ?? 0), 0) };
    `);
const liveRowText = (h) => h.ev(`((${LIVE_ROW})?.textContent ?? '').replace(/\\s+/g, ' ').trim()`);

export const briefLiveInitiative = {
    name: "brief-live-initiative",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        try {
            const efforts = (await h.rpc("effortlist", { includearchived: true }))?.efforts ?? [];
            for (const e of efforts.filter((x) => x.title === LIVE_TITLE)) {
                await h.rpc("effortdelete", { effortoid: e.oref.replace(/^effort:/, "") });
            }
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        await h.goto("jarvis");
        const settled = await liveWaitSettled(h, LIVE_WAIT_MS);
        await h.ev(`(() => { const b = ${LIVE_BRIEF}; if (b) b.__liveMark = true; })()`);
        // counts the briefing's reloads from here on; none can come from entering the Brief, which never happens again
        await lookEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            const real = (window.__liveBriefReal ??= RpcApi.JarvisStateCommand);
            window.__liveBriefLoads = 0;
            RpcApi.JarvisStateCommand = (...args) => { window.__liveBriefLoads++; return real.apply(RpcApi, args); };
        `);
        const absent = (await h.ev(`!(${LIVE_ROW})`)) === true;
        const marked = await liveStillOpen(h);
        rec("0. the Brief settles from its entry load, without the initiative", ctx.arrangeError == null && settled && absent && marked, {
            arrangeError: ctx.arrangeError,
            settled,
            absent,
            marked,
        });

        // 1. made by a raw rpc while the Brief stays open
        ctx.effortoid = (await h.rpc("effortcreate", { title: LIVE_TITLE, chunks: [{ label: "One" }, { label: "Two" }] }))?.effortoid;
        const oref = `effort:${ctx.effortoid}`;
        const appeared = await polishWaitFor(h, `!!(${LIVE_ROW})`, LIVE_WAIT_MS);
        await polishNap(400);
        const row1 = await liveRowText(h);
        await h.shot("cdp-shots/brief-live-initiative-1-created.png");
        const open1 = await liveStillOpen(h);
        const loads1 = await liveLoads(h);
        rec("1. an initiative made out of band appears on the open Brief, with no navigation", appeared && open1 && loads1 >= 1 && row1.includes("0/2"), {
            appeared,
            open1,
            loads1,
            row1,
        });

        // 2. a chunk ticked out of band: the row's count moves, and the cached detail (filled here, as an open sheet
        // fills it) refreshes with it
        await lookEval(h, `
            const { loadEffortDetail } = await mod("app/view/jarvis/effortstore.ts");
            await loadEffortDetail(${JSON.stringify(oref)});
        `);
        await h.rpc("effortmutate", { effortoid: ctx.effortoid, author: "you", ops: [{ op: "setChunkStatus", chunk: "One", status: "done" }] });
        const ticked = await polishWaitFor(h, `((${LIVE_ROW})?.textContent ?? '').includes('1/2')`, LIVE_WAIT_MS);
        await polishNap(400);
        const cached2 = await liveCached(h, oref);
        await h.shot("cdp-shots/brief-live-initiative-2-ticked.png");
        const open2 = await liveStillOpen(h);
        rec("2. a chunk ticked out of band moves the row to 1/2 and refreshes the cached detail", ticked && open2 && cached2?.chunks?.[0] === "One:done", {
            ticked,
            open2,
            cached2,
            row: await liveRowText(h),
        });

        // 3. a burst of ticks is one reload (two across a window edge), and the cache ends holding all of them
        await liveWaitSettled(h, LIVE_WAIT_MS);
        const notesBefore = (await liveCached(h, oref))?.notes ?? 0;
        await h.ev(`window.__liveBriefLoads = 0`);
        const note = (i) => ({ effortoid: ctx.effortoid, author: "you", ops: [{ op: "appendNote", chunk: "Two", note: `burst ${i}` }] });
        const burst = Array.from({ length: LIVE_BURST }, (_, i) => `window.TabRpcClient.wshRpcCall("effortmutate", ${JSON.stringify(note(i))}, {})`);
        await h.ev(`Promise.all([${burst.join(", ")}]).then(() => true)`);
        await polishNap(LIVE_SETTLE_MS);
        await liveWaitSettled(h, LIVE_WAIT_MS);
        const loads3 = await liveLoads(h);
        const cached3 = await liveCached(h, oref);
        rec(
            `3. ${LIVE_BURST} out-of-band ticks at once cost at most ${LIVE_BURST_MAX_LOADS} briefing reloads, and the cache holds all of them`,
            loads3 >= 1 && loads3 <= LIVE_BURST_MAX_LOADS && cached3?.notes === notesBefore + LIVE_BURST,
            { loads3, notesBefore, cached3 }
        );

        // 4. deleted out of band: the row leaves and the cached detail goes with it
        await h.rpc("effortdelete", { effortoid: ctx.effortoid });
        const gone = await polishWaitFor(h, `!(${LIVE_ROW})`, LIVE_WAIT_MS);
        let cached4 = await liveCached(h, oref);
        for (let waited = 0; cached4 != null && waited < LIVE_WAIT_MS; waited += 250) {
            await polishNap(250);
            cached4 = await liveCached(h, oref);
        }
        await h.shot("cdp-shots/brief-live-initiative-4-deleted.png");
        const open4 = await liveStillOpen(h);
        if (gone) ctx.effortoid = null;
        rec("4. an initiative deleted out of band leaves the open Brief and the detail cache", gone && cached4 == null && open4, { gone, cached4, open4 });

        // 5. the initiative panel: a fresh initiative's "updated" fact reads "just now", a status change counts in the Notes
        // header, and an attached run reads "run <8 chars> attached"
        const runId = "5f2d916b-1111-2222-3333-444455556666";
        ctx.effortoid = (await h.rpc("effortcreate", { title: LIVE_TITLE, chunks: [{ label: "One" }, { label: "Two" }] }))?.effortoid;
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.rpc("effortmutate", { effortoid: ctx.effortoid, author: "you", ops: [{ op: "setChunkStatus", chunk: "One", status: "active" }] });
        await h.rpc("effortmutate", { effortoid: ctx.effortoid, author: "you", ops: [{ op: "attachWork", chunk: "One", kind: "run", oref: `run:${runId}` }] });
        await h.ev(`window.__openAddress(${JSON.stringify(`effort:${ctx.effortoid}`)})`);
        const NOTES = `document.querySelector('[data-jarvis-effort-section="notes"]')`;
        const panelUp = await polishWaitFor(h, `!!${NOTES}`, LIVE_WAIT_MS);
        await polishNap(400);
        const panel = await h.ev(`(() => {
            const flat = (n) => (n?.textContent ?? '').replace(/\\s+/g, ' ').trim();
            const notes = ${NOTES};
            const updated = [...(notes?.closest('[aria-live]')?.querySelectorAll('span') ?? [])].map(flat).find((t) => /^updated /.test(t)) ?? '';
            const header = flat(notes?.firstElementChild);
            const m = header.match(/(\\d+) notes?/);
            return { updated, header, count: m ? Number(m[1]) : 0 };
        })()`);
        await h.shot("cdp-shots/brief-live-initiative-5-panel.png");
        // attach notes sit on the chunk's trail, which the feed leaves out, so the stored trail is what shows the wording
        const trail = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
            const e = globalStore.get(effortDetailAtom).get(${JSON.stringify(`effort:${ctx.effortoid}`)});
            return (e?.chunks ?? []).flatMap((c) => (c.notes ?? []).map((n) => n.text));
        `);
        rec(
            "5a. the initiative panel's updated fact reads \"just now\" without \"ago\"",
            panelUp && /^updated just now$/.test(panel.updated),
            JSON.stringify(panel)
        );
        rec("5b. after a status change the Notes header counts at least 1", panelUp && panel.count >= 1, JSON.stringify(panel));
        rec(
            "5c. an attached run's note reads \"run 5f2d916b attached\" with no run: prefix",
            Array.isArray(trail) && trail.includes("run 5f2d916b attached") && !trail.some((t) => t.includes("run:")),
            JSON.stringify({ trail })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await lookEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            if (window.__liveBriefReal) RpcApi.JarvisStateCommand = window.__liveBriefReal;
            delete window.__liveBriefReal;
            delete window.__liveBriefLoads;
        `).catch(() => {});
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        if (ctx?.effortoid) await h.rpc("effortdelete", { effortoid: ctx.effortoid }).catch(() => {});
    },
};

