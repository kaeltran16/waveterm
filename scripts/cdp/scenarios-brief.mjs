// Jarvis brief and peek scenarios: brief surface, peeks, avatar, inline tracker, record links.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";
import { seedBriefDesign } from "./seed-brief.mjs";
import {
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    OBS_NARROW,
    PEEKS_ESC,
    PROFILE_MODAL,
    TREE_RAIL_LEAD_ID,
    arrangeFixtureRun,
    closeProfile,
    failRpc,
    floorDetail,
    floorOk,
    floorStep,
    holdRpc,
    lookEval,
    lookPlaceholders,
    lookShot,
    openProfileOn,
    paintEval,
    placeholderStep,
    polishNap,
    polishReload,
    polishWaitFor,
    releaseRpc,
    reloadApp,
    restoreLocalStorage,
    setInputExpr,
    skipStep,
    teardownFixtureRun,
    usageRateLimits,
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

// --- brief-peek: a record oref lands in the Brief's peek, not on a Stage that is not there ------
// The only in-app path from the Brief to a record is the palette's Records group (B1's palette
// extension), because nothing on the Brief itself names a record: the Behind-you rows open runs, channels
// and initiatives, and the queue's rows address channels, runs and scan reports. So this drives that path.
// A profile with zero records fails step 2 with that stated in the detail rather than passing vacuously —
// read it as an environment gap, not a regression. A fresh store (the Final stage's) has no run for any record to
// attribute, so the arrange creates one: CreateRun captures a dossier that references it, and records list newest
// first, so that dossier is the first row step 2 opens. Held by deferstart, the run spawns nothing.
const BRIEF_PEEK_GOAL = "verify brief-peek: an attributed run, do nothing";
// the record CreateRun captures for that goal: jarvisdossier names it by the goal's slug
const BRIEF_PEEK_RECORD = "verify-brief-peek-an-attributed-run-do-nothing";
// a record saved with Windows line endings, which no RPC writes: seeded straight into the vault, removed in teardown
const BRIEF_PEEK_CRLF = "verify-brief-peek-crlf";
const BRIEF_PEEK_CRLF_HEAD = "Verify brief-peek reads a CRLF record.";
const BRIEF_PEEK_CRLF_REST = "Its body is what follows the headline.";
// found by its summary on a later run, so the seeded record keeps one rather than growing one per run
const BRIEF_PEEK_DECISION = "verify brief-peek: the anchored decision";
const BRIEF_PEEK_NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const DAY_MS = 24 * 60 * 60 * 1000;

// mirrors wconfig.resolveVaultRoot
async function vaultRoot(h) {
    const settings = (await h.rpc("getfullconfig", null))?.settings ?? {};
    const configured = settings["memory:vaultpath"] || settings["jarvis:vaultpath"];
    return configured ? configured.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), ".waveterm", "vault");
}

// stamped a month old so it sorts below the records the palette walk opens
async function seedCrlfRecord(h) {
    const dir = join(await vaultRoot(h), "tasks", "active");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${BRIEF_PEEK_CRLF}.md`);
    const stamp = Date.now() - 30 * DAY_MS;
    const lines = [
        "---",
        "status: paused",
        'ticket: ""',
        `objective: ${BRIEF_PEEK_CRLF_HEAD} ${BRIEF_PEEK_CRLF_REST}`,
        "acceptance: []",
        "confidence: med",
        `created: ${stamp}`,
        `updated: ${stamp}`,
        "---",
        "",
        "## Notes",
        "",
        "",
    ];
    writeFileSync(file, lines.join("\r\n"));
    return file;
}

async function ensurePeekDecision(h) {
    const detail = await h.rpc("getdossier", { dossierid: BRIEF_PEEK_RECORD });
    const have = (detail?.decisions ?? []).find((c) => c.summary === BRIEF_PEEK_DECISION);
    if (have != null) return have.id;
    const made = await h.rpc("appenddossierdecision", {
        dossierid: BRIEF_PEEK_RECORD,
        summary: BRIEF_PEEK_DECISION,
        rationale: "So the peek has a decision to anchor on.",
        links: [],
    });
    return made?.decisionid ?? null;
}

const PEEK_ANCHOR = `
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { pendingDecisionAnchorAtom } = await mod("app/view/jarvis/petstore.ts");
    return globalStore.get(pendingDecisionAnchorAtom);
`;

export const briefPeek = {
    name: "brief-peek",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-brief-peek-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-brief-peek", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: BRIEF_PEEK_GOAL,
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            // the capture names the record by its goal's slug, so a later run finds it already there and its capture
            // fails ("already exists"): attach this run to the record explicitly
            await h.rpc("acceptdossieredge", { dossierid: BRIEF_PEEK_RECORD, runoref: `run:${ctx.runId}` });
            // the decision step 14 anchors on; one added after the record was cached is step 15's
            try {
                ctx.decisionId = await ensurePeekDecision(h);
            } catch (e) {
                ctx.decisionError = String(e?.message ?? e);
            }
            // the Brief reads a boot-primed snapshot, so the RPC-created channel needs a reload
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        // the peek is session state, so a scenario that left one open would fail this one's first step.
        // Start from the state the scenario asserts into existence rather than from whatever ran before.
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
            step: "1. the Brief is showing and no peek is open yet",
            ok:
                (await h.ev(`!!document.querySelector('[data-jarvis-region="brief"]')`)) === true &&
                (await h.ev(`!document.querySelector('[data-jarvis-brief-band="peek"]')`)) === true,
            detail: "",
        });

        // Ctrl+P, not Ctrl+SHIFT+P: `bindings.ts` puts ONE chord on the search. Scenarios that dispatched
        // Ctrl+SHIFT+P matched no binding, so these steps had never once exercised the palette. All shows
        // only Recent and Go to until something is typed, so the Records scope chip is what lists records.
        // The entity sources load lazily on open, hence the settle before the group is looked for.
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        await h.ev(`document.querySelector('[data-palette-scope="records"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))");
        // the arrange reloaded the page, so the first record's detail is uncached and its skeleton draws before the
        // read lands: too briefly to poll for, so an observer records that it appeared
        await h.ev(`(() => {
            window.__briefPeekSawLoading = false;
            window.__briefPeekLoadingObs?.disconnect();
            window.__briefPeekLoadingObs = new MutationObserver(() => {
                if (document.querySelector('[data-jarvis-brief-band="peek"] [data-jarvis-peek-loading]')) {
                    window.__briefPeekSawLoading = true;
                }
            });
            window.__briefPeekLoadingObs.observe(document.body, { childList: true, subtree: true });
        })()`);
        const picked = await h.ev(`(() => {
            // scoped to the Records group's own container rather than a document-wide button query: the
            // palette renders several groups and the first button on the page is the app bar's search.
            const headers = [...document.querySelectorAll("div")].filter(
                (d) => (d.textContent || "").trim().toLowerCase() === "records"
            );
            if (headers.length === 0) return { ok: false, why: "no Records group in this profile" };
            const group = headers[0].parentElement;
            const row = group ? group.querySelector("button[data-idx]") : null;
            if (!row) return { ok: false, why: "Records group rendered no row" };
            const label = (row.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40);
            row.click();
            return { ok: true, why: label };
        })()`);
        // the record's detail loads after the peek opens, so wait for its status toggle rather than a fixed sleep
        await h.ev(`(async () => {
            for (let i = 0; i < 40 && !document.querySelector('[data-jarvis-brief-band="peek"] [data-jarvis-peek-status-toggle]'); i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
        })()`);
        const peek = await h.ev(`(() => {
            const band = document.querySelector('[data-jarvis-brief-band="peek"]');
            if (!band) return null;
            const text = (band.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                text: text.slice(0, 400),
                runsBand: /Runs on this record/.test(text),
                // updated, never a freshness word: a record carries no freshness reading
                updated: /updated (just now|.+ ago)|never updated/.test(text),
                fresh: /\\bFresh\\b/.test(text),
                statusToggle: !!band.querySelector("[data-jarvis-peek-status-toggle]"),
            };
        })()`);
        steps.push({
            step: "2. a record row in the palette opens the peek, with its updated stamp and status toggle",
            ok:
                picked.ok === true &&
                peek != null &&
                peek.updated === true &&
                peek.fresh === false &&
                peek.statusToggle === true,
            detail: JSON.stringify({ picked, peek }),
        });
        const loading = await h.ev(`(() => {
            window.__briefPeekLoadingObs?.disconnect();
            window.__briefPeekLoadingObs = undefined;
            return {
                saw: window.__briefPeekSawLoading === true,
                still: document.querySelector('[data-jarvis-brief-band="peek"] [data-jarvis-peek-loading]') != null,
            };
        })()`);
        steps.push({
            step: "2a. the body draws skeleton lines while the record loads",
            ok: loading.saw === true && loading.still === false,
            detail: JSON.stringify(loading),
        });
        // The runs band's content is data-dependent: a record with sessions attributed to it names them, and
        // one without says so instead. The band itself always renders (its rows, or the runs-absent line),
        // so its label is what the step reads, whichever of the two the data calls for.
        steps.push({
            step: "2b. the peek names the record's runs or says it has none",
            ok: peek != null && peek.runsBand === true,
            detail: JSON.stringify({ runsBand: peek?.runsBand ?? null }),
        });

        // The peek's run list is the record's attributed sessions, and clicking one is the path B5 re-homed
        // from the deleted record thread into the detail sheet: record -> attributed run -> the run's own
        // body. Not every record has one, so walk the Records rows the way the retired attribution scenario
        // walked the subjects column, until one opens a peek that lists a session.
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        // the peek lists its runs only after ResolveFocusScope returns, which reads each stored run's commit range
        // (about a second cold), so give the seeded record time before walking on
        let runRowId = await h.ev(`(async () => {
            for (let i = 0; i < 40; i++) {
                const b = document.querySelector('[data-jarvis-peek-run]');
                if (b) return b.dataset.jarvisPeekRun;
                await new Promise((r) => setTimeout(r, 250));
            }
            return null;
        })()`);
        const firstPeek =
            runRowId == null
                ? await h.ev(
                      `(document.querySelector('[data-jarvis-brief-band="peek"]')?.innerText || "").replace(/\\s+/g, " ").slice(0, 300)`
                  )
                : "";
        let tried = 1;
        for (let attempt = 1; attempt < 6 && runRowId == null; attempt++) {
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
            );
            await settle(300);
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
            );
            await settle(300);
            await h.ev(`document.querySelector('[data-palette-scope="records"]')?.click()`);
            await settle(500);
            const next = await h.ev(`(() => {
                const headers = [...document.querySelectorAll("div")].filter(
                    (d) => (d.textContent || "").trim().toLowerCase() === "records"
                );
                const group = headers[0]?.parentElement;
                const row = group ? [...group.querySelectorAll("button[data-idx]")][${attempt}] : null;
                if (!row) return false;
                row.click();
                return true;
            })()`);
            if (next !== true) break;
            await settle(900);
            tried += 1;
            runRowId = await h.ev(
                `(() => { const b = document.querySelector('[data-jarvis-peek-run]'); return b ? b.dataset.jarvisPeekRun : null; })()`
            );
        }
        // 2b passes on the band's label alone. The count beside it is the rollup itself: the arranged record has one
        // attributed run, so a rollup that finds the run's owning channel reads "1 channel" and one that does not
        // reads "0 channels".
        const fleetLine = await h.ev(`(() => {
            const text = (document.querySelector('[data-jarvis-brief-band="peek"]')?.innerText || "").replace(/\\s+/g, " ");
            return (text.match(/\\d+ working · \\d+ channels?/) || [null])[0];
        })()`);
        steps.push({
            step: "2c. the fleet line counts the channel that owns the record's run",
            ok: runRowId != null && typeof fleetLine === "string" && /· 1 channel$/.test(fleetLine),
            detail: JSON.stringify({ fleetLine, runRowId }),
        });

        if (runRowId == null) {
            steps.push({
                step: "3. the peek's attributed run opens the run's sheet",
                ok: false,
                detail: `no attributed run in the first ${tried} records — seed one before reading this as a pass${ctx.arrangeError ? `; seeding failed: ${ctx.arrangeError}` : ""}; first peek: ${firstPeek}`,
            });
        } else {
            await h.ev(`document.querySelector('[data-jarvis-peek-run]').click()`);
            await settle(1200);
            // the sheet is keyed by its SUBJECT (a channel), and the settings panel only renders when the
            // body resolved to the run itself rather than the launcher for a channel with nothing to show
            // The channel read is a pin plus the active-channel streams, so it lands in its own time — a
            // single read after a fixed sleep would call a slow channel a hung one. Poll for the sheet to
            // resolve, and only then judge it (the retired record-thread scenario polled for exactly this).
            const readSheet = () =>
                h.ev(`(() => {
                const el = document.querySelector('[data-jarvis-brief-sheet="channel"]');
                return el
                    ? {
                          face: el.dataset.jarvisBriefSheet,
                          state: el.querySelector('[data-jarvis-brief-sheet-state]')?.dataset.jarvisBriefSheetState ?? null,
                          runBody: el.querySelector('[data-jarvis-brief-sheet-face="settings"]') != null,
                          text: (el.innerText || '').slice(0, 80),
                          // the record modal sits above the sheet, so a sheet in the DOM can still be out of sight
                          // behind it: what is at the sheet's centre is what the user sees
                          peekOpen: document.querySelector('[data-jarvis-brief-band="peek"]') != null,
                          onTop: (() => {
                              const r = el.getBoundingClientRect();
                              return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
                          })(),
                      }
                    : null;
            })()`);
            let sheet = null;
            for (let waited = 0; waited <= 12000; waited += 400) {
                sheet = await readSheet();
                if (sheet != null && sheet.state !== "loading") break;
                await settle(400);
            }
            // The invariant is that the sheet RESOLVES: either the run's own body, or an explicit
            // "no longer available" when the channel a historical run names is gone. What it must never do
            // is sit under "Reading this channel…" — this profile's oldest records do name deleted channels,
            // which is exactly the case a skeleton-for-both-states hid.
            steps.push({
                step: "3. the peek's attributed run opens the run's sheet, resolved rather than pending",
                ok:
                    sheet?.face === "channel" &&
                    (sheet?.runBody === true || sheet?.state === "unavailable") &&
                    sheet?.state !== "loading",
                detail: JSON.stringify({ runRowId, sheet }),
            });
            steps.push({
                step: "3b. the peek steps aside, so the run's sheet is in sight rather than behind it",
                ok: sheet?.peekOpen === false && sheet?.onTop === true,
                detail: JSON.stringify({ peekOpen: sheet?.peekOpen ?? null, onTop: sheet?.onTop ?? null }),
            });
            await h.ev(`(() => {
                const b = document.querySelector('[aria-label="Close detail sheet"]');
                if (b) b.click();
                return true;
            })()`);
            await settle(400);
            // the run's open closed the peek, so the status steps reopen the same record: the walk's last row
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
            );
            await settle(300);
            await h.ev(`document.querySelector('[data-palette-scope="records"]')?.click()`);
            await settle(500);
            await h.ev(`(() => {
                const headers = [...document.querySelectorAll("div")].filter(
                    (d) => (d.textContent || "").trim().toLowerCase() === "records"
                );
                const group = headers[0]?.parentElement;
                group?.querySelectorAll("button[data-idx]")[${tried - 1}]?.click();
            })()`);
            await h.ev(`(async () => {
                for (let i = 0; i < 40 && !document.querySelector('[data-jarvis-brief-band="peek"] [data-jarvis-peek-status-toggle]'); i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
            })()`);
        }

        const BAND = `[data-jarvis-brief-band="peek"]`;
        const readSegments = () =>
            h.ev(`[...document.querySelectorAll('${BAND} [data-jarvis-peek-status-toggle] [data-jarvis-peek-status]')].map((el) => ({
                status: el.dataset.jarvisPeekStatus,
                control: el.tagName === "BUTTON",
                svg: el.querySelector("svg") != null,
                text: (el.textContent || "").trim(),
                pending: el.dataset.jarvisPeekPending ?? null,
            }))`);
        const currentStatus = async () => ((await readSegments()) ?? []).find((s) => !s.control)?.status ?? null;
        const waitCurrent = (status, ms) =>
            polishWaitFor(h, `document.querySelector('${BAND} span[data-jarvis-peek-status="${status}"]') != null`, ms);
        const clickSegment = (status) =>
            h.ev(`(() => {
                const b = document.querySelector('${BAND} button[data-jarvis-peek-status="${status}"]');
                if (b) b.click();
                return b != null;
            })()`);
        const clickConfirm = (label) =>
            h.ev(`(() => {
                const c = document.querySelector('${BAND} [data-jarvis-peek-confirm]');
                const b = c ? [...c.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === ${JSON.stringify(label)}) : null;
                if (b) b.click();
                return b != null;
            })()`);
        const storedStatus = async () =>
            (await h.rpc("getdossier", { dossierid: BRIEF_PEEK_RECORD }).catch((e) => ({ status: `error: ${e?.message ?? e}` })))
                ?.status ?? null;
        const pressEscape = () =>
            h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`);

        // the options are always on screen: no click opens them
        const rows = (await readSegments()) ?? [];
        const current = rows.filter((r) => !r.control);
        steps.push({
            step: "4. the status toggle offers only legal transitions, and the current status is a marked label",
            ok:
                rows.length >= 2 &&
                current.length === 1 &&
                current[0].svg === true &&
                rows.every((r) => ["active", "paused", "completed", "archived"].includes(r.status)) &&
                rows.every((r) => /^[A-Z][a-z]+$/.test(r.text)),
            detail: JSON.stringify(rows),
        });

        // the reopen above went through the palette, whose exit still fades over the modal's entrance
        await settle(600);
        await h.shot("cdp-shots/brief-peek.png");

        // the writes touch only the record this scenario seeded: the walk above can end on a user's record
        const openRecord = await h.ev(`document.querySelector('${BAND} [data-jarvis-peek-record]')?.dataset.jarvisPeekRecord ?? null`);
        if (openRecord !== BRIEF_PEEK_RECORD) {
            const detail = `the open record is ${openRecord}, not the seeded one; status writes skipped`;
            steps.push({ step: "4b. a terminal pick asks inline; Cancel writes nothing", ok: false, detail });
            steps.push({ step: "4c. Yes archives; only reactivating is offered", ok: false, detail });
            steps.push({ step: "4d. reactivating writes at once, no confirm", ok: false, detail });
        } else {
            const before = await currentStatus();
            if (before !== "active") {
                await clickSegment("active");
                await waitCurrent("active", 5000);
            }

            await clickSegment("archived");
            await settle(300);
            const asked = await h.ev(`(() => {
                const c = document.querySelector('${BAND} [data-jarvis-peek-confirm="archived"]');
                return {
                    confirm: c != null,
                    text: c ? (c.innerText || "").replace(/\\s+/g, " ").trim() : null,
                    pending: document.querySelector('${BAND} [data-jarvis-peek-status="archived"]')?.dataset.jarvisPeekPending ?? null,
                };
            })()`);
            await h.shot("cdp-shots/brief-peek-confirm.png");
            const cancelled = await clickConfirm("Cancel");
            await settle(300);
            const afterCancel = {
                confirmGone: await h.ev(`document.querySelector('${BAND} [data-jarvis-peek-confirm]') == null`),
                current: await currentStatus(),
                stored: await storedStatus(),
            };
            steps.push({
                step: "4b. a terminal pick asks inline; Cancel writes nothing",
                ok:
                    asked.confirm === true &&
                    (asked.text ?? "").includes("Mark this record archived?") &&
                    asked.pending === "archived" &&
                    cancelled === true &&
                    afterCancel.confirmGone === true &&
                    afterCancel.current === "active" &&
                    afterCancel.stored === "active",
                detail: JSON.stringify({ before, asked, cancelled, afterCancel }),
            });

            await clickSegment("archived");
            await settle(300);
            const confirmed = await clickConfirm("Yes, archived");
            const archived = await waitCurrent("archived", 5000);
            const archivedRows = (await readSegments()) ?? [];
            steps.push({
                step: "4c. Yes archives; only reactivating is offered",
                ok:
                    confirmed === true &&
                    archived === true &&
                    JSON.stringify(archivedRows.map((r) => [r.status, r.control])) ===
                        JSON.stringify([
                            ["active", true],
                            ["archived", false],
                        ]),
                detail: JSON.stringify({ confirmed, archived, archivedRows }),
            });
            await h.shot("cdp-shots/brief-peek-archived.png");

            // a confirm can come and go between two polls, so an observer records whether one ever appeared
            await h.ev(`(() => {
                window.__briefPeekSawConfirm = false;
                window.__briefPeekConfirmObs?.disconnect();
                window.__briefPeekConfirmObs = new MutationObserver(() => {
                    if (document.querySelector('${BAND} [data-jarvis-peek-confirm]')) window.__briefPeekSawConfirm = true;
                });
                window.__briefPeekConfirmObs.observe(document.body, { childList: true, subtree: true });
            })()`);
            const reactivated = (await clickSegment("active")) && (await waitCurrent("active", 5000));
            const sawConfirm = await h.ev(`(() => {
                window.__briefPeekConfirmObs?.disconnect();
                window.__briefPeekConfirmObs = undefined;
                return window.__briefPeekSawConfirm === true || document.querySelector('${BAND} [data-jarvis-peek-confirm]') != null;
            })()`);
            const storedAfter = await storedStatus();
            steps.push({
                step: "4d. reactivating writes at once, no confirm",
                ok: reactivated === true && sawConfirm === false && storedAfter === "active",
                detail: JSON.stringify({ reactivated, sawConfirm, stored: storedAfter }),
            });
        }

        await pressEscape();
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        steps.push({
            step: "5. Escape closes the peek and leaves the Brief behind it",
            ok:
                (await h.ev(`!document.querySelector('[data-jarvis-brief-band="peek"]')`)) === true &&
                (await h.ev(`!!document.querySelector('[data-jarvis-region="brief"]')`)) === true,
            detail: "",
        });

        // the avatar popup's record item mounts the same body, without a close of its own
        const ITEM = `[data-pet-peek-item="record"]`;
        const peekHook = await polishWaitFor(h, `typeof window.__peekAddress === 'function'`, 5000);
        if (peekHook) await h.ev(`window.__peekAddress(${JSON.stringify("task:" + BRIEF_PEEK_RECORD)})`);
        const popupReady = peekHook && (await polishWaitFor(h, `document.querySelector('${ITEM} [data-jarvis-peek-status-toggle]') != null`, 6000));
        const popupRuns = popupReady && (await polishWaitFor(h, `document.querySelector('${ITEM} [data-jarvis-peek-run]') != null`, 10000));
        const popup = await h.ev(`(() => {
            const body = document.querySelector('${ITEM} [data-jarvis-peek-record]');
            return body
                ? { record: body.dataset.jarvisPeekRecord, close: body.querySelector('[aria-label="Close"]') != null }
                : null;
        })()`);
        await h.shot("cdp-shots/brief-peek-popup.png");
        await h.ev(`document.querySelector('[data-pet-peek] button[aria-label="Close Jarvis panel"]')?.click()`);
        const popupClosed = await polishWaitFor(h, `!document.querySelector('[data-pet-peek-item]')`, 3000);
        steps.push({
            step: "6. the avatar popup's record item draws the same body",
            ok:
                popupReady === true &&
                popupRuns === true &&
                popup?.record === BRIEF_PEEK_RECORD &&
                popup?.close === false &&
                popupClosed === true,
            detail: JSON.stringify({ peekHook, popupReady, popupRuns, popup, popupClosed }),
        });

        const recordHook = await polishWaitFor(h, `typeof window.__recordPeekFor === 'function'`, 5000);
        if (recordHook) await h.ev(`window.__recordPeekFor('verify-brief-peek-no-such-record')`);
        const errored = recordHook && (await polishWaitFor(h, `document.querySelector('${BAND} [data-jarvis-peek-error]') != null`, 6000));
        const failedRead = await h.ev(`(() => {
            const el = document.querySelector('${BAND} [data-jarvis-peek-error]');
            return {
                text: el ? (el.innerText || "").trim().slice(0, 200) : null,
                loading: document.querySelector('${BAND} [data-jarvis-peek-loading]') != null,
            };
        })()`);
        await h.shot("cdp-shots/brief-peek-error.png");
        await pressEscape();
        const errorClosed = await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);
        steps.push({
            step: "7. a record that cannot be read says so instead of loading forever",
            ok:
                errored === true &&
                (failedRead.text ?? "").startsWith("Could not read this record") &&
                failedRead.loading === false &&
                errorClosed === true,
            detail: JSON.stringify({ recordHook, errored, failedRead, errorClosed }),
        });

        // a real read lands too quickly to photograph, so a held one on a made-up id keeps the skeleton up
        if (recordHook) await h.ev(`window.__recordPeekFor('verify-brief-peek-loading', { hold: true })`);
        await settle(300);
        const held = await h.ev(`({
            loading: document.querySelector('${BAND} [data-jarvis-peek-loading]') != null,
            error: document.querySelector('${BAND} [data-jarvis-peek-error]') != null,
        })`);
        await h.shot("cdp-shots/brief-peek-loading.png");
        await pressEscape();
        const heldClosed = await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);
        steps.push({
            step: "7b. a record still loading holds its skeleton, not an error",
            ok: recordHook === true && held.loading === true && held.error === false && heldClosed === true,
            detail: JSON.stringify({ held, heldClosed }),
        });

        // a record with no objective, no decisions and no runs: no RPC can make one, so the detail is seeded
        const EMPTY_ID = "verify-brief-peek-empty";
        const emptyDetail = {
            id: EMPTY_ID,
            ticket: "",
            objective: "",
            acceptance: [],
            confidence: "",
            status: "active",
            created: 0,
            updated: 0,
            state: "",
            blockers: [],
            refs: [],
            notes: "",
            decisions: [],
        };
        if (recordHook) await h.ev(`window.__recordPeekFor(${JSON.stringify(EMPTY_ID)}, { detail: ${JSON.stringify(emptyDetail)} })`);
        const emptyReady =
            recordHook && (await polishWaitFor(h, `document.querySelector('${BAND} [data-jarvis-peek-status-toggle]') != null`, 6000));
        // the runs are unknown until the record's scope read settles, so the absence is waited for, not read at once
        await polishWaitFor(h, `document.querySelector('${BAND} [data-jarvis-peek-runs-loading]') == null`, 8000);
        const empty = await h.ev(`(() => {
            const band = document.querySelector('${BAND}');
            if (!band) return null;
            const title = band.querySelector("[data-jarvis-peek-title]");
            const body = band.querySelector("[data-jarvis-peek-body]");
            const probe = document.createElement("span");
            probe.className = "text-muted";
            band.appendChild(probe);
            const muted = getComputedStyle(probe).color;
            probe.remove();
            return {
                title: title ? (title.textContent || "").trim() : null,
                titleFont: title ? getComputedStyle(title).fontFamily : null,
                body: body ? (body.textContent || "").trim() : null,
                bodyColor: body ? getComputedStyle(body).color : null,
                muted,
                text: (band.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400),
            };
        })()`);
        steps.push({
            step: "8. a record with nothing yet titles itself by its id and says what it lacks",
            ok:
                emptyReady === true &&
                empty != null &&
                empty.title === EMPTY_ID &&
                /mono/i.test(empty.titleFont ?? "") &&
                empty.body === "This record states no objective yet." &&
                empty.bodyColor === empty.muted &&
                empty.text.includes("No session has ever been attributed to this record.") &&
                empty.text.includes("never updated") &&
                empty.text.includes("No decisions yet"),
            detail: JSON.stringify({ emptyReady, empty }),
        });
        // the toggle mounts on the panel's first frame, so the wait above ends while the modal still fades in
        await settle(600);
        await h.shot("cdp-shots/brief-peek-empty.png");
        await pressEscape();
        await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);

        // F1: a CRLF record parses like any other, so its front matter is read rather than shown as its body
        let crlfError = null;
        try {
            ctx.crlfFile = await seedCrlfRecord(h);
        } catch (e) {
            crlfError = String(e?.message ?? e);
        }
        if (recordHook) await h.ev(`window.__recordPeekFor(${JSON.stringify(BRIEF_PEEK_CRLF)})`);
        const crlfReady =
            recordHook &&
            (await polishWaitFor(
                h,
                `document.querySelector('${BAND} [data-jarvis-peek-status-toggle], ${BAND} [data-jarvis-peek-error]') != null`,
                6000
            ));
        const crlf = await h.ev(`(() => {
            const band = document.querySelector('${BAND}');
            if (!band) return null;
            return {
                record: band.querySelector('[data-jarvis-peek-record]')?.dataset.jarvisPeekRecord ?? null,
                title: (band.querySelector('[data-jarvis-peek-title]')?.textContent || '').trim(),
                current: band.querySelector('[data-jarvis-peek-status-toggle] span[data-jarvis-peek-status]')?.dataset.jarvisPeekStatus ?? null,
                statusButtons: band.querySelectorAll('[data-jarvis-peek-status-toggle] button[data-jarvis-peek-status]').length,
                body: (band.querySelector('[data-jarvis-peek-body]')?.textContent || '').trim(),
                error: (band.querySelector('[data-jarvis-peek-error]')?.textContent || '').trim() || null,
            };
        })()`);
        await settle(600);
        await h.shot("cdp-shots/brief-peek-crlf.png");
        steps.push({
            step: "9. a CRLF record opens with its headline title, its status and its body, not its front matter",
            ok:
                crlfError == null &&
                crlfReady === true &&
                crlf?.record === BRIEF_PEEK_CRLF &&
                crlf.title === BRIEF_PEEK_CRLF_HEAD &&
                crlf.current === "paused" &&
                crlf.statusButtons > 0 &&
                !crlf.body.startsWith("---") &&
                crlf.body === BRIEF_PEEK_CRLF_REST,
            detail: JSON.stringify({ crlfError, crlfReady, crlf }),
        });
        await pressEscape();
        await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);

        // F5: with the scope read held, the runs table is loading, never "no session has ever been attributed"
        await holdRpc(h, "ResolveFocusScopeCommand");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const S = await mod("app/view/jarvis/jarvissubjectstore.ts");
            for (const a of [S.recordRunsAtom, S.recordScopeAtom]) {
                const next = { ...globalStore.get(a) };
                delete next[${JSON.stringify(BRIEF_PEEK_RECORD)}];
                globalStore.set(a, next);
            }
        `);
        if (recordHook) await h.ev(`window.__recordPeekFor(${JSON.stringify(BRIEF_PEEK_RECORD)})`);
        const heldReady =
            recordHook && (await polishWaitFor(h, `document.querySelector('${BAND} [data-jarvis-peek-status-toggle]') != null`, 6000));
        await settle(400);
        const heldRuns = await h.ev(`(() => {
            const band = document.querySelector('${BAND}');
            return {
                skeletonRows: band?.querySelector('[data-jarvis-peek-runs-loading]')?.children.length ?? 0,
                absent: /No session has ever been attributed/.test(band?.innerText || ''),
                rows: band?.querySelectorAll('[data-jarvis-peek-run]').length ?? 0,
            };
        })()`);
        await h.shot("cdp-shots/brief-peek-runs-loading.png");
        await releaseRpc(h, "ResolveFocusScopeCommand");
        await lookEval(h, `
            const S = await mod("app/view/jarvis/jarvissubjectstore.ts");
            await S.reloadRecordScope(${JSON.stringify(BRIEF_PEEK_RECORD)});
        `).catch(() => {});
        const runsBack = await polishWaitFor(h, `document.querySelector('${BAND} [data-jarvis-peek-run]') != null`, 10000);
        const loadingGone = await h.ev(`document.querySelector('${BAND} [data-jarvis-peek-runs-loading]') == null`);
        steps.push({
            step: "10. while the record's runs load, the table shows skeleton rows and claims no absence; then the rows land",
            ok:
                heldReady === true &&
                heldRuns.skeletonRows === 3 &&
                heldRuns.absent === false &&
                heldRuns.rows === 0 &&
                runsBack === true &&
                loadingGone === true,
            detail: JSON.stringify({ heldReady, heldRuns, runsBack, loadingGone }),
        });

        // F12: a run row reads as one line of prose, never markdown
        const heads = await h.ev(
            `[...document.querySelectorAll('${BAND} [data-jarvis-peek-run]')].map((b) => (b.children[1]?.textContent || '').trim())`
        );
        steps.push({
            step: "11. the run rows' headlines carry no heading marks or code ticks",
            ok: Array.isArray(heads) && heads.length > 0 && heads.every((t) => t !== "" && !/[#`]/.test(t)),
            detail: JSON.stringify({ heads }),
        });

        // F4: the footer's count is the toggle for the record's log, Add decision included; checked narrow
        await h.cdp("Emulation.setDeviceMetricsOverride", BRIEF_PEEK_NARROW);
        await settle(400);
        const TOGGLE = `document.querySelector('${BAND} [data-jarvis-peek-decisions]')`;
        const LOG = `${BAND} [data-jarvis-peek-decision-log]`;
        const readLog = () =>
            h.ev(`(() => {
                const toggle = ${TOGGLE};
                const add = document.querySelector('${LOG} [data-jarvis-decision-add]');
                const r = add?.getBoundingClientRect();
                return {
                    label: toggle ? (toggle.textContent || '').trim() : null,
                    expanded: toggle?.getAttribute('aria-expanded') ?? null,
                    log: document.querySelector('${LOG}') != null,
                    add: add != null && /Add decision/.test(add.textContent || ''),
                    addInSight: r != null && r.height > 0 && add.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)),
                };
            })()`);
        await h.ev(`${TOGGLE}?.click()`);
        await settle(500);
        const logOpen = await readLog();
        await h.shot("cdp-shots/brief-peek-decisions.png");
        await h.ev(`${TOGGLE}?.click()`);
        await settle(300);
        const logClosed = await readLog();
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        steps.push({
            step: "12. the footer's decisions count opens the record's log with Add decision in sight, and closes it",
            ok:
                /^(No decisions yet|\d+ decisions?)$/.test(logOpen.label ?? "") &&
                logOpen.expanded === "true" &&
                logOpen.log === true &&
                logOpen.add === true &&
                logOpen.addInSight === true &&
                logClosed.expanded === "false" &&
                logClosed.log === false,
            detail: JSON.stringify({ logOpen, logClosed }),
        });

        // F2: Escape in the Add decision form cancels the form, and the peek around it stays
        await h.ev(`${TOGGLE}?.click()`);
        await settle(300);
        await h.ev(`document.querySelector('${LOG} [data-jarvis-decision-add]')?.click()`);
        await settle(300);
        const FORM_INPUT = `document.querySelector('${LOG} [data-jarvis-decision-form] input')`;
        const typed = await h.ev(setInputExpr(FORM_INPUT, "typed, then abandoned"));
        await h.ev(
            `${FORM_INPUT}?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await settle(400);
        const afterEsc = await h.ev(`({
            form: document.querySelector('${LOG} [data-jarvis-decision-form]') != null,
            add: document.querySelector('${LOG} [data-jarvis-decision-add]') != null,
            peek: document.querySelector('${BAND}') != null,
        })`);
        steps.push({
            step: "13. Escape in the Add decision form closes the form and leaves the peek open",
            ok: typed === true && afterEsc.form === false && afterEsc.add === true && afterEsc.peek === true,
            detail: JSON.stringify({ typed, afterEsc }),
        });
        await pressEscape();
        await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);

        // F4: an open anchored on a decision shows the log with that card lit; the anchor clears after its flash,
        // and a close before the flash ends clears it too
        const decisionId = ctx.decisionId ?? null;
        const decisionError = ctx.decisionError ?? (decisionId == null ? "no decision was seeded" : null);
        const CARD = `document.querySelector('${BAND} [data-jarvis-decision="${decisionId}"]')`;
        const cardLit = `(() => {
            const c = ${CARD};
            if (!c || c.dataset.jarvisDecisionHighlighted == null) return false;
            const r = c.getBoundingClientRect();
            return r.height > 0 && c.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12)));
        })()`;
        const openAnchored = () =>
            h.ev(
                `window.__openAddress?.(${JSON.stringify("task:" + BRIEF_PEEK_RECORD)}, { anchor: ${JSON.stringify(decisionId)} })`
            );
        if (decisionId != null) await openAnchored();
        const lit = decisionId != null && (await polishWaitFor(h, cardLit, 8000));
        await h.shot("cdp-shots/brief-peek-anchor.png");
        let anchorAfterFlash = await lookEval(h, PEEK_ANCHOR);
        for (let i = 0; i < 16 && anchorAfterFlash != null; i++) {
            await settle(250);
            anchorAfterFlash = await lookEval(h, PEEK_ANCHOR);
        }
        await pressEscape();
        await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);
        if (decisionId != null) await openAnchored();
        const relit = decisionId != null && (await polishWaitFor(h, cardLit, 6000));
        const anchorWhileOpen = await lookEval(h, PEEK_ANCHOR);
        await pressEscape();
        await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);
        const anchorAfterClose = await lookEval(h, PEEK_ANCHOR);
        steps.push({
            step: "14. an anchored open shows the log with the decision lit; the anchor clears after the flash and on close",
            ok:
                decisionError == null &&
                lit === true &&
                anchorAfterFlash == null &&
                relit === true &&
                anchorWhileOpen === decisionId &&
                anchorAfterClose == null,
            detail: JSON.stringify({ decisionId, decisionError, lit, anchorAfterFlash, relit, anchorWhileOpen, anchorAfterClose }),
        });

        // F4: a decision an agent appends after the record is cached (step 14 opened it) is still found by an
        // anchored open. Each run appends one, as an agent would; no RPC removes a decision.
        let fresh = null;
        let freshError = null;
        try {
            const made = await h.rpc("appenddossierdecision", {
                dossierid: BRIEF_PEEK_RECORD,
                summary: `verify brief-peek: a decision added after the cache ${Date.now()}`,
                rationale: "So an anchored open has a decision the cached record does not hold.",
                links: [],
            });
            fresh = made?.decisionid ?? null;
        } catch (e) {
            freshError = String(e?.message ?? e);
        }
        const FRESH_CARD = `document.querySelector('${LOG} [data-jarvis-decision="${fresh}"]')`;
        if (fresh != null) {
            await h.ev(
                `window.__openAddress?.(${JSON.stringify("task:" + BRIEF_PEEK_RECORD)}, { anchor: ${JSON.stringify(fresh)} })`
            );
        }
        const freshShown = fresh != null && (await polishWaitFor(h, `${FRESH_CARD} != null`, 8000));
        const freshLog = await readLog();
        await h.shot("cdp-shots/brief-peek-anchor-fresh.png");
        await pressEscape();
        await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);
        steps.push({
            step: "15. an anchored open of a decision appended after the record was cached opens the log on its card",
            ok: freshError == null && freshShown === true && freshLog.expanded === "true" && freshLog.log === true,
            detail: JSON.stringify({ fresh, freshError, freshShown, freshLog }),
        });
        return steps;
    },
    async teardown(h, ctx) {
        // best-effort, so one failed step does not strand the rest; the run's dossier stays in the vault
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`brief-peek teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("close the popup", () =>
            h.ev(`document.querySelector('[data-pet-peek] button[aria-label="Close Jarvis panel"]')?.click()`)
        );
        await step("release the scope read", () => releaseRpc(h, "ResolveFocusScopeCommand"));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        if (ctx?.crlfFile) await step("remove the CRLF record", () => rmSync(ctx.crlfFile, { force: true }));
        // a failure between 4c's archive and 4d's reactivation must not leave the seeded record archived
        await step("reactivate the record", () =>
            h.rpc("setdossierstatus", { dossierid: BRIEF_PEEK_RECORD, status: "active" })
        );
        // detached, so the record keeps one run ref across runs rather than growing one per run
        if (ctx?.runId) {
            await step("detach the run from the record", () =>
                h.rpc("detachdossieredge", { dossierid: BRIEF_PEEK_RECORD, runoref: `run:${ctx.runId}` })
            );
            await step("cancel the run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId }));
        }
        if (ctx?.channelId) await step("delete the channel", () => h.rpc("deletechannel", { channelid: ctx.channelId }));
        if (ctx?.cwd) await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await h.goto("cockpit");
    },
};

// --- peek-ctrl-click: Ctrl+click on a Brief run row peeks it in the avatar popup and writes no selection ---
// A peek is a look, not a landing: the host surface, its active subject, the open-sheet flag and the Brief list's
// scroll must be exactly what they were, both while the item view is up and after Escape closes it.
// The row is selected on the bare [data-peek] attribute, never a value: the Brief's rows set it as "" and the
// fleet row as "true".
const PEEK_CTRL_BRIEF = `document.querySelector('[data-jarvis-region="brief"]')`;
const PEEK_CTRL_GOAL = "verify peek-ctrl-click: do nothing";

export const peekCtrlClick = {
    name: "peek-ctrl-click",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-peek-ctrl-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-peek-ctrl", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: PEEK_CTRL_GOAL,
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            // the Brief reads a boot-primed snapshot, so the RPC-created channel needs a reload
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        await h.goto("jarvis");
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        // a wide window: the popup's 560px cap only shows when the viewport leaves room for it
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("jarvis");
        await settle(900);

        // the probe is installed by the Brief once it mounts
        const probeReady = await h.ev(`(async () => {
            for (let i = 0; i < 20 && typeof window.__peekProbe !== "function"; i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            return typeof window.__peekProbe === "function";
        })()`);
        const hostState = () =>
            h.ev(`(() => {
                const scroller = ${PEEK_CTRL_BRIEF}?.querySelector(".overflow-y-auto");
                const p = window.__peekProbe();
                return JSON.stringify({
                    surface: p.surface,
                    subject: p.subject,
                    sheetOpen: p.sheetOpen,
                    scrollTop: scroller ? scroller.scrollTop : null,
                });
            })()`);

        // the briefing loads after the Brief mounts, and on a freshly booted app its rows can take seconds
        await polishWaitFor(h, `!!${PEEK_CTRL_BRIEF}?.querySelector("[data-peek]")`, 15000);
        const box = await h.ev(`(() => {
            const region = ${PEEK_CTRL_BRIEF};
            const row =
                region?.querySelector('[data-jarvis-brief-row="session"][data-peek]') ??
                region?.querySelector("[data-peek]");
            if (!row) return null;
            row.scrollIntoView({ block: "nearest" });
            const r = row.getBoundingClientRect();
            return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2), row: row.dataset.jarvisBriefRow ?? null };
        })()`);
        steps.push({
            step: "1. the Brief shows a peekable run row",
            ok: probeReady === true && box != null,
            detail: JSON.stringify({ probeReady, box, arrangeError: ctx.arrangeError ?? null }),
        });
        if (box == null || probeReady !== true) return steps;

        // Ctrl held over a peekable link (ctrlheld.ts): the [data-peek] rule in tailwindsetup.css underlines it in the
        // accent and turns the cursor to zoom-in, and the footer lights its peek chip. Colors are compared resolved,
        // against a probe painted with the accent token.
        const ctrlMod = 2;
        const ctrlKey = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 };
        const affordance = () =>
            h.ev(`(() => {
                const region = ${PEEK_CTRL_BRIEF};
                const row =
                    region?.querySelector('[data-jarvis-brief-row="session"][data-peek]') ??
                    region?.querySelector("[data-peek]");
                const probe = document.createElement("span");
                probe.style.color = "var(--color-accent)";
                document.body.appendChild(probe);
                const accent = getComputedStyle(probe).color;
                probe.remove();
                const cs = row ? getComputedStyle(row) : null;
                const glyph = [...document.querySelectorAll("span")].find((s) => s.textContent.trim() === "space · ctrl+click");
                return {
                    flag: document.documentElement.hasAttribute("data-ctrl-held"),
                    hovered: row?.matches(":hover") ?? false,
                    underline: cs?.textDecorationLine ?? null,
                    underlineAccent: cs != null && cs.textDecorationColor === accent,
                    cursor: cs?.cursor ?? null,
                    chip: glyph == null ? null : getComputedStyle(glyph).borderTopColor === accent ? "lit" : "unlit",
                };
            })()`);
        await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
        await h.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...ctrlKey, modifiers: ctrlMod });
        await settle(250);
        const held = await affordance();
        await h.shot("cdp-shots/peek-ctrl-held.png");
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...ctrlKey });
        await settle(250);
        const released = await affordance();
        steps.push({
            step: "2. holding Ctrl over the row underlines it in the accent, shows zoom-in and lights the footer's peek chip",
            ok:
                held.flag === true &&
                held.hovered === true &&
                held.underline === "underline" &&
                held.underlineAccent === true &&
                held.cursor === "zoom-in" &&
                held.chip === "lit" &&
                released.flag === false &&
                released.underline !== "underline" &&
                released.chip === "unlit",
            detail: JSON.stringify({ held, released }),
        });

        await settle(200);
        const before = await hostState();
        await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, modifiers: ctrlMod });
        for (const type of ["mousePressed", "mouseReleased"]) {
            await h.cdp("Input.dispatchMouseEvent", {
                type,
                x: box.x,
                y: box.y,
                button: "left",
                clickCount: 1,
                modifiers: ctrlMod,
            });
        }
        const ready = await h.ev(`(async () => {
            for (let i = 0; i < 40; i++) {
                const el = document.querySelector('[data-pet-peek-item="run"][data-pet-peek-status="ready"]');
                if (el) return true;
                await new Promise((r) => setTimeout(r, 250));
            }
            return false;
        })()`);
        // let the reveal and size-layout animations finish before measuring
        await settle(600);
        // the 560px cap is on the dialog's parent (the popup's outer box); the dialog itself is 2px narrower
        const panel = await h.ev(`(() => {
            const el = document.querySelector('[data-pet-peek-item="run"]');
            const outer = el?.parentElement;
            return el && outer ? { status: el.dataset.petPeekStatus, shape: el.dataset.petPeekShape, width: Math.round(outer.getBoundingClientRect().width) } : null;
        })()`);
        await h.shot("cdp-shots/peek-ctrl-click.png");
        steps.push({
            step: "3. Ctrl+click opens a ready run item view in the 560px popup",
            ok: ready === true && panel?.shape === "item" && panel?.width === 560,
            detail: JSON.stringify(panel),
        });

        const during = await hostState();
        steps.push({
            step: "4. the host surface, subject, sheet flag and scroll are unchanged while the peek is up",
            ok: before === during,
            detail: JSON.stringify({ before, during }),
        });

        // a real key event: the popup handles Escape on its dialog, which holds focus, not on the document
        for (const type of ["keyDown", "keyUp"]) {
            await h.cdp("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        }
        await settle(500);
        const closed = await h.ev(`!document.querySelector('[data-pet-peek-item]')`);
        const after = await hostState();
        steps.push({
            step: "5. Escape closes the popup and the host's state still matches",
            ok: closed === true && before === after,
            detail: JSON.stringify({ closed, before, after }),
        });
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`peek-ctrl-click teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        if (ctx?.runId) {
            await step("cancel the run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId }));
        }
        if (ctx?.channelId) await step("delete the channel", () => h.rpc("deletechannel", { channelid: ctx.channelId }));
        if (ctx?.cwd) await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await h.goto("cockpit");
    },
};

// --- peek-item-views: the avatar popup's item view for each peekable kind ----------------------------------
// The cockpit-peek mockup's PeekAgent, PeekEffort, PeekNote, PeekRun and States boards. Each kind is
// peeked through the one router (linkingdevhooks.ts's __peekAddress) on a fixture: the fixture roster's lead for
// the agent, its deferred orchestrator run for the phase strip, and an initiative made here. The note is
// arrangePeekItemsNote's. __peekLoading holds the loading frame a real
// load leaves too quickly to photograph, and the gone line is the initiative peeked again after it was deleted: the
// peek's load trusts the cached entry, and the body's own refetch finds it missing.
const PEEK_ITEMS_LEAD = "peek-items lead";
const PEEK_ITEMS_EFFORT = "Peek item views initiative";

const PEEK_ITEMS_NOTE = "peek-items-fixture";
const PEEK_ITEMS_NOTE_TITLE = "Peek fixture note";

const newestMemoryNote = async (h) => {
    const nodes = (await h.rpc("vaultgraph", null))?.nodes ?? [];
    const note = nodes.filter((n) => n.kind === "memory").sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
    return note ? { id: note.id, label: note.label } : null;
};

// The newest memory note already in the vault, read and never written. A vault with none, which is the fresh
// profile's default vault under a Final, gets one fixture note, removed in teardown. The root mirrors
// wconfig.resolveVaultRoot, and the vault graph must then list the note, so a wrong root fails here instead of
// leaving a stray file.
async function arrangePeekItemsNote(h, ctx) {
    ctx.note = await newestMemoryNote(h);
    if (ctx.note != null) return;
    const root = await vaultRoot(h);
    ctx.noteFile = join(root, "memory", `${PEEK_ITEMS_NOTE}.md`);
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(
        ctx.noteFile,
        `---\ntitle: ${PEEK_ITEMS_NOTE_TITLE}\n---\n\nA memory note the peek-item-views scenario writes into an empty vault and removes after.\n`
    );
    ctx.note = await newestMemoryNote(h);
    if (ctx.note?.id !== PEEK_ITEMS_NOTE) throw new Error(`the vault graph does not list the note written to ${ctx.noteFile}`);
}

export const peekItemViews = {
    name: "peek-item-views",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-peek-items-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await arrangeFixtureRun(h, ctx, "peek-items", PEEK_ITEMS_LEAD);
            const effort = await h.rpc("effortcreate", {
                title: PEEK_ITEMS_EFFORT,
                chunks: [{ label: "Fixture" }, { label: "Peek" }, { label: "Verify" }],
            });
            ctx.effortId = effort.effortoid;
            await h.rpc("effortmutate", {
                effortoid: ctx.effortId,
                author: "you",
                ops: [
                    { op: "setChunkStatus", chunk: "Fixture", status: "done", note: "Fixtures arranged." },
                    { op: "setChunkStatus", chunk: "Peek", status: "active" },
                ],
            });
            await arrangePeekItemsNote(h, ctx);
            // the fixture roster is read once at boot
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("jarvis");
        const hooks = await polishWaitFor(
            h,
            `typeof window.__peekAddress === 'function' && typeof window.__peekLoading === 'function'`,
            5000
        );
        rec(
            "1. the fixtures are arranged and the Brief installed the peek hooks",
            ctx.arrangeError == null && hooks === true,
            JSON.stringify({ arrangeError: ctx.arrangeError ?? null, hooks, note: ctx.note })
        );
        if (ctx.arrangeError != null || hooks !== true) return steps;

        const closePopup = async () => {
            await h.ev(`document.querySelector('[data-pet-peek] button[aria-label="Close Jarvis panel"]')?.click()`);
            await polishWaitFor(h, `!document.querySelector('[data-pet-peek]')`, 3000);
        };
        // ready is the item settled and its body reported; check reads the body's text and DOM as `body`
        const peek = async (address, hint, kind, check, shot) => {
            await closePopup();
            const result = await h.ev(`window.__peekAddress(${JSON.stringify(address)}, ${JSON.stringify(hint ?? null)})`);
            const ready = await polishWaitFor(
                h,
                `(() => {
                    const el = document.querySelector('[data-pet-peek-item="${kind}"][data-pet-peek-status="ready"]');
                    const body = el?.querySelector('[data-pet-peek-body]');
                    if (!body || body.querySelector('[data-pet-peek-gone]')) return false;
                    const text = body.innerText || '';
                    return ${check};
                })()`,
                10000
            );
            // the reveal and the size-layout animation finish before the shot
            await settle(600);
            const view = await h.ev(`(() => {
                const el = document.querySelector('[data-pet-peek-item]');
                const body = el?.querySelector('[data-pet-peek-body]');
                return el ? {
                    kind: el.dataset.petPeekItem,
                    status: el.dataset.petPeekStatus,
                    width: Math.round(el.parentElement.getBoundingClientRect().width),
                    phases: [...el.querySelectorAll('[data-peek-run-phase]')].map((p) => p.dataset.peekRunPhase),
                    text: (body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
                } : null;
            })()`);
            await h.shot(shot);
            floors[shot] = await paintEval(h, `return floorWalk([document.querySelector("[data-pet-peek-item]")]);`);
            return { result, ready, view };
        };
        const floors = {};

        const agent = await peek(
            `agent:${TREE_RAIL_LEAD_ID}`,
            null,
            "agent",
            `text.includes(${JSON.stringify(PEEK_ITEMS_LEAD)})`,
            "cdp-shots/peek-item-agent.png"
        );
        rec("2. an agent peeks as its item view", agent.ready === true, JSON.stringify(agent));

        const effort = await peek(
            `effort:${ctx.effortId}`,
            null,
            "effort",
            `text.includes(${JSON.stringify(PEEK_ITEMS_EFFORT)})`,
            "cdp-shots/peek-item-initiative.png"
        );
        rec("3. an initiative peeks as its item view", effort.ready === true, JSON.stringify(effort));

        const note = await peek(
            `memnote:${ctx.note.id}`,
            { sourceType: "memory" },
            "note",
            `text.includes(${JSON.stringify(ctx.note.label)})`,
            "cdp-shots/peek-item-note.png"
        );
        rec("4. a memory note peeks as its item view", note.ready === true, JSON.stringify(note));

        // an orchestrator run reads Plan, Review, Tasks and Final; a quick run has no strip
        const run = await peek(
            `run:${ctx.runId}`,
            null,
            "run",
            `body.querySelectorAll('[data-peek-run-phase]').length === 4`,
            "cdp-shots/peek-item-run.png"
        );
        rec("5. an orchestrator run peeks with its four-phase strip", run.ready === true, JSON.stringify(run));

        await closePopup();
        await h.ev(`window.__peekLoading({ kind: "effort", effortId: ${JSON.stringify(ctx.effortId)} })`);
        const loading = await polishWaitFor(
            h,
            `(() => {
                const el = document.querySelector('[data-pet-peek-item="effort"][data-pet-peek-status="loading"]');
                const skeleton = el?.querySelector('[data-pet-peek-skeleton]');
                return !!skeleton && /initiative/i.test(skeleton.innerText || '');
            })()`,
            3000
        );
        await settle(600);
        await h.shot("cdp-shots/peek-item-loading.png");
        rec("6. a loading peek shows the skeleton under its kind", loading === true, String(loading));

        await closePopup();
        await h.rpc("effortdelete", { effortoid: ctx.effortId });
        ctx.effortDeleted = true;
        await h.ev(`window.__peekAddress(${JSON.stringify(`effort:${ctx.effortId}`)})`);
        const gone = await polishWaitFor(
            h,
            `(() => {
                const el = document.querySelector('[data-pet-peek-item="effort"][data-pet-peek-status="ready"]');
                return (el?.querySelector('[data-pet-peek-gone]')?.innerText || '').trim() === 'That initiative no longer exists';
            })()`,
            10000
        );
        await settle(600);
        await h.shot("cdp-shots/peek-item-gone.png");
        rec("7. a deleted target's peek says it no longer exists", gone === true, String(gone));
        await closePopup();
        const short = Object.entries(floors).filter(([, s]) => !floorOk(s));
        rec(
            `8. no visible text in any item peek is under ${MIN_FONT_PX}px`,
            Object.keys(floors).length === 4 && short.length === 0,
            JSON.stringify(Object.fromEntries(Object.entries(floors).map(([k, s]) => [k, floorDetail(s)])))
        );
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`peek-item-views teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("close the popup", () =>
            h.ev(`document.querySelector('[data-pet-peek] button[aria-label="Close Jarvis panel"]')?.click()`)
        );
        if (ctx.effortId && !ctx.effortDeleted) {
            await step("delete the initiative", () => h.rpc("effortdelete", { effortoid: ctx.effortId }));
        }
        if (ctx.noteFile) await step("remove the fixture note", () => rmSync(ctx.noteFile, { force: true }));
        await teardownFixtureRun(h, ctx, "peek-item-views");
        await h.goto("cockpit");
    },
};

// --- jarvis avatar: the hologram in window chrome ----------------------------------------------
// The avatar is a <canvas>, so there are no attributes to read the way the old SVG creature allowed. It
// publishes its last built scene on window in DEV builds instead (petview.tsx), which is a STRONGER
// assertion than the SVG version permitted: the whole scene at once rather than one element's transform.
// A screenshot still goes to the contact sheet for eyeballing the glow.
export const jarvisAvatar = {
    name: "jarvis-avatar",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        const raw = await h.ev("JSON.stringify(window.__jarvisAvatarScene ?? null)");
        const scene = raw ? JSON.parse(raw) : null;
        if (scene == null) {
            rec("1. the avatar publishes a scene", false, "window.__jarvisAvatarScene is null — is the loop running?");
            return steps;
        }

        rec(
            "1. the render loop publishes a non-empty scene",
            scene.segments > 0 && scene.fills > 0,
            `segments=${scene.segments} fills=${scene.fills} renderer=${scene.renderer}`
        );
        // a literal here would silently opt the avatar out of every runtime theme
        rec(
            "2. the tone is a theme token, never a resolved colour",
            String(scene.toneVar).startsWith("--color-"),
            `toneVar=${scene.toneVar} markerVar=${scene.markerVar}`
        );
        rec("3. the form has a non-zero extent", scene.extent > 0, `extent=${scene.extent}`);

        // exactly one control owns each accessible name; two would make a by-label query ambiguous, and
        // h.goto navigates the rail by exactly this label
        const named = await h.ev(`[...document.querySelectorAll('[aria-label="Jarvis condition"]')].length`);
        const navNamed = await h.ev(`[...document.querySelectorAll('[aria-label="Jarvis"]')].length`);
        rec(
            "4. the avatar and the nav rail keep distinct accessible names",
            named === 1 && navNamed === 1,
            `"Jarvis condition"=${named} "Jarvis"=${navNamed}`
        );

        // Two canvases by design: one element can only ever yield contexts of a single kind, so the 2D
        // fallback needs its own. Exactly one is displayed at a time.
        const canvases = JSON.parse(
            await h.ev(`(() => {
                const w = document.querySelector('[aria-label="Jarvis condition"]');
                if (!w) return "[]";
                return JSON.stringify([...w.querySelectorAll('canvas')].map((c) => c.className));
            })()`)
        );
        rec(
            "5. both renderers have a canvas and exactly one is shown",
            canvases.length === 2 && canvases.filter((c) => c === "block").length === 1,
            JSON.stringify(canvases)
        );

        await h.shot("cdp-shots/jarvis-avatar.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

// --- jarvis avatar faults: link lost > run held > tired, each face in turn ----------------------
// Link lost is held through the dev-only __waveLink hook, because a real ws drop reconnects at once and
// stopping wavesrv would stop the dev app with it. Attention is injected through __wavePetStore, and the 10s
// poll overwrites it, so each state's shot is taken promptly.
const JARVIS_FAULT_HELD = {
    key: "run-land-held:cdp-held",
    kind: "run-land-held",
    source: "retry budget",
    text: "retry budget can't land.",
    reason: "merge conflict in policy.go",
    action: "Open",
    waitingsince: 0,
    channelid: "",
    runid: "cdp-held",
    phaseidx: 0,
};
const JARVIS_FAULT_ESCALATION = {
    key: "esc:cdp-escalation",
    kind: "escalation",
    source: "first escalation",
    text: "Allow the migration to rewrite the schema?",
    action: "Decide",
    waitingsince: 0,
    channelid: "",
    runid: "cdp-escalation",
    phaseidx: 0,
};

export const jarvisAvatarFaults = {
    name: "jarvis-avatar-faults",
    surface: "cockpit",
    async arrange(h) {
        const ctx = { prevRate: await h.ev(`localStorage.getItem('wave:ratelimits')`) };
        // a saved snapshot past the ok band would make step 1 tired, so the run starts with none
        await h.ev(`localStorage.removeItem('wave:ratelimits')`);
        await reloadApp(h);
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const scene = async () => JSON.parse((await h.ev("JSON.stringify(window.__jarvisAvatarScene ?? null)")) ?? "null");
        // the scene is published by the frame loop, a render after the signal changes
        const until = (expression, posture) =>
            polishWaitFor(
                h,
                `window.__jarvisAvatarScene?.expression === ${JSON.stringify(expression)} && window.__jarvisAvatarScene?.posture === ${JSON.stringify(posture)}`,
                5000
            );
        // past MOOD_TAU_MS a few times over, so the shot is the settled face and not the crossfade
        const settle = () => h.ev("new Promise((r) => setTimeout(r, 1500))");
        const setAttention = (items) =>
            h.ev(`globalThis.__wavePetStore.setAttention(${JSON.stringify(items)}.map((i) => ({ ...i, waitingsince: Date.now() - 60000 })))`);
        const openPeek = async () => {
            await h.ev(`document.querySelector('[aria-label="Jarvis condition"]')?.click()`);
            return polishWaitFor(h, `!!document.querySelector('[data-pet-peek]')`, 3000);
        };
        const closePeek = async () => {
            await h.ev(`document.querySelector('[aria-label="Close Jarvis panel"]')?.click()`);
            await polishWaitFor(h, `!document.querySelector('[data-pet-peek]')`, 3000);
        };
        const leadLine = (kind) =>
            h.ev(`document.querySelector('[data-pet-condition=${JSON.stringify(kind)}]')?.textContent?.trim() ?? null`);
        const state = async (step, expression, posture, shot, extra = async () => ({ ok: true })) => {
            const reached = await until(expression, posture);
            await settle();
            const s = await scene();
            const more = await extra();
            await h.shot(`cdp-shots/jarvis-avatar-fault-${shot}.png`);
            rec(
                step,
                reached && s?.expression === expression && s?.posture === posture && more.ok,
                JSON.stringify({ expression: s?.expression, posture: s?.posture, toneVar: s?.toneVar, ...more })
            );
        };

        try {
            await h.goto("cockpit");
            ctx.prevLink = await h.ev("JSON.stringify(globalThis.__waveLink?.get() ?? null)");
            await h.ev(`globalThis.__waveLink.set({ connected: true, everConnected: true, lostAt: null })`);
            await setAttention([]);
            await state("1. with the link up and nothing waiting the avatar is at rest", "at-rest", "none", "at-rest");

            await h.ev(`localStorage.setItem('wave:ratelimits', ${JSON.stringify(JSON.stringify(usageRateLimits()))})`);
            await reloadApp(h);
            await h.goto("cockpit");
            ctx.prevLink = await h.ev("JSON.stringify(globalThis.__waveLink?.get() ?? null)");
            await setAttention([]);
            await state("2. a window past the ok band makes it tired", "tired", "none", "tired");

            await h.ev(`globalThis.__waveLink.set({ connected: false, everConnected: true, lostAt: Date.now() - 10000 })`);
            await state("3. a link down past the grace outranks tired, and the peek leads with it", "link-lost", "none", "link-lost", async () => {
                const opened = await openPeek();
                const line = await leadLine("link-lost");
                return { ok: opened && String(line).startsWith("I can't reach the backend"), opened, line };
            });
            await closePeek();

            await h.ev(`globalThis.__waveLink.set({ connected: true, everConnected: true, lostAt: null })`);
            await setAttention([JARVIS_FAULT_HELD]);
            await state("4. a held land outranks tired, and the peek names the run and the reason", "run-held", "none", "run-held", async () => {
                const opened = await openPeek();
                const line = await leadLine("run-held");
                return {
                    ok: opened && line === "retry budget can't land — merge conflict in policy.go.",
                    opened,
                    line,
                };
            });
            await closePeek();

            await setAttention([JARVIS_FAULT_HELD, JARVIS_FAULT_ESCALATION]);
            await state("5. a waiting escalation composes with the held land as posture", "run-held", "escalation", "run-held-escalation");
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`jarvis-avatar-faults teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("close the peek", () => h.ev(`document.querySelector('[aria-label="Close Jarvis panel"]')?.click()`));
        if (ctx?.prevLink != null && ctx.prevLink !== "null") {
            await step("restore the link", () => h.ev(`globalThis.__waveLink?.set(${ctx.prevLink})`));
        }
        await step("clear the injected attention", () => h.ev(`globalThis.__wavePetStore?.setAttention([])`));
        // the reload is what returns savedRateLimitsAtom to the restored snapshot
        await step("restore the rate limits", async () => {
            await h.ev(restoreLocalStorage("wave:ratelimits", ctx?.prevRate ?? null));
            await reloadApp(h);
        });
        await step("return to cockpit", () => h.goto("cockpit"));
    },
};

// --- jarvis avatar activity: the working count as tempo and inbound pulses, never presence -------
// The count is held through the dev-only __wavePetStore.setWorking, because starting six real agents to
// photograph a tempo is the trade setAttention already makes. motion's useReducedMotion reads the media
// query once per page load, so the reduced-motion row reloads under the emulation.
const JARVIS_ACTIVITY_ASK = {
    key: "ask:cdp-activity",
    kind: "ask",
    source: "worker 3",
    text: "Which branch should I rebase onto?",
    action: "Answer",
    waitingsince: 0,
    channelid: "",
    runid: "cdp-activity",
    phaseidx: 0,
};

export const jarvisAvatarActivity = {
    name: "jarvis-avatar-activity",
    surface: "cockpit",
    async arrange(h) {
        const ctx = { prevRate: await h.ev(`localStorage.getItem('wave:ratelimits')`) };
        // a saved snapshot past the ok band would make the avatar tired, and tired is never quiet
        await h.ev(`localStorage.removeItem('wave:ratelimits')`);
        await reloadApp(h);
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const nap = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const setWorking = (n) => h.ev(`globalThis.__wavePetStore.setWorking(${JSON.stringify(n)})`);
        const setAttention = (items) =>
            h.ev(`globalThis.__wavePetStore.setAttention(${JSON.stringify(items)}.map((i) => ({ ...i, waitingsince: Date.now() - 60000 })))`);
        const opacity = async () =>
            Number(await h.ev(`getComputedStyle(document.querySelector('[aria-label="Jarvis condition"]')).opacity`));
        // the scene is published by the frame loop, so the count lands a frame after setWorking
        const until = (working, posture) =>
            polishWaitFor(
                h,
                `window.__jarvisAvatarScene?.working === ${working} && window.__jarvisAvatarScene?.posture === ${JSON.stringify(posture)}`,
                5000
            );
        // pulses come and go by design, so a row reads several frames rather than one
        const sample = async () => {
            const seen = [];
            for (let i = 0; i < 10; i++) {
                seen.push(JSON.parse(await h.ev("JSON.stringify(window.__jarvisAvatarScene ?? null)")));
                await nap(150);
            }
            return seen;
        };
        const row = async (step, { name, working, posture, attention, check }) => {
            // the 10s attention poll can overwrite the injection before or during the samples, so a row whose
            // posture drifted is read again from a fresh injection
            let reached = false;
            let seen = [];
            let op = NaN;
            for (let attempt = 0; attempt < 3; attempt++) {
                await setAttention(attention);
                await setWorking(working);
                reached = await until(working, posture);
                // the opacity tween is 0.3s
                await nap(400);
                seen = await sample();
                op = await opacity();
                await h.shot(`cdp-shots/jarvis-avatar-activity-${name}-${working}.png`);
                if (reached && seen.every((s) => s?.posture === posture)) break;
            }
            const last = seen[seen.length - 1];
            const pulses = seen.map((s) => s?.pulses ?? -1);
            const verdict = check({ breathMs: last?.breathMs, pulses, opacity: op });
            rec(
                step,
                reached && seen.every((s) => s?.posture === posture) && verdict,
                JSON.stringify({ working: last?.working, breathMs: last?.breathMs, posture: last?.posture, pulses, opacity: op })
            );
        };
        const none = (p) => p.every((n) => n === 0);
        const some = (p) => p.some((n) => n > 0);

        try {
            await h.goto("cockpit");
            await h.ev(`globalThis.__wavePetStore.resetPeek()`);

            await row("1. at rest with nothing working: the 4.8s breath and no pulses", {
                name: "rest",
                working: 0,
                posture: "none",
                attention: [],
                check: (r) => r.breathMs === 4800 && none(r.pulses),
            });
            await row("2. two working: a quicker breath and pulses, still quiet at 40%", {
                name: "rest",
                working: 2,
                posture: "none",
                attention: [],
                check: (r) =>
                    r.breathMs >= 3300 && r.breathMs <= 3500 && some(r.pulses) && Math.abs(r.opacity - 0.4) < 0.05,
            });
            await row("3. six working: the 1.9s breath", {
                name: "rest",
                working: 6,
                posture: "none",
                attention: [],
                check: (r) => r.breathMs === 1900 && some(r.pulses) && Math.abs(r.opacity - 0.4) < 0.05,
            });

            for (const working of [0, 2, 6]) {
                await row(`4. a worker waiting, ${working} working: blocked-worker at full presence`, {
                    name: "waiting",
                    working,
                    posture: "blocked-worker",
                    attention: [JARVIS_ACTIVITY_ASK],
                    check: (r) => r.opacity > 0.95 && (working === 0 ? none(r.pulses) : some(r.pulses)),
                });
            }

            await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
            ctx.mediaEmulated = true;
            await reloadApp(h);
            await h.goto("cockpit");
            await row("5. reduced motion at six working: no pulses at all", {
                name: "reduced",
                working: 6,
                posture: "none",
                attention: [],
                check: (r) => none(r.pulses),
            });
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`jarvis-avatar-activity teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("release the working count", () => h.ev(`globalThis.__wavePetStore?.setWorking(null)`));
        await step("clear the injected attention", () => h.ev(`globalThis.__wavePetStore?.setAttention([])`));
        if (ctx?.mediaEmulated) {
            await step("clear the media emulation", () => h.cdp("Emulation.setEmulatedMedia", { features: [] }));
        }
        // the reload returns savedRateLimitsAtom to the restored snapshot and motion to the real media query
        await step("restore the rate limits", async () => {
            await h.ev(restoreLocalStorage("wave:ratelimits", ctx?.prevRate ?? null));
            await reloadApp(h);
        });
        await step("return to cockpit", () => h.goto("cockpit"));
    },
};

const JARVIS_PEEK_PROJECT = "verify-jarvis-peek";

// a registered project is the composer's destination (petpeek.tsx: projectListAtom's rows with a channel), and
// createproject makes its channel. The channel snapshot is boot-primed, so the frontend reloads to see it, and
// the reload closes the hub, so it is reopened from the creature the way step 1 opened it. The existing fixture
// helpers (arrangeFixtureRun, brief-peek's createchannel) make a channel with no registered project, which is
// not a destination.
async function arrangeJarvisPeekDest(h, ctx) {
    try {
        ctx.destDir = mkdtempSync(join(tmpdir(), "verify-jarvis-peek-"));
        await h.rpc("createproject", { name: JARVIS_PEEK_PROJECT, path: ctx.destDir });
        ctx.destProject = JARVIS_PEEK_PROJECT;
        await waitForProjectInConfig(h, JARVIS_PEEK_PROJECT);
        // not polishReload: it lands on the Jarvis surface, whose mount selects a channel
        try {
            await h.ev("location.reload()");
        } catch {
            /* the evaluate is cut off by the navigation it just started */
        }
        await polishWaitFor(h, "!!window.TabRpcClient && !!document.querySelector('nav button')", 30000);
        await h.goto("cockpit");
        await h.ev(`(() => {
            const store = globalThis.__wavePetStore;
            store?.resetPeek();
            store?.setAttention([]);
            document.querySelector('[aria-label="Jarvis condition"]')?.focus();
        })()`);
        for (const type of ["keyDown", "keyUp"]) {
            await h.cdp("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        }
        const composerEnabled = await polishWaitFor(
            h,
            `(() => { const i = document.querySelector('[data-pet-peek] [data-pet-errand-input]'); return i != null && !i.disabled; })()`,
            10000
        );
        const destLabel = await h.ev(
            `document.querySelector('[data-pet-peek] [data-pet-errand-dest]')?.selectedOptions?.[0]?.textContent?.trim() ?? null`
        );
        return { composerEnabled, destLabel };
    } catch (e) {
        return { composerEnabled: false, error: String(e?.message ?? e) };
    }
}

// deleteproject leaves the channel createproject made, so the channel at the project's path goes too
async function teardownJarvisPeekDest(h, ctx) {
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`jarvis-peek teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    if (ctx?.destProject) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.destProject }));
    if (ctx?.destDir) {
        await step("delete the project's channel", async () => {
            const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
            const channels = (await h.rpc("getchannels", null))?.channels ?? [];
            for (const c of channels.filter((c) => norm(c.projectpath) === norm(ctx.destDir))) {
                await h.rpc("deletechannel", { channelid: c.oid });
            }
        });
        await step("remove the temp dir", () => rmSync(ctx.destDir, { recursive: true, force: true }));
    }
}

export const jarvisPeek = {
    name: "jarvis-peek",
    surface: "cockpit",
    async arrange(h) {
        // petSaidAtom is session-scoped. Reloading gives this scenario a deterministic empty feed while
        // the persisted watermark still prevents old backend facts from speaking again.
        // a fixed sleep raced a slow boot in Final: the reset then ran before the store existed
        await h.reload();
        await polishWaitFor(h, "typeof globalThis.__wavePetStore?.resetPeek === 'function'", 10000);
        const reset = await h.ev(`(() => {
            const store = globalThis.__wavePetStore;
            if (typeof store?.resetPeek !== 'function') return false;
            store.resetPeek();
            store.setAttention([]);
            return true;
        })()`);
        return { reset };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
            for (const type of ["keyDown", "keyUp"]) {
                await h.cdp("Input.dispatchKeyEvent", {
                    type,
                    key,
                    code,
                    windowsVirtualKeyCode,
                    modifiers,
                });
            }
            await settle(350);
        };

        const creatureFocused = await h.ev(`(() => {
            const creature = document.querySelector('[aria-label="Jarvis condition"]');
            if (!creature) return false;
            creature.focus();
            return document.activeElement === creature;
        })()`);
        await press("Enter", "Enter", 13);

        const structure = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            if (!panel) return null;
            const labelledBy = panel.getAttribute('aria-labelledby');
            const label = labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : null;
            const input = panel.querySelector('[data-pet-errand-input]');
            const dest = panel.querySelector('[data-pet-errand-dest]');
            const rect = panel.getBoundingClientRect();
            return {
                role: panel.getAttribute('role'),
                label,
                shape: panel.getAttribute('data-pet-peek-shape'),
                close: panel.querySelector('button[aria-label="Close Jarvis panel"]') != null,
                panelFocused: document.activeElement === panel,
                // the panel is header / queue / composer, in that DOM order. Conditions and the updates
                // drawer are conditional and absent in the reset state, which is the point of the redesign.
                header: panel.querySelector('[data-pet-peek-header]') != null,
                queue: panel.querySelector('[data-pet-queue]') != null,
                composer: panel.querySelector('[data-pet-composer]') != null,
                conditions: panel.querySelector('[data-pet-conditions]') != null,
                updatesDrawer: panel.querySelector('[data-pet-updates]') != null,
                rows: panel.querySelectorAll('[data-pet-row]').length,
                // absence must not be rendered: no tile reading "Nothing", no empty-updates card, no
                // health badge restating what the lines below already say (2026-09-04 brief §3, §6).
                text: (panel.innerText || '').trim(),
                height: Math.round(rect.height),
                destPresent: dest != null,
                destLabel: dest?.selectedOptions?.[0]?.textContent?.trim() ?? null,
                inputDisabled: input?.disabled ?? null,
                inputPlaceholder: input?.getAttribute('placeholder') ?? null,
            };
        })()`);
        rec(
            "1. keyboard open renders a labelled dialog of header/queue/composer and focuses its container",
            creatureFocused === true &&
                structure?.role === "dialog" &&
                structure?.label === "Nothing waiting on you" &&
                structure?.shape === "quiet" &&
                structure?.header === true &&
                structure?.queue === true &&
                structure?.composer === true &&
                structure?.close === true &&
                structure?.panelFocused === true,
            JSON.stringify({ creatureFocused, structure })
        );

        await press("Tab", "Tab", 9);
        const firstTab = await h.ev(`(() => ({
            label: document.activeElement?.getAttribute('aria-label') ?? null,
            inside: document.querySelector('[data-pet-peek]')?.contains(document.activeElement) ?? false,
        }))()`);
        await press("Tab", "Tab", 9, 8);
        const wrappedInside = await h.ev(
            `document.querySelector('[data-pet-peek]')?.contains(document.activeElement) ?? false`
        );
        rec(
            "2. Tab starts at Full view and reverse traversal stays inside the dialog",
            firstTab.inside === true && firstTab.label === "Open full Jarvis view" && wrappedInside === true,
            JSON.stringify({ firstTab, wrappedInside })
        );
        // Each string below is one the old three-card panel rendered to report missing telemetry or repeat
        // a disabled composer state. The adaptive card states queue absence once in its title; these older
        // tile-level absence messages must not come back.
        const ABSENCE =
            /No updates yet|No reading|Usage unavailable|No action needed|No destination|No channel selected|Select a channel to ask Jarvis/;
        rec(
            "3. the quiet card states queue absence once, and the composer is live wherever there is a destination",
            ctx.reset === true &&
                structure?.updatesDrawer === false &&
                ABSENCE.test(structure?.text ?? "") === false &&
                structure?.text.includes("Nothing waiting on you") === true &&
                // the fix: dead only when there is genuinely nowhere to send. The composer used to read the
                // Jarvis surface's selection, which nothing sets at boot, so it was dead on every surface.
                structure?.inputDisabled === !structure?.destPresent &&
                // resting height, against the 693px the three-card panel cost. Only asserted with an empty
                // queue: rows are real content and are allowed to make the panel taller.
                (structure?.rows > 0 || (structure?.height > 0 && structure?.height < 320)),
            JSON.stringify(structure)
        );
        await h.shot("cdp-shots/jarvis-peek-empty.png");

        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 440,
            height: 420,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await settle(450);
        const narrow = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            const header = document.querySelector('[data-pet-peek-header]');
            const body = document.querySelector('[data-pet-peek-body]');
            if (!panel || !header || !body) return null;
            const rect = panel.getBoundingClientRect();
            const headerTop = Math.round(header.getBoundingClientRect().top);
            body.scrollTop = body.scrollHeight;
            const headerAfterScroll = Math.round(header.getBoundingClientRect().top);
            return {
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                width: Math.round(rect.width),
                shape: panel.getAttribute('data-pet-peek-shape'),
                horizontalOverflow: panel.scrollWidth - panel.clientWidth,
                bodyScrollable: body.scrollHeight > body.clientHeight,
                headerStayed: headerTop === headerAfterScroll,
            };
        })()`);
        await h.shot("cdp-shots/jarvis-peek-narrow.png");

        const pickerOpened = await h.ev(`(() => {
            const picker = document.querySelector('[data-pet-peek] [data-testid="harness-picker"]');
            if (!picker) return false;
            picker.click();
            return true;
        })()`);
        await settle(350);
        const pickerVisibility = await h.ev(`(() => {
            const options = [...document.querySelectorAll('[data-testid^="harness-option-"]')];
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            const visible = options.length > 0 && options.every((option) => {
                const rect = option.getBoundingClientRect();
                const x = Math.round(rect.left + rect.width / 2);
                const y = Math.round(rect.top + rect.height / 2);
                const hit = document.elementFromPoint(x, y);
                return rect.left >= 0 && rect.right <= viewport.width && rect.top >= 0 && rect.bottom <= viewport.height &&
                    (hit === option || option.contains(hit));
            });
            return {
                count: options.length,
                visible,
                rects: options.map((option) => {
                    const rect = option.getBoundingClientRect();
                    return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
                }),
            };
        })()`);
        await h.ev(`document.querySelector('[data-pet-peek] [data-testid="harness-picker"]')?.click()`);
        await settle(350);
        rec(
            // bodyScrollable is deliberately no longer required: the resting panel now FITS 440x420, which
            // is the redesign's first success criterion. headerStayed still proves the pin structurally —
            // the header sits outside the scroll container whether or not the queue currently overflows.
            "4. the narrow panel stays bounded with a pinned header, no horizontal overflow, and an unclipped harness picker",
            narrow != null &&
                narrow.left >= 8 &&
                narrow.right <= narrow.viewportWidth - 8 &&
                narrow.top >= 8 &&
                narrow.bottom <= narrow.viewportHeight - 8 &&
                narrow.width <= 420 &&
                narrow.shape === "quiet" &&
                narrow.horizontalOverflow <= 0 &&
                narrow.headerStayed === true &&
                pickerOpened === true &&
                pickerVisibility?.visible === true,
            JSON.stringify({ narrow, pickerOpened, pickerVisibility })
        );

        // the portaled harness menu is inside the dialog's aria scope, and a pick closes it with focus back inside
        // the dialog, so the popup's keys still reach it and one Escape closes it. Real mouse events, because element.click() moves no focus.
        const centerOf = (selector) =>
            h.ev(`(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`);
        const clickAt = async (pt) => {
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
            for (const type of ["mousePressed", "mouseReleased"]) {
                await h.cdp("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
            }
        };
        const PICKER = '[data-pet-peek] [data-testid="harness-picker"]';
        ctx.prevHarness = await h.ev(`document.querySelector(${JSON.stringify(PICKER)})?.dataset.harnessRuntime ?? null`);
        const chip = await centerOf(PICKER);
        if (chip != null) await clickAt(chip);
        await settle(400);
        // the current selection when it can be picked, so the pick leaves the preference as it was
        const option = await h.ev(`(() => {
            const options = [...document.querySelectorAll('[data-testid^="harness-option-"]')].filter((o) => !o.disabled);
            const o = options.find((x) => x.getAttribute('aria-pressed') === 'true') ?? options[0];
            if (!o) return null;
            const r = o.getBoundingClientRect();
            return {
                runtime: o.dataset.testid.replace('harness-option-', ''),
                // the modal dialog hides everything outside its scope from assistive tech
                ariaHidden: o.closest('[aria-hidden="true"]') != null,
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
            };
        })()`);
        if (option != null) {
            ctx.harnessPicked = option.runtime;
            await clickAt(option);
        }
        await settle(450);
        const afterPick = await h.ev(`(() => {
            const active = document.activeElement;
            return {
                focusInDialog: document.querySelector('[data-pet-peek]')?.contains(active) ?? false,
                focused: active?.getAttribute('data-testid') ?? active?.tagName ?? null,
                menuExpanded: document.querySelector(${JSON.stringify(PICKER)})?.getAttribute('aria-expanded') ?? null,
            };
        })()`);
        await press("Escape", "Escape", 27);
        const closedByOneEscape = await h.ev(`document.querySelector('[data-pet-peek]') == null`);
        rec(
            "5. the harness menu is in the dialog's aria scope, a pick returns focus inside the dialog, and one Escape then closes the popup",
            chip != null &&
                option?.ariaHidden === false &&
                afterPick.focusInDialog === true &&
                closedByOneEscape === true,
            JSON.stringify({ chip, option, afterPick, closedByOneEscape })
        );

        // the Final's fresh profile has no project, so the composer is disabled and `/` cannot focus it. Step 3
        // covered that branch above; register one now so step 6 exercises a live composer.
        const dest = await arrangeJarvisPeekDest(h, ctx);
        const busyArranged = await h.ev(`(() => {
            const store = globalThis.__wavePetStore;
            const panel = document.querySelector('[data-pet-peek]');
            if (typeof store?.setAttention !== 'function' || !panel) return false;
            store.setAttention([
                { key: 'dag-blocked:cdp-1', kind: 'dag-blocked', source: 'first blocked', text: 'The group is blocked.', action: 'Review', waitingsince: Date.now() - 120000, channelid: '', runid: 'cdp-1', phaseidx: 0 },
                { key: 'ask:cdp-2', kind: 'ask', source: 'second ask', text: 'Waiting on your reply', action: 'Answer', waitingsince: Date.now() - 60000, channelid: '', runid: 'cdp-2', phaseidx: 0 },
            ]);
            return true;
        })()`);
        await settle(450);
        const busyBefore = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            panel?.focus();
            const rect = panel?.getBoundingClientRect();
            return {
                shape: panel?.getAttribute('data-pet-peek-shape') ?? null,
                width: rect == null ? null : Math.round(rect.width),
                cursor: panel?.querySelector('[data-pet-cursor="true"]')?.closest('[data-pet-row]')?.getAttribute('data-pet-row') ?? null,
                focused: document.activeElement === panel,
            };
        })()`);
        await h.shot("cdp-shots/jarvis-peek-busy.png");
        const busyFloor = await paintEval(h, `return floorWalk([document.querySelector("[data-pet-peek]")]);`);
        await press("ArrowDown", "ArrowDown", 40);
        const movedCursor = await h.ev(`document.querySelector('[data-pet-cursor="true"]')?.closest('[data-pet-row]')?.getAttribute('data-pet-row') ?? null`);
        await press("/", "Slash", 191);
        const composerFocused = await h.ev(`document.activeElement?.hasAttribute('data-pet-errand-input') ?? false`);
        rec(
            "6. attention keeps the card's width and keyboard navigation moves the cursor then focuses the composer",
            dest.composerEnabled === true &&
                busyArranged === true &&
                busyBefore?.shape === "busy" &&
                busyBefore?.width === narrow?.width &&
                busyBefore?.cursor === "dag-blocked:cdp-1" &&
                busyBefore?.focused === true &&
                movedCursor === "ask:cdp-2" &&
                composerFocused === true,
            JSON.stringify({ dest, busyArranged, busyBefore, movedCursor, composerFocused })
        );

        await press("Escape", "Escape", 27);
        const escapeDismissed = await h.ev(`(() => ({
            panelGone: document.querySelector('[data-pet-peek]') == null,
            focusReturned: document.activeElement?.getAttribute('aria-label') === 'Jarvis condition',
        }))()`);

        await press("Enter", "Enter", 13);
        const closeClicked = await h.ev(`(() => {
            const close = document.querySelector('button[aria-label="Close Jarvis panel"]');
            if (!close) return false;
            close.click();
            return true;
        })()`);
        await settle(350);
        const closeDismissed = await h.ev(`(() => ({
            panelGone: document.querySelector('[data-pet-peek]') == null,
            focusReturned: document.activeElement?.getAttribute('aria-label') === 'Jarvis condition',
        }))()`);

        await press("Enter", "Enter", 13);
        const backdropClicked = await h.ev(`(() => {
            const backdrop = document.querySelector('[data-pet-peek-backdrop]');
            if (!backdrop) return false;
            backdrop.click();
            return true;
        })()`);
        await settle(350);
        const backdropDismissed = await h.ev(`(() => ({
            panelGone: document.querySelector('[data-pet-peek]') == null,
            focusReturned: document.activeElement?.getAttribute('aria-label') === 'Jarvis condition',
        }))()`);
        rec(
            "7. Escape, close, and backdrop dismiss only the peek and return focus to the creature",
            escapeDismissed.panelGone === true &&
                escapeDismissed.focusReturned === true &&
                closeClicked === true &&
                closeDismissed.panelGone === true &&
                closeDismissed.focusReturned === true &&
                backdropClicked === true &&
                backdropDismissed.panelGone === true &&
                backdropDismissed.focusReturned === true,
            JSON.stringify({ escapeDismissed, closeClicked, closeDismissed, backdropClicked, backdropDismissed })
        );
        const stayed = (await h.activeSurfaceLabel()) === SURFACE_LABEL.cockpit;
        rec("8. dismissing the global peek stays on the current surface", stayed, String(stayed));
        rec(`9. no visible text in the busy peek is under ${MIN_FONT_PX}px`, floorOk(busyFloor), floorDetail(busyFloor));
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 1600,
            height: 950,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await h.ev(`(() => {
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            globalThis.__wavePetStore?.setAttention([]);
            return true;
        })()`);
        if (ctx.harnessPicked != null && ctx.prevHarness != null && ctx.harnessPicked !== ctx.prevHarness) {
            try {
                await h.rpc("setconfig", { "harness:preferredruntime": ctx.prevHarness });
            } catch (e) {
                console.error(`jarvis-peek teardown: restore the harness preference failed: ${e?.message ?? e}`);
            }
        }
        await teardownJarvisPeekDest(h, ctx);
        await h.goto("cockpit");
    },
};

// --- jarvis volunteer: the volunteered-knowledge delivery chain ---------------------------------
// The unit tests cover each hop in isolation; what they structurally cannot see is a bad hop BETWEEN
// atoms, which is the defect class this surface's findings keep landing in. So this drives the whole
// chain in the real app: push a knowledge utterance -> the creature speaks it -> the peek lists it with
// Open and no Ask (the recall act was retired) -> Open lands on the Jarvis surface.
//
// It injects the pet event rather than arranging a real utterance. A real one needs a headless CLI judge
// run (up to 90s) behind a 45-minute quiet window, which is the same live-model limit that keeps the
// cancel path and the thread-archive path unit-only (git show a4b5bd4f:docs/jarvis-tab.md). The hook is dev-only, exposed
// by petstore.ts under import.meta.env.DEV.
//
// Open lands only on a record the router can load, and a fresh store has none, so the arrange creates a run held by
// deferstart: CreateRun captures a record named by the goal's slug, which the utterance cites.
const JARVIS_VOLUNTEER_GOAL = "verify jarvis-volunteer: open a record, do nothing";
const JARVIS_VOLUNTEER_RECORD = "verify-jarvis-volunteer-open-a-record-do-nothing";

export const jarvisVolunteer = {
    name: "jarvis-volunteer",
    surface: "cockpit", // the creature lives in window chrome, so any surface will do; start neutral
    async arrange(h) {
        const ctx = { id: `loose-end:cdp-probe:${Date.now()}`, cwd: mkdtempSync(join(tmpdir(), "verify-jarvis-volunteer-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-jarvis-volunteer", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: JARVIS_VOLUNTEER_GOAL,
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];

        // The creature's click TOGGLES the peek, so a run that starts with it already open would close it
        // instead and read as "no Open control". Normalise first: without this the scenario passes or
        // fails depending on what the previous run left behind, which is the one thing a regression net
        // must never do.
        await h.ev(`(() => {
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");

        const pushed = await h.ev(`(() => {
            const mod = globalThis.__wavePetStore;
            if (mod == null) return "petstore test hook not exposed (dev build?)";
            mod.pushPetEvent({
                id: ${JSON.stringify(ctx.id)},
                at: Date.now(),
                kind: "loose-end",
                text: "CDP probe - untouched for 21 days",
                sources: [{ ref: ${JSON.stringify(`task:${JARVIS_VOLUNTEER_RECORD}`)}, title: "CDP probe", sourceType: "dossier" }],
            });
            return true;
        })()`);
        // the speak effect runs on the events atom, then the bubble mounts
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        steps.push({ step: "knowledge utterance pushed to the creature", ok: pushed === true && ctx.arrangeError == null, detail: ctx.arrangeError ?? String(pushed) });
        await h.shot("cdp-shots/jarvis-volunteer-bubble.png");
        const bubbleFloor = await paintEval(h, `return floorWalk([document.querySelector("[data-pet-bubble]")]);`);

        // the bubble carries the register's label, which is the compiler-enforced half of the vocabulary.
        // Lowercased before matching: the label is styled `uppercase`, and innerText returns the RENDERED
        // text, so a literal "Still open" never matches.
        const spoke = await h.ev(`(() => {
            const t = (document.body.innerText || "").toLowerCase();
            return t.includes("still open") && t.includes("cdp probe");
        })()`);
        steps.push({
            step: 'bubble speaks it under the "Still open" register',
            ok: spoke === true,
            detail: String(spoke),
        });

        // open the peek: the two verbs live there, not on the bubble, which auto-dismisses after 6s.
        // The creature is a motion.div with role="button", not a <button>, so query the label directly.
        const opened = await h.ev(`(() => {
            const c = document.querySelector('[aria-label="Jarvis condition"]');
            if (!c) return "no creature control";
            c.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        // assert the peek is actually OPEN, not merely that the click did not throw. Without this the step
        // passes on a click that toggled it shut, and the close assertion then passes vacuously too.
        const peekOpen = await h.ev(`document.querySelector('[data-pet-peek]') != null`);
        steps.push({
            step: "peek opens from the creature",
            ok: opened === true && peekOpen === true,
            detail: `clicked=${opened} open=${peekOpen}`,
        });
        await h.shot("cdp-shots/jarvis-volunteer-peek.png");
        const peekFloor = await paintEval(h, `return floorWalk([document.querySelector("[data-pet-peek]")]);`);

        // with no attention queue, the adaptive card shows the latest update directly. It keeps its Open act:
        // compacting the card must not turn the volunteered fact into a dead readout.
        const verbs = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            return {
                open: panel?.querySelector('[data-pet-act$=":open"]') != null,
                ask: panel?.querySelector('[data-pet-act$=":ask"]') != null,
            };
        })()`);
        steps.push({
            step: "latest update offers Open, and no retired Ask",
            ok: verbs?.open === true && verbs?.ask === false,
            detail: JSON.stringify(verbs),
        });

        const clicked = await h.ev(`(() => {
            const button = document.querySelector('[data-pet-peek] [data-pet-act$=":open"]');
            if (!button) return "no Open control";
            button.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const landed = await h.activeSurfaceLabel();
        steps.push({
            step: "Open navigates to the Jarvis surface",
            ok: clicked === true && landed === SURFACE_LABEL.jarvis,
            detail: `clicked=${clicked} surface=${landed}`,
        });
        await h.shot("cdp-shots/jarvis-volunteer-opened.png");

        // and it closes the peek on the way out: an overlay anchored to the creature, left open over a
        // surface it just navigated away from, is stranded
        const peekClosed = await h.ev(`document.querySelector('[data-pet-peek]') == null`);
        steps.push({ step: "peek closed on navigation", ok: peekClosed === true, detail: String(peekClosed) });
        steps.push({ step: `no visible text in the bubble is under ${MIN_FONT_PX}px`, ok: floorOk(bubbleFloor), detail: floorDetail(bubbleFloor) });
        steps.push({ step: `no visible text in the peek is under ${MIN_FONT_PX}px`, ok: floorOk(peekFloor), detail: floorDetail(peekFloor) });

        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(`(() => {
            // close the peek if a failed run left it open, and drop the watermark the injected utterance
            // advanced -- that key is persisted, so leaving it moved is a side effect on the user's own
            // creature rather than a test
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            try {
                globalThis.localStorage?.removeItem("wave:pet.watermark");
            } catch {}
            return true;
        })()`);
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`jarvis-volunteer teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        if (ctx?.runId) await step("cancel the run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId }));
        if (ctx?.channelId) await step("delete the channel", () => h.rpc("deletechannel", { channelid: ctx.channelId }));
        if (ctx?.cwd) await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await h.goto("cockpit");
    },
};

// --- brief-contextual-map: the Brief's honest graph exits ---------------------------------------------
// The graph peek mounts with the Brief's own exits: a record closes into the peek, and a run offers no
// control at all because B5 has not given runs a Stage sheet yet. It used to open by priming an attached
// thread from a memory note's "Ask Jarvis"; that entry point went with the Vault surface, and the exits
// below never depended on it. The surviving contextual entry is a run.
export const briefContextualMap = {
    name: "brief-contextual-map",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

        // arrange: a reloaded surface, so the restore below is the only thing that has run
        await h.ev("location.reload()");
        await settle(2600);

        await h.goto("jarvis");
        await settle(500);

        // 1. Shift+G mounts the graph peek in Brief mode. The Stage-only keys must stay absent: the Brief
        //    has no rail to toggle and no Stage thread to start.
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', shiftKey: true, bubbles: true }))`
        );
        await settle(900);
        const peek = await h.ev(`(() => {
            const el = document.querySelector('[data-jarvis-graph-peek]');
            if (!el) return null;
            const text = el.innerText || '';
            return {
                text: text.slice(0, 200),
                actions: [...el.querySelectorAll('button')].map((b) => (b.innerText || '').trim()),
            };
        })()`);
        rec(
            "1. Shift+G opens the graph peek over the Brief",
            peek != null && /\bgraph\b/i.test(peek.text) && /\d+ nodes/.test(peek.text),
            JSON.stringify(peek)
        );

        // 2. With nothing selected the overlay offers no node actions at all — the two exits are asserted
        //    where they can exist, on a focused task node (4b). Asserting them here would be asserting them
        //    against a state the graph deliberately does not have.
        const runControl = await h.ev(`(() => {
            const el = document.querySelector('[data-jarvis-graph-peek]');
            if (!el) return null;
            const runs = [...el.querySelectorAll('button')].filter((b) => /open run/i.test(b.innerText || '')).length;
            const ask = [...el.querySelectorAll('button')].filter((b) => /ask jarvis about this node/i.test(b.innerText || '')).length;
            return { runs, ask };
        })()`);
        rec(
            "2. the graph peek opens over the Brief with no node selected, so no node action is offered",
            runControl != null && runControl.runs === 0 && runControl.ask === 0,
            JSON.stringify(runControl)
        );

        // 3. a task node closes into the record peek rather than onto a Stage that is not there. Reached
        //    through the record peek's own map button, which is the one route that names a record to focus.
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await settle(500);
        const closed = await h.ev(`document.querySelector('[data-jarvis-graph-peek]') == null`);
        rec("3a. Escape closes the graph peek and leaves the Brief", closed === true, "");

        const listed = await h.rpc("listtaskdossiers", null);
        if ((listed?.dossiers ?? []).length === 0) {
            rec("3b. a task node closes into the record peek", false, "no dossier in this profile - seed one before reading this as a pass");
            return steps;
        }
        // the palette is the only in-app route from the Brief to a record (see brief-peek for the full
        // explanation): nothing on the Brief itself names one.
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
        );
        await settle(300);
        await h.ev(`document.querySelector('[data-palette-scope="records"]')?.click()`);
        await settle(900);
        await h.ev(`(() => {
            const headers = [...document.querySelectorAll('div')].filter(
                (d) => (d.textContent || '').trim().toLowerCase() === 'records'
            );
            const group = headers[0] ? headers[0].parentElement : null;
            const row = group ? group.querySelector('button[data-idx]') : null;
            if (row) row.click();
            return true;
        })()`);
        await settle(900);
        const mapClicked = await h.ev(`(() => {
            const b = document.querySelector('[data-jarvis-peek-open-graph]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(1200);
        const focused = await h.ev(`(() => {
            const el = document.querySelector('[data-jarvis-graph-peek]');
            if (!el) return null;
            const open = [...el.querySelectorAll('button')].filter((b) => /^open record$/i.test((b.innerText || '').trim()));
            const runs = [...el.querySelectorAll('button')].filter((b) => /open run/i.test(b.innerText || '')).length;
            return { open: open.length, runs };
        })()`);
        rec(
            "3b. the record peek's map button focuses its task node: one Open record, no run control",
            mapClicked === true && focused != null && focused.open === 1 && focused.runs === 0,
            JSON.stringify({ mapClicked, focused })
        );

        const backToPeek = await h.ev(`(() => {
            const el = document.querySelector('[data-jarvis-graph-peek]');
            if (!el) return false;
            const b = [...el.querySelectorAll('button')].find((x) => /^open record$/i.test((x.innerText || '').trim()));
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(900);
        const landed = await h.ev(`(() => ({
            peek: !!document.querySelector('[data-jarvis-brief-band="peek"]'),
            graph: !!document.querySelector('[data-jarvis-graph-peek]'),
        }))()`);
        rec(
            "3c. Open record closes the graph into the Brief's record peek",
            backToPeek === true && landed.peek === true && landed.graph === false,
            JSON.stringify({ backToPeek, landed })
        );
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- brief-composer-steer-only: no composer without a live lead to message --------------------------
// The Brief's composer only steers a running session's lead (briefcomposertarget.ts); the Ask audiences it
// used to have were retired. So with no session sheet open there is no composer at all. The "composer
// present" half needs a live worker, so it is checked by hand at the final verification.
export const briefComposerSteerOnly = {
    name: "brief-composer-steer-only",
    surface: "jarvis",
    async arrange(h) {
        // start with no sheet open: Escape closes whatever a previous scenario left behind
        await h.goto("jarvis");
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        return {};
    },
    async assert(h) {
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
        return steps;
    },
    async teardown() {},
};

// --- brief-restore: the stored subject, landed three different ways -------------------------------
// What the same stored value means now (briefrestore.ts): a dossier opens the record peek, while a channel
// and a conversation left over from before Ask was retired are cleared. Each case needs its
// own reload, because the restore is once per frontend load by design.
export const briefRestore = {
    name: "brief-restore",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.ev(`localStorage.setItem('jarvis.subject.last', null)`);

        // a fresh load is what makes the restore one-shot, so each case reloads
        const withStored = async (stored) => {
            await h.ev(`localStorage.setItem('jarvis.subject.last', ${JSON.stringify(JSON.stringify(stored))})`);
            await h.ev("location.reload()");
            await settle(2800);
            await h.goto("jarvis");
            await settle(900);
        };

        // 1. a dossier opens the record peek, exactly once
        const listed = await h.rpc("listtaskdossiers", null);
        const dossier = (listed?.dossiers ?? [])[0];
        if (dossier == null) {
            rec(
                "1. a stored dossier restores to the record peek",
                false,
                "Vault Records requires at least one dossier"
            );
        } else {
            await withStored({ kind: "dossier", id: dossier.id });
            const opened = await h.ev(`(() => {
                const band = document.querySelector('[data-jarvis-brief-band="peek"]');
                return band ? { text: (band.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200) } : null;
            })()`);
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
            );
            await settle(500);
            // re-enter the surface: the restore must not run a second time, or closing a peek would be
            // undone by the next nav switch
            await h.goto("cockpit");
            await settle(400);
            await h.goto("jarvis");
            await settle(900);
            const reopened = await h.ev(`!!document.querySelector('[data-jarvis-brief-band="peek"]')`);
            rec(
                "1. a stored dossier restores to the record peek once and does not reopen",
                opened != null && opened.text.includes(dossier.objective.slice(0, 24)) && reopened === false,
                JSON.stringify({ objective: dossier.objective.slice(0, 40), opened, reopened })
            );
        }

        // 2. a conversation stored before Ask was retired clears rather than waiting on a list that no longer
        //    loads: no subject selected, nothing opened, no error overlay
        await withStored({ kind: "conversation", id: "gone" });
        const cleared = await h.ev(`(() => ({
            stored: localStorage.getItem('jarvis.subject.last'),
            brief: !!document.querySelector('[data-jarvis-region="brief"]'),
            peek: !!document.querySelector('[data-jarvis-brief-band="peek"]'),
            sheet: !!document.querySelector('[data-jarvis-brief-sheet]'),
            overlay: !!document.querySelector('vite-error-overlay'),
        }))()`);
        rec(
            "2. a stored conversation from before Ask was retired is cleared",
            cleared.brief === true &&
                cleared.peek === false &&
                cleared.sheet === false &&
                cleared.overlay === false &&
                (cleared.stored == null || cleared.stored === "null"),
            JSON.stringify(cleared)
        );

        // 3. a stored channel is forgotten: reopening its sheet on launch covered the Brief with a run that
        //    had usually ended days ago. A live channel is the case that proves it, not a deleted one.
        const chans = await h.rpc("getchannels", null);
        const channel = (chans?.channels ?? [])[0];
        if (channel == null) {
            rec(
                "3. a stored channel is cleared, its sheet left closed",
                false,
                "no channel in this profile — seed one before reading this as a pass"
            );
        } else {
            await withStored({ kind: "channel", id: channel.oid });
            const after = await h.ev(`(() => ({
                stored: localStorage.getItem('jarvis.subject.last'),
                brief: !!document.querySelector('[data-jarvis-region="brief"]'),
                peek: !!document.querySelector('[data-jarvis-brief-band="peek"]'),
                sheet: !!document.querySelector('[data-jarvis-brief-sheet]'),
            }))()`);
            rec(
                "3. a stored channel is cleared, its sheet left closed",
                after.brief === true &&
                    after.sheet === false &&
                    after.peek === false &&
                    (after.stored == null || after.stored === "null"),
                JSON.stringify({ channel: channel.oid, ...after })
            );
        }
        return steps;
    },
    async teardown(h) {
        await h.ev(`localStorage.removeItem('jarvis.subject.last')`);
        await h.goto("cockpit");
    },
};

// --- brief-profile: both scopes of the profile modal -------------------------------------------
// Read-only on purpose: it never presses Save, so nothing is written into whatever config dir the dev app is
// pointed at. A store with no projects opens the modal on Global only, so the scenario registers one of its own.
const BRIEF_PROFILE_PROJECT = "verify-brief-profile";

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
        return steps;
    },
    async teardown(h, ctx) {
        const undo = [
            ["close the profile", () => closeProfile(h)],
            ["delete the channel", () => ctx.channelId && h.rpc("deletechannel", { channelid: ctx.channelId })],
            ["delete the project", () => ctx.project && h.rpc("deleteproject", { name: ctx.project })],
            ["remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true })],
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

// --- jarvis-motion: the structural facts the motion pass rests on -------------------------------
// The animations themselves are not assertable here — a tween is a sequence of transient computed
// styles, and reading one mid-flight is a race rather than a check. What IS assertable is the
// structure each moment depends on, which is also the half a later refactor can quietly break with
// nothing failing: the detail sheet's surface scoping, the freshness mark's presence and its cap, and
// the updates drawer's split between the element whose height animates and the inner scroller.
// --- the Brief's inline initiative tracker ------------------------------------------------------
// An initiative expands IN PLACE instead of opening the detail sheet, and its chunks join the Brief's
// own j/k list so one cursor walks rows and chunks alike. The chunk rows need the effort DETAIL, which
// the briefing fixture does not carry (it seeds summaries only) — so the plan-dependent steps SKIP when
// the dev store has no real initiative with chunks, rather than failing on an empty dev database.
export const briefInlineTracker = {
    name: "brief-inline-tracker",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        await h.ev(`document.querySelector('[data-briefing-fixture="normal"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))");

        // 1. an initiative row no longer opens the modal sheet
        const row = `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')][0]`;
        const before = await h.ev(`(() => ({
            rows: document.querySelectorAll('[data-jarvis-brief-row="initiative"]').length,
            expanded: !!document.querySelector('[data-jarvis-initiative-detail]'),
        }))()`);
        await h.ev(`${row}?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 700))");
        const after = await h.ev(`(() => ({
            detail: !!document.querySelector('[data-jarvis-initiative-detail]'),
            sheet: !!document.querySelector('[data-jarvis-brief-sheet-face]'),
            aria: document.querySelector('[data-jarvis-brief-row="initiative"]')?.getAttribute('aria-expanded') ?? null,
        }))()`);
        steps.push({
            step: "1. clicking an initiative expands it in place and opens no sheet",
            ok: before.rows > 0 && after.detail === true && after.sheet === false && after.aria === "true",
            detail: JSON.stringify({ before, after }),
        });
        await h.shot("cdp-shots/brief-inline-tracker-expanded.png");
        const expandedFloor = await floorStep(
            h,
            `1b. no visible text in the expanded initiative is under ${MIN_FONT_PX}px`,
            `document.querySelector('[data-jarvis-initiative-detail]')`
        );
        let menuShadow = null;

        // 2. only the stage holding the next chunk starts open
        const stages = await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-stage]')].map((b) => b.getAttribute('aria-expanded'))`);
        const chunks = await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-chunk]')].length`);
        const hasPlan = Array.isArray(stages) && stages.length > 0;
        steps.push(
            hasPlan
                ? {
                      step: "2. exactly one stage starts expanded, and it is the only one contributing chunk rows",
                      ok: stages.filter((a) => a === "true").length === 1 && chunks > 0,
                      detail: JSON.stringify({ stages, chunks }),
                  }
                : skipStep(
                      "2. exactly one stage starts expanded, and it is the only one contributing chunk rows",
                      "no initiative with chunks in this dev store - the fixture seeds summaries only"
                  )
        );

        // 3. a chunk row takes the Brief's cursor and opens its Chunk sidebar
        let sidebar = { panel: false, cursorOnChunk: false };
        if (hasPlan && chunks > 0) {
            await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-chunk]')][0]?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 500))");
            sidebar = await h.ev(`(() => ({
                panel: !!document.querySelector('[data-jarvis-chunk-sidebar]'),
                cursorOnChunk: !!document.querySelector('[data-jarvis-tracker-chunk][aria-pressed="true"]'),
            }))()`);
        }
        steps.push(
            hasPlan && chunks > 0
                ? {
                      step: "3. selecting a chunk opens the Chunk sidebar and marks that row selected",
                      ok: sidebar.panel === true && sidebar.cursorOnChunk === true,
                      detail: JSON.stringify(sidebar),
                  }
                : skipStep(
                      "3. selecting a chunk opens the Chunk sidebar and marks that row selected",
                      "no chunk rows to select - seed an initiative carrying a plan"
                  )
        );
        await h.shot("cdp-shots/brief-inline-tracker-notes.png");

        // 4. Escape backs out one rung at a time and never leaves the surface while a note is open
        let esc = { afterFirst: null, surface: null };
        if (hasPlan && chunks > 0) {
            // real key events, not synthetic DOM ones: the binding registry listens on the window
            for (const type of ["keyDown", "keyUp"]) {
                await h.cdp("Input.dispatchKeyEvent", {
                    type,
                    key: "Escape",
                    code: "Escape",
                    windowsVirtualKeyCode: 27,
                });
            }
            await h.ev("new Promise((r) => setTimeout(r, 400))");
            esc = await h.ev(`(() => ({
                afterFirst: !!document.querySelector('[data-jarvis-chunk-sidebar]'),
                surface: !!document.querySelector('[data-jarvis-region="brief"]'),
            }))()`);
        }
        steps.push(
            hasPlan && chunks > 0
                ? {
                      step: "4. Escape closes the sidebar and stays on the Brief",
                      ok: esc.afterFirst === false && esc.surface === true,
                      detail: JSON.stringify(esc),
                  }
                : skipStep(
                      "4. Escape closes the sidebar and stays on the Brief",
                      "sidebar never opened - step 3 had no chunk row to select"
                  )
        );

        // 5-8. the editing layer. Every step asserts and none commits a write: the delete is taken back
        // with Undo inside its window, so no RPC is ever sent against the dev store.
        if (hasPlan && chunks > 0) {
            // 5. the status pill opens a menu with the six statuses
            await h.ev(`document.querySelector('[data-jarvis-chunk-status]')?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            // each item leads with a glyph span, so read the label span rather than the whole button
            const menu = await h.ev(`(() => {
                const m = document.querySelector('[data-jarvis-tracker-menu]');
                return m ? [...m.querySelectorAll('button')].map((b) => b.querySelector('.flex-1')?.textContent.trim() ?? "") : null;
            })()`);
            await h.shot("cdp-shots/brief-inline-tracker-menu.png");
            menuShadow = await paintEval(h, `return shadowVs(document.querySelector("[data-jarvis-tracker-menu]"), "shadow-popover-md");`);
            // real keys again: the menu's Escape rung is a window-capture binding, and it must close the
            // menu without also backing out of the surface
            for (const type of ["keyDown", "keyUp"]) {
                await h.cdp("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            }
            await h.ev("new Promise((r) => setTimeout(r, 300))");
            const afterEsc = await h.ev(`(() => ({
                menu: !!document.querySelector('[data-jarvis-tracker-menu]'),
                brief: !!document.querySelector('[data-jarvis-region="brief"]'),
                chunks: document.querySelectorAll('[data-jarvis-tracker-chunk]').length,
            }))()`);
            const six = ["pending", "active", "blocked", "deferred", "skipped", "done"];
            steps.push({
                step: "5. the status pill opens a menu listing all six statuses, and Escape closes only the menu",
                ok:
                    Array.isArray(menu) &&
                    six.every((s) => menu.includes(s)) &&
                    afterEsc.menu === false &&
                    afterEsc.brief === true &&
                    afterEsc.chunks === chunks,
                detail: JSON.stringify({ menu, afterEsc }),
            });

            // 6. double-click renames in place, and Escape leaves the label untouched
            await h.ev(`document.querySelector('[data-jarvis-tracker-chunk]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            const renaming = await h.ev(`!!document.querySelector('[data-jarvis-rename-input]')`);
            steps.push({ step: "6. double-clicking a chunk opens its rename input", ok: renaming === true, detail: String(renaming) });
            await h.ev(`document.querySelector('[data-jarvis-rename-input]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            await h.ev("new Promise((r) => setTimeout(r, 150))");

            // 7. delete hides the row at once, and Undo brings it back without a write
            const label = await h.ev(`document.querySelectorAll('[data-jarvis-tracker-chunk]').length > 1 ? document.querySelector('[data-jarvis-tracker-chunk]').getAttribute('data-jarvis-tracker-chunk') : null`);
            if (label != null) {
                const sel = `document.querySelector('[data-jarvis-tracker-chunk="' + CSS.escape(${JSON.stringify(label)}) + '"]')`;
                await h.ev(`document.querySelector('[data-jarvis-chunk-status]')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 200))");
                await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-menu] button')].find((b) => b.textContent.trim() === 'Delete chunk')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 200))");
                const gone = await h.ev(`!${sel} && !!document.querySelector('[data-jarvis-toast-undo]')`);
                await h.ev(`document.querySelector('[data-jarvis-toast-undo]')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 300))");
                const back = await h.ev(`!!${sel}`);
                steps.push({
                    step: "7. delete hides the chunk behind an Undo toast, and Undo restores it",
                    ok: gone === true && back === true,
                    detail: JSON.stringify({ label, gone, back }),
                });
            } else {
                steps.push(skipStep("7. delete hides the chunk behind an Undo toast, and Undo restores it", "the plan has one chunk"));
            }

            // 8. the footer's delete asks first
            await h.ev(`document.querySelector('[data-jarvis-initiative-action="delete"]')?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            const confirm = await h.ev(`document.querySelector('[data-jarvis-delete-confirm]')?.textContent ?? null`);
            steps.push({
                step: "8. deleting an initiative asks for confirmation first",
                ok: typeof confirm === "string" && confirm.includes("Delete this initiative"),
                detail: String(confirm),
            });
            await h.shot("cdp-shots/brief-inline-tracker-confirm.png");
            await h.ev(`[...document.querySelectorAll('[data-jarvis-delete-confirm] button')].find((b) => b.textContent.trim() === 'cancel')?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 150))");
        } else {
            steps.push(skipStep("5-8. the editing layer: status menu, rename, delete + undo, delete confirm", "no initiative with chunks in this dev store"));
        }

        // 9. collapsing removes the chunk rows again, so a stale cursor cannot survive on one
        await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')][0]?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const collapsed = await h.ev(`(() => ({
            detail: !!document.querySelector('[data-jarvis-initiative-detail]'),
            chunks: document.querySelectorAll('[data-jarvis-tracker-chunk]').length,
        }))()`);
        steps.push({
            step: "9. collapsing the initiative removes its plan rows",
            ok: collapsed.detail === false && collapsed.chunks === 0,
            detail: JSON.stringify(collapsed),
        });
        steps.push(expandedFloor);
        const menuStep = "10. the open tracker menu casts shadow-popover-md over no raw overlay";
        steps.push(
            menuShadow != null
                ? { step: menuStep, ok: menuShadow.ok === true, detail: JSON.stringify(menuShadow) }
                : skipStep(menuStep, "no initiative with chunks in this dev store - ui-drift renders the menu through the module")
        );

        return steps;
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

export const jarvisMotion = {
    name: "jarvis-motion",
    surface: "jarvis",
    async arrange() {
        return { id: `loose-end:cdp-motion:${Date.now()}` };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

        // 1. ModalShell variant="sheet" is `absolute z-20`, not the dialog's `fixed z-[70]` — that is
        //    what keeps a detail sheet scoped to the Brief and the nav rail reachable underneath it.
        //    Driven through the router because no fixture state carries a queue `nav`, so no fixture
        //    row is a button that opens anything.
        const chans = await h.rpc("getchannels", null);
        const channel = (chans?.channels ?? [])[0];
        if (channel == null) {
            rec(
                "1. the sheet mounts inside a Brief-scoped backdrop",
                false,
                "no channel in this profile — seed one before reading this as a pass"
            );
        } else {
            await h.ev(`(async () => {
                for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                return window.__openAddress?.(${JSON.stringify(`channel:${channel.oid}`)});
            })()`);
            await settle(1200);
            const scoped = await h.ev(`(() => {
                const sheet = document.querySelector('[data-jarvis-brief-sheet]');
                // the panel IS the [role="dialog"]; the backdrop is the element it sits in
                const backdrop = sheet?.closest('[role="dialog"]')?.parentElement ?? null;
                const rail = document.querySelector('nav button[aria-label="Cockpit"]');
                const r = rail?.getBoundingClientRect();
                const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
                return {
                    sheet: sheet != null,
                    position: backdrop ? getComputedStyle(backdrop).position : null,
                    // the claim itself rather than a proxy for it: a click on the rail still lands there
                    railReachable: rail != null && hit != null && rail.contains(hit),
                };
            })()`);
            rec(
                "1. the sheet mounts inside a Brief-scoped backdrop, nav rail still hit-testable",
                scoped.sheet === true && scoped.position === "absolute" && scoped.railReachable === true,
                JSON.stringify(scoped)
            );
            await h.shot("cdp-shots/jarvis-motion-sheet.png");
            await h.ev(
                `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close detail sheet')?.click()`
            );
            await settle(500);
        }

        // 2. freshness against a visit cursor older than the rows. The `normal` fixture's cursor is
        //    seven days back and every initiative and session row it carries is one to three days old,
        //    so each of those regions must mark, and must mark no more rows than it has.
        await h.ev(`document.querySelector('[data-briefing-fixture="normal"]')?.click()`);
        await settle(900);
        const TALLY = `(() => {
            const per = {};
            document.querySelectorAll('[data-jarvis-brief-row]').forEach((r) => {
                const k = r.dataset.jarvisBriefRow;
                per[k] = per[k] || { rows: 0, marked: 0 };
                per[k].rows += 1;
                if (r.classList.contains('fresh-mark')) per[k].marked += 1;
            });
            return per;
        })()`;
        const marked = await h.ev(TALLY);
        const region = (k) => marked[k] ?? { rows: 0, marked: 0 };
        rec(
            "2. rows newer than the visit cursor carry the freshness mark",
            region("initiative").marked > 0 && region("session").marked > 0,
            JSON.stringify(marked)
        );
        await h.shot("cdp-shots/jarvis-motion-fresh.png");

        // 3. the cap, per region. freshrows.ts suppresses the mark entirely above FRESH_MARK_CAP,
        //    because a week away that lights up every row is decoration rather than a reading aid.
        //    Asserted per region, not in total: the three marked regions each call freshKeys with
        //    their own list, so the cap is three separate budgets and a summed check would be wrong.
        const FRESH_MARK_CAP = 6;
        const capped = ["queue", "initiative", "session"].every((k) => region(k).marked <= FRESH_MARK_CAP);
        rec(
            `3. no region marks more than ${FRESH_MARK_CAP} rows`,
            capped,
            JSON.stringify({ cap: FRESH_MARK_CAP, ...marked })
        );

        // 4. the negative. The plan asked for a fixture whose rows all PREDATE the cursor; no fixture
        //    supplies one — every loaded state hangs its timestamps one to three days off `now` while
        //    the cursor sits seven days back. So the deterministic negative the design actually states
        //    stands in for it: the `behind` region is since-your-last-visit by construction, which is
        //    why it is excluded from the mark — marking it would mark every row, and the region's own
        //    label already says the thing the mark would be saying. `empty` is kept alongside it as
        //    the trivial case: no rows, therefore no marks, therefore no mark leaking from elsewhere.
        const behind = region("delta").marked + region("shipped").marked;
        rec(
            "4. the behind region carries no mark, though every row in it postdates the cursor",
            behind === 0 && region("delta").rows + region("shipped").rows > 0,
            JSON.stringify({ delta: region("delta"), shipped: region("shipped") })
        );

        await h.ev(`document.querySelector('[data-briefing-fixture="empty"]')?.click()`);
        await settle(700);
        const emptyMarks = await h.ev(`document.querySelectorAll('.fresh-mark').length`);
        rec("5. a state with no rows marks nothing", emptyMarks === 0, String(emptyMarks));

        // 6. the updates drawer. Task 14 moved the scroll container to an inner div: paneReveal
        //    animates the outer element's height and needs overflow-hidden there, which on the same
        //    element would fight overflow-y-auto and clip the scrollbar mid-tween. TWO injected pet
        //    events guarantee the drawer exists at all: the peek gives the newest update its own
        //    LatestUpdate row and the drawer holds only updates.slice(1), so one event fills the
        //    former and leaves the latter unmounted. One used to be enough because the pet had other
        //    update sources; those were memory-derived and went with the memvault removal.
        await h.ev(`(() => {
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            return true;
        })()`);
        await settle(200);
        const pushed = await h.ev(`(() => {
            const mod = globalThis.__wavePetStore;
            if (mod == null) return "petstore test hook not exposed (dev build?)";
            for (const n of [1, 2]) {
                mod.pushPetEvent({
                    id: ${JSON.stringify(ctx.id)} + ":" + n,
                    at: Date.now() + n,
                    kind: "loose-end",
                    text: "CDP motion probe " + n + " - untouched for 21 days",
                    sources: [{ ref: "task:cdp-motion-" + n, title: "CDP motion probe " + n, sourceType: "dossier" }],
                });
            }
            // and the busy shape, which is the only one that renders the drawer: the quiet card keeps the
            // latest update alone. Cleared in teardown.
            if (typeof mod.setAttention !== "function") return "petstore setAttention hook not exposed";
            mod.setAttention([
                { key: "dag-blocked:cdp-motion", kind: "dag-blocked", source: "CDP motion block", text: "The group is blocked.", action: "Review", waitingsince: Date.now() - 120000, channelid: "", runid: "cdp-motion", phaseidx: 0 },
            ]);
            return true;
        })()`);
        await settle(400);
        await h.ev(`document.querySelector('[aria-label="Jarvis condition"]')?.click()`);
        await settle(300);
        const DRAWER = `(() => {
            const box = document.querySelector('[data-pet-updates]');
            const toggle = box?.querySelector('button[aria-expanded]');
            // the revealing element is the toggle's sibling; the scroller is its only child
            const pane = toggle?.nextElementSibling ?? null;
            const scroller = pane?.firstElementChild ?? null;
            return {
                expanded: toggle?.getAttribute('aria-expanded') ?? null,
                rows: scroller ? scroller.children.length : 0,
                paneOverflow: pane ? getComputedStyle(pane).overflow : null,
                scrollerOverflowY: scroller ? getComputedStyle(scroller).overflowY : null,
            };
        })()`;
        const shut = await h.ev(DRAWER);
        await h.ev(`(() => {
            const toggle = document.querySelector('[data-pet-updates] button[aria-expanded]');
            if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
            return true;
        })()`);
        await settle(500);
        const opened = await h.ev(DRAWER);
        rec(
            "6. the drawer toggles its updates list, height on the outside and the scroller within",
            pushed === true &&
                shut.expanded === "false" &&
                shut.rows === 0 &&
                opened.expanded === "true" &&
                opened.rows > 0 &&
                opened.paneOverflow === "hidden" &&
                opened.scrollerOverflowY === "auto",
            JSON.stringify({ pushed, shut, opened })
        );
        await h.shot("cdp-shots/jarvis-motion-drawer.png");

        return steps;
    },
    async teardown(h) {
        await h.ev(`(() => {
            // the injected utterance advanced a PERSISTED watermark, so leaving it moved is a side
            // effect on the user's own creature rather than a test (jarvis-volunteer's rule)
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            // the injected gate is what put the peek in its busy shape; left behind it would follow the
            // user out of the run as a waiting item that nothing can answer
            globalThis.__wavePetStore?.setAttention?.([]);
            try {
                globalThis.localStorage?.removeItem("wave:pet.watermark");
                globalThis.localStorage?.removeItem("jarvis.subject.last");
            } catch {}
            return true;
        })()`);
        await h.goto("cockpit");
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

// --- record-band-detach-restore: correcting a run's record from the run sheet, and undoing it ----------
// The band's EdgeControls on a run with one attributed record: Not this record moves the edge to the Detached
// group, Restore brings it back. The edge is accepted in the arrange, so it is confirmed and the detach asks
// first. The ambient re-read behind every band update is slow (it sweeps every record), so each wait polls for
// 25s, under the 30s cap on one evaluate.
const RECORD_BAND_GOAL = "verify record-band: an attributed run, do nothing";
// the record CreateRun captures for that goal, as BRIEF_PEEK_RECORD
const RECORD_BAND_RECORD = "verify-record-band-an-attributed-run-do-nothing";
const RECORD_BAND = `document.querySelector("[data-jarvis-record-band]")`;
const RECORD_BAND_POLLS = 100;
const RECORD_BAND_LIB = `
    const bandButton = (label) =>
        [...(${RECORD_BAND}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim() === label);
    const bandText = () => (${RECORD_BAND}?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 300);
    const until = async (fn) => {
        for (let i = 0; i < ${RECORD_BAND_POLLS} && !fn(); i++) {
            await new Promise((r) => setTimeout(r, 250));
        }
        return !!fn();
    };
`;

// two records on one ticket, guessed onto a second run by that ticket in its channel's name (layer 2). The
// second run's goal is the first's, so its capture collides with the record the first made and adds no
// confirmed edge: both of its edges stay guesses. Objectives run past the detail's clamp, and neither names the
// ticket, so a picker match on "1739" is a ticket match.
const RECORD_BAND_TICKET = "VERIFY-1739";
const RECORD_BAND_TWINS = [
    { id: "verify-record-band-twin-a", head: "Verify record-band twin A shares a ticket with twin B." },
    { id: "verify-record-band-twin-b", head: "Verify record-band twin B shares a ticket with twin A." },
];
const RECORD_BAND_FILLER = "This sentence is padding, so the record detail has a body long enough to clamp. ".repeat(7);
const RECORD_BAND_PICKER = `${RECORD_BAND}?.querySelector("[data-jarvis-record-picker]")`;
const RECORD_BAND_PICKER_INPUT = `${RECORD_BAND_PICKER}?.querySelector("input")`;
const RECORD_BAND_GLYPH_TITLE = "Guessed by Jarvis: expand to confirm or detach it";

// the run's own record, written before CreateRun so its capture finds it: a two-line objective, and a ticket
// that is not the twins' so the picker's "1739" still narrows to the twins. Rewritten whole each run, which
// also drops any ref an earlier run left in it.
const RECORD_BAND_RECORD_TICKET = "VERIFY-2201";
const RECORD_BAND_RECORD_HEAD = "Verify record-band detach and restore";
const RECORD_BAND_RECORD_OBJECTIVE = `${RECORD_BAND_RECORD_HEAD}\nA second line the row leaves out.`;

// with the empty machine blocks renderDossier lays down: accepting an edge writes the refs block in place.
// The objective goes quoted, as renderDossier writes one with a newline in it.
function writeRecordBandRecord(dir, id, ticket, objective, stamp) {
    const file = join(dir, `${id}.md`);
    const block = (name) => [`<!-- jarvis:begin ${name} -->`, `<!-- jarvis:end ${name} -->`];
    const lines = [
        "---",
        "status: active",
        `ticket: ${ticket}`,
        `objective: ${JSON.stringify(objective)}`,
        "acceptance: []",
        "confidence: med",
        `created: ${stamp}`,
        `updated: ${stamp}`,
        "---",
        ...block("state"),
        ...block("refs"),
        ...block("blockers"),
        "",
        "## Notes",
        "",
        "",
    ];
    writeFileSync(file, lines.join("\n"));
    return file;
}

// returns only the twins' files: teardown removes those, and the run's record stays as it always has
async function seedRecordBandRecords(h) {
    const dir = join(await vaultRoot(h), "tasks", "active");
    mkdirSync(dir, { recursive: true });
    const stamp = Date.now() - 30 * DAY_MS;
    writeRecordBandRecord(dir, RECORD_BAND_RECORD, RECORD_BAND_RECORD_TICKET, RECORD_BAND_RECORD_OBJECTIVE, stamp);
    return RECORD_BAND_TWINS.map((t) =>
        writeRecordBandRecord(dir, t.id, RECORD_BAND_TICKET, `${t.head} ${RECORD_BAND_FILLER.trim()}`, stamp)
    );
}

export const recordBandDetachRestore = {
    name: "record-band-detach-restore",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-record-band-")) };
        try {
            ctx.twinFiles = await seedRecordBandRecords(h);
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-record-band", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: RECORD_BAND_GOAL,
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            ctx.runORef = `run:${ctx.runId}`;
            // a later run finds the record already there and its capture fails, so attach explicitly
            await h.rpc("acceptdossieredge", { dossierid: RECORD_BAND_RECORD, runoref: ctx.runORef });
            // its own project, so the first record's anchor repo adds no structural edge to it
            ctx.guessed = { cwd: mkdtempSync(join(tmpdir(), "verify-record-band-guessed-")) };
            const ch2 = await h.rpc("createchannel", {
                name: `verify-record-band ${RECORD_BAND_TICKET}`,
                projectpath: ctx.guessed.cwd,
            });
            ctx.guessed.channelId = ch2.oid;
            const created2 = await h.rpc("createrun", {
                channelid: ctx.guessed.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: RECORD_BAND_GOAL,
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.guessed.runId = created2.run.id;
            ctx.guessed.runORef = `run:${ctx.guessed.runId}`;
            // the Brief reads a boot-primed snapshot, so the RPC-created channel needs a reload
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.goto("jarvis");
            ctx.opened = await h.ev(`(async () => {
                for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
                return window.__openAddress(${JSON.stringify(ctx.runORef)});
            })()`);
            ctx.bandShown = await h.ev(`(async () => {
                ${RECORD_BAND_LIB}
                return until(() => ${RECORD_BAND}?.querySelector("[data-jarvis-band-toggle]"));
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const detachedIds = async () =>
            ((await h.rpc("listdetachededges", { runoref: ctx.runORef }))?.edges ?? []).map((e) => e.dossierid);
        rec(
            "0. the run's sheet opened with its record on the band",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.bandShown === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, opened: ctx.opened, band: ctx.bandShown })
        );

        const expanded = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            const toggle = ${RECORD_BAND}?.querySelector("[data-jarvis-band-toggle]");
            if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
            const ok = await until(() => bandButton("Not this record"));
            return { ok, restore: !!bandButton("Restore"), text: bandText() };
        })()`);
        rec(
            "1. expanding the band shows the edge with Not this record and no Restore",
            expanded.ok === true && expanded.restore === false,
            JSON.stringify(expanded)
        );

        const detached = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            bandButton("Not this record")?.click();
            // a confirmed edge asks first; the dialog is outside the band, and its button's text ends in a key hint
            const dialogButton = () =>
                [...document.querySelectorAll("button")].find(
                    (b) => (b.textContent || "").trim().startsWith("Detach") && !${RECORD_BAND}?.contains(b)
                );
            for (let i = 0; i < 12 && !dialogButton(); i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            const confirm = dialogButton();
            confirm?.click();
            const ok = await until(() => bandButton("Restore") && !bandButton("Not this record"));
            const row = ${RECORD_BAND}?.querySelector("[data-jarvis-detached-row]");
            return {
                ok,
                asked: !!confirm,
                label: (row?.querySelector("[data-jarvis-detached-label]")?.textContent || "").replace(/\\s+/g, " ").trim(),
                ticket: row?.querySelector("[data-jarvis-ticket-chip]")?.textContent?.trim() ?? null,
                text: bandText(),
            };
        })()`);
        const afterDetach = await detachedIds();
        await h.shot("cdp-shots/record-band-detached.png");
        rec(
            "2. Not this record moves the edge to a Detached row that offers Restore, labelled with the objective's first line and its ticket chip",
            detached.ok === true &&
                detached.label === `Detached · ${RECORD_BAND_RECORD_HEAD}` &&
                detached.ticket === RECORD_BAND_RECORD_TICKET &&
                afterDetach.includes(RECORD_BAND_RECORD),
            JSON.stringify({ ...detached, stored: afterDetach })
        );

        const restored = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            const restore = bandButton("Restore");
            restore?.click();
            const ok = !!restore && (await until(() => bandButton("Not this record") && !bandButton("Restore")));
            return { ok, clicked: !!restore, detachedRow: bandText().includes("Detached"), text: bandText() };
        })()`);
        const afterRestore = await detachedIds();
        await h.shot("cdp-shots/record-band-restored.png");
        rec(
            "3. Restore puts the edge back and empties the Detached group",
            restored.ok === true && restored.detachedRow === false && !afterRestore.includes(RECORD_BAND_RECORD),
            JSON.stringify({ ...restored, stored: afterRestore })
        );
        // pinned at verify's own size: a scenario before this one can leave the ~1000x700 window, and the
        // detail's one-line headline read is width-sensitive
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        // the band's line on a confirmed edge: the chip, worded for a person, and nothing before it
        const confirmedLine = await h.ev(`(() => {
            const line = ${RECORD_BAND}?.querySelector("[data-jarvis-band-toggle]");
            const chip = line?.querySelector("[data-jarvis-edge-chip]");
            const before = chip ? [...line.querySelectorAll("span")].filter((s) => s.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING && !s.contains(chip)) : [];
            return {
                chipTitle: chip?.getAttribute("title") ?? null,
                label: chip?.querySelector("[data-jarvis-edge-label]")?.textContent?.trim() ?? null,
                glyph: line?.querySelector("[data-jarvis-band-glyph]") != null,
                textBefore: before.map((s) => (s.textContent || "").trim()).join(" ").trim(),
                lineText: (line?.innerText || "").replace(/\\s+/g, " ").trim(),
            };
        })()`);
        rec(
            "4. a confirmed edge's line reads confirmed, has no glyph, and shows no record id before its chip",
            confirmedLine.chipTitle === RECORD_BAND_RECORD &&
                confirmedLine.label === "confirmed" &&
                confirmedLine.glyph === false &&
                confirmedLine.textBefore === "" &&
                !confirmedLine.lineText.includes(RECORD_BAND_RECORD) &&
                !/informing/.test(confirmedLine.lineText),
            JSON.stringify(confirmedLine)
        );

        const picked = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            bandButton("+ Attach another record")?.click();
            const opened = await until(() => ${RECORD_BAND_PICKER}?.querySelector("[data-jarvis-record-picker-row]"));
            const rows = () => [...(${RECORD_BAND_PICKER}?.querySelectorAll("[data-jarvis-record-picker-row]") ?? [])];
            // the old column printed id.slice(0, 8) in its own span
            const idColumn = rows().some((r) =>
                [...r.querySelectorAll("span")].some((s) => (s.textContent || "").trim() === (r.getAttribute("title") || "").slice(0, 8))
            );
            const input = ${RECORD_BAND_PICKER_INPUT};
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            set.call(input, "1739");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            const twins = ${JSON.stringify(RECORD_BAND_TWINS.map((t) => t.id))};
            const narrowed = await until(() => rows().length > 0 && rows().every((r) => twins.includes(r.getAttribute("title"))));
            const matched = rows().map((r) => ({ id: r.getAttribute("title"), text: (r.innerText || "").replace(/\\s+/g, " ").trim() }));
            ${RECORD_BAND_PICKER_INPUT}?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
            const top = matched[0]?.id;
            const attached = await until(() =>
                !${RECORD_BAND_PICKER} && ${RECORD_BAND}?.querySelector('[data-jarvis-edge-chip][title="' + top + '"]')
            );
            return { opened: !!opened, idColumn, narrowed, matched, top, attached, text: bandText() };
        })()`);
        ctx.attachedTwin = picked.top ?? null;
        await h.shot("cdp-shots/record-band-picker-attached.png");
        rec(
            "5. the picker shows no record id, finds both twins by a ticket fragment, and Enter attaches the top one",
            picked.opened === true &&
                picked.idColumn === false &&
                picked.narrowed === true &&
                picked.matched.length === RECORD_BAND_TWINS.length &&
                picked.matched.every((m) => m.text.includes(RECORD_BAND_TICKET)) &&
                picked.attached === true,
            JSON.stringify(picked)
        );

        const escaped = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            bandButton("+ Attach another record")?.click();
            const opened = await until(() => ${RECORD_BAND_PICKER_INPUT});
            ${RECORD_BAND_PICKER_INPUT}?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
            await new Promise((r) => setTimeout(r, 400));
            return { opened: !!opened, picker: !!${RECORD_BAND_PICKER}, sheet: !!${RECORD_BAND}, attachButton: !!bandButton("+ Attach another record") };
        })()`);
        rec(
            "6. Escape in the picker closes the picker and leaves the run sheet open",
            escaped.opened === true && escaped.picker === false && escaped.sheet === true && escaped.attachButton === true,
            JSON.stringify(escaped)
        );

        // the second run: two guessed edges from the shared ticket
        const guessedLine = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            const opened = await window.__openAddress(${JSON.stringify(ctx.guessed?.runORef ?? "")});
            const twins = ${JSON.stringify(RECORD_BAND_TWINS.map((t) => t.id))};
            const line = () => ${RECORD_BAND}?.querySelector("[data-jarvis-band-toggle]");
            const chip = () => line()?.querySelector("[data-jarvis-edge-chip]");
            const shown = await until(() => twins.includes(chip()?.getAttribute("title")) && /\\+1 more/.test(line()?.innerText || ""));
            const glyph = line()?.querySelector("[data-jarvis-band-glyph]");
            const lineText = (line()?.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                opened,
                shown,
                expanded: line()?.getAttribute("aria-expanded"),
                label: chip()?.querySelector("[data-jarvis-edge-label]")?.textContent?.trim() ?? null,
                glyphTitle: glyph?.getAttribute("title") ?? null,
                glyphBeforeChip: !!glyph && !!chip() && !!(glyph.compareDocumentPosition(chip()) & Node.DOCUMENT_POSITION_FOLLOWING),
                idInLine: twins.some((id) => lineText.includes(id)),
                informing: /informing/.test(bandText()),
                lineText,
            };
        })()`);
        await h.shot("cdp-shots/record-band-guessed.png");
        rec(
            "7. a guessed edge's line reads guessed with its confidence word and carries the Jarvis glyph",
            guessedLine.opened?.ok === true &&
                guessedLine.shown === true &&
                guessedLine.expanded === "false" &&
                /^guessed · (strong|likely|weak)$/.test(guessedLine.label ?? "") &&
                guessedLine.glyphTitle === RECORD_BAND_GLYPH_TITLE &&
                guessedLine.glyphBeforeChip === true &&
                guessedLine.idInLine === false &&
                guessedLine.informing === false,
            JSON.stringify(guessedLine)
        );

        const twinRows = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            const toggle = ${RECORD_BAND}?.querySelector("[data-jarvis-band-toggle]");
            if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
            const chips = () => [...(${RECORD_BAND}?.querySelectorAll("[data-jarvis-edge-chip]") ?? [])].filter((c) => !toggle?.contains(c));
            const ok = await until(() => chips().length === ${RECORD_BAND_TWINS.length} && ${RECORD_BAND}?.querySelector("[data-jarvis-detail-headline]"));
            const rows = chips().map((c) => ({
                id: c.getAttribute("title"),
                label: (c.querySelector(".truncate")?.textContent || "").trim(),
                ticket: c.querySelector("[data-jarvis-edge-ticket]")?.textContent?.trim() ?? null,
                edge: c.querySelector("[data-jarvis-edge-label]")?.textContent?.trim() ?? null,
            }));
            return { ok, rows, distinct: new Set(rows.map((r) => r.label)).size === rows.length };
        })()`);
        rec(
            "8. expanded, two records on one ticket have distinct labels and each carries the ticket chip",
            twinRows.ok === true &&
                twinRows.distinct === true &&
                twinRows.rows.every((r) => r.ticket === RECORD_BAND_TICKET && /^guessed · /.test(r.edge ?? "")),
            JSON.stringify(twinRows)
        );

        const heads = RECORD_BAND_TWINS.map((t) => t.head);
        const detailBody = await h.ev(`(async () => {
            const band = ${RECORD_BAND};
            const h2 = band?.querySelector("[data-jarvis-detail-headline]");
            const body = band?.querySelector("[data-jarvis-detail-body]");
            const toggle = band?.querySelector("[data-jarvis-detail-body-toggle]");
            const lineHeight = h2 ? parseFloat(getComputedStyle(h2).lineHeight) : 0;
            const read = () => ({
                height: body?.getBoundingClientRect().height ?? 0,
                clamped: body ? body.scrollHeight > body.clientHeight + 1 : false,
                label: (toggle?.textContent || "").trim(),
                expanded: toggle?.getAttribute("aria-expanded") ?? null,
            });
            const before = read();
            const headline = (h2?.textContent || "").trim();
            const bodyText = (body?.textContent || "").trim();
            toggle?.click();
            await new Promise((r) => setTimeout(r, 400));
            const after = read();
            toggle?.click();
            return {
                headline,
                h2Lines: h2 && lineHeight > 0 ? Math.round(h2.getBoundingClientRect().height / lineHeight) : null,
                bodyRepeatsHead: bodyText.includes(headline),
                before,
                after,
            };
        })()`);
        await h.shot("cdp-shots/record-band-detail.png");
        rec(
            "9. the record detail heads with the one-line objective headline, its body clamped behind Show the full objective",
            heads.includes(detailBody.headline) &&
                detailBody.h2Lines === 1 &&
                detailBody.bodyRepeatsHead === false &&
                detailBody.before.clamped === true &&
                detailBody.before.label.startsWith("Show the full objective") &&
                detailBody.before.expanded === "false" &&
                detailBody.after.height > detailBody.before.height &&
                detailBody.after.clamped === false &&
                detailBody.after.label === "Show less",
            JSON.stringify(detailBody)
        );

        const confirmCopy = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            bandButton("→ archived")?.click();
            // the run sheet is a dialog too, and holds the confirm: the innermost match is the confirm
            const dialog = () => [...document.querySelectorAll("[role=dialog], [role=alertdialog]")].filter((d) => /Mark this/.test(d.textContent || "")).pop();
            await until(() => dialog());
            const text = (dialog()?.textContent || "").replace(/\\s+/g, " ").trim();
            const cancel = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().startsWith("Cancel"));
            cancel?.click();
            const closed = await until(() => !dialog());
            return { text, closed, status: ${RECORD_BAND}?.querySelector("[data-record-status]")?.getAttribute("data-record-status") ?? null };
        })()`);
        rec(
            "10. the detail's status confirm asks to mark this record, in the peek's words",
            confirmCopy.text.includes("Mark this record archived?") &&
                confirmCopy.text.includes(`the record's status`) &&
                confirmCopy.closed === true &&
                confirmCopy.status === "active",
            JSON.stringify(confirmCopy)
        );
        steps.push(await floorStep(h, `11. no visible text in the record band is under ${MIN_FONT_PX}px`, RECORD_BAND));
        return steps;
    },
    async teardown(h, ctx) {
        // detached, so the record keeps one run ref across runs rather than growing one per run
        await teardownFixtureRun(h, ctx, "record-band-detach-restore", {
            what: "detach the run from the record",
            fn: () => (ctx.runORef ? h.rpc("detachdossieredge", { dossierid: RECORD_BAND_RECORD, runoref: ctx.runORef }) : null),
        });
        if (ctx.guessed?.channelId) {
            await teardownFixtureRun(h, ctx.guessed, "record-band-detach-restore (guessed run)");
        }
        // the twins go whole, with any ref the picker step hardened into one
        for (const file of ctx.twinFiles ?? []) {
            try {
                rmSync(file, { force: true });
            } catch (e) {
                console.error(`record-band-detach-restore teardown: remove ${file} failed: ${e?.message ?? e}`);
            }
        }
    },
};

// --- brief-initiatives-polish: a staged and a flat initiative, their sidebar and activity ---------
// Two throwaway efforts made over RPC: one staged (with an unstaged tail), one flat whose feed holds a
// note-carrying status change, a bare one, and a long note. Every surface it opens is swept for text
// under MIN_FONT_PX.
const POLISH_STAGED = "verify initiatives polish · staged";
const POLISH_FLAT = "verify initiatives polish · flat";
const POLISH_ADDED = "F4 added by the scenario";
const polishRow = (title) =>
    `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`;
const polishDetail = (title) => `${polishRow(title)}?.parentElement?.querySelector('[data-jarvis-initiative-detail="true"]')`;

// every element whose own text is under the floor; svg is drawn, not read
const polishSweep = (rootExpr) => `(() => {
    const root = ${rootExpr};
    if (!root) return null;
    const offenders = [];
    let seen = 0;
    for (const el of [root, ...root.querySelectorAll('*')]) {
        if (el.closest('svg')) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim() !== '');
        if (!own) continue;
        seen++;
        if (parseFloat(getComputedStyle(el).fontSize) < ${MIN_FONT_PX}) {
            const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join('').trim();
            offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80), text: text.slice(0, 40) });
        }
    }
    return { seen, offenders: offenders.slice(0, 5), count: offenders.length };
})()`;
const sweptOk = (s) => s != null && s.seen > 0 && s.count === 0;

export const briefInitiativesPolish = {
    name: "brief-initiatives-polish",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { oids: [] };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            const staged = await h.rpc("effortcreate", {
                title: POLISH_STAGED,
                chunks: [{ label: "S1" }, { label: "S2" }, { label: "U1" }],
            });
            ctx.staged = staged.effortoid;
            ctx.oids.push(ctx.staged);
            await h.rpc("effortmutate", {
                effortoid: ctx.staged,
                author: "you",
                ops: [
                    { op: "setChunkStage", chunk: "S1", stage: "Stage one" },
                    { op: "setChunkStage", chunk: "S2", stage: "Stage one" },
                ],
            });
            const flat = await h.rpc("effortcreate", {
                title: POLISH_FLAT,
                chunks: [{ label: "F1" }, { label: "F2" }, { label: "F3" }],
            });
            ctx.flat = flat.effortoid;
            ctx.oids.push(ctx.flat);
            await h.rpc("effortmutate", {
                effortoid: ctx.flat,
                author: "you",
                ops: [
                    {
                        op: "setChunkStatus",
                        chunk: "F1",
                        status: "done",
                        note: "Landed the first slice. The rest waits on review. Nothing else moved.",
                    },
                    { op: "setChunkStatus", chunk: "F2", status: "active" },
                    {
                        op: "appendNote",
                        chunk: "F2",
                        note:
                            "Started on the second slice. " +
                            "It touches the feed model, the view and the scenario, and each of those reads the others. ".repeat(12),
                    },
                ],
            });
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. the two initiatives were made", false, ctx.arrangeError);
            return steps;
        }
        await h.goto("jarvis");
        // a briefing fixture another scenario left on hides the live data, and only a reload clears it
        const fixtureOn = await h.ev(
            `[...document.querySelectorAll('[data-briefing-fixture]')].some((b) => b.className.includes('bg-accentbg'))`
        );
        if (fixtureOn) await polishReload(h);
        const both = `!!${polishRow(POLISH_STAGED)} && !!${polishRow(POLISH_FLAT)}`;
        // the Brief may hold a snapshot from before the efforts existed; one reload picks them up
        if (!(await polishWaitFor(h, both, 8000))) {
            await polishReload(h);
        }
        const rows = await polishWaitFor(h, both, 15000);
        rec("0. both initiatives show on the Brief", rows, JSON.stringify({ staged: ctx.staged, flat: ctx.flat }));
        if (!rows) return steps;

        // 1. the staged plan keeps its stage header
        await h.ev(`${polishRow(POLISH_STAGED)}?.click()`);
        await polishWaitFor(h, `!!${polishDetail(POLISH_STAGED)}`, 3000);
        await polishNap(400);
        const stagedHeads = await h.ev(`${polishDetail(POLISH_STAGED)}?.querySelectorAll('[data-jarvis-tracker-stage]').length ?? 0`);
        const stagedSweep = await h.ev(polishSweep(polishDetail(POLISH_STAGED)));
        await h.shot("cdp-shots/brief-initiatives-polish-1-staged.png");
        rec(
            "1. a staged initiative draws a stage header, and nothing in it is under 10.5px",
            stagedHeads >= 1 && sweptOk(stagedSweep),
            JSON.stringify({ stagedHeads, sweep: stagedSweep })
        );

        // 2. the flat plan draws no header, every chunk, and "+ Add chunk" after the last one
        await h.ev(`${polishRow(POLISH_FLAT)}?.click()`);
        await polishWaitFor(h, `!!${polishDetail(POLISH_FLAT)}`, 3000);
        await polishNap(400);
        const flat = await h.ev(`(() => {
            const d = ${polishDetail(POLISH_FLAT)};
            if (!d) return null;
            const chunks = [...d.querySelectorAll('[data-jarvis-tracker-chunk]')];
            const add = d.querySelector('[data-jarvis-add-chunk]');
            const last = chunks[chunks.length - 1];
            return {
                stages: d.querySelectorAll('[data-jarvis-tracker-stage]').length,
                chunks: chunks.length,
                add: add != null,
                afterLast: add != null && last != null && !!(last.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING),
            };
        })()`);
        const flatSweep = await h.ev(polishSweep(polishDetail(POLISH_FLAT)));
        await h.shot("cdp-shots/brief-initiatives-polish-2-flat.png");
        rec(
            "2. a flat initiative draws no stage header, all 3 chunks and + Add chunk after the last, nothing under 10.5px",
            flat != null && flat.stages === 0 && flat.chunks === 3 && flat.add && flat.afterLast && sweptOk(flatSweep),
            JSON.stringify({ flat, sweep: flatSweep })
        );

        // 2b. that "+ Add chunk" adds to stage "" (the add is a real write on a throwaway effort)
        let added = null;
        if (flat?.add) {
            await h.ev(`${polishDetail(POLISH_FLAT)}?.querySelector('[data-jarvis-add-chunk]')?.click()`);
            await polishNap(200);
            await h.ev(`(() => {
                const input = ${polishDetail(POLISH_FLAT)}?.querySelector('input');
                if (!input) return false;
                const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                set.call(input, ${JSON.stringify(POLISH_ADDED)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                return true;
            })()`);
            for (let waited = 0; waited < 5000 && added == null; waited += 250) {
                await polishNap(250);
                const { effort } = (await h.rpc("effortget", { effortoid: ctx.flat })) ?? {};
                const chunks = effort?.chunks ?? [];
                const at = chunks.findIndex((c) => c.label === POLISH_ADDED);
                if (at >= 0) added = { at, of: chunks.length, stage: chunks[at].stage ?? "" };
            }
        }
        rec(
            "2b. + Add chunk on a flat initiative adds the chunk at the end, to stage \"\"",
            added != null && added.stage === "" && added.at === added.of - 1,
            JSON.stringify(added)
        );

        // 3. a flat chunk's sidebar names no stage
        await h.ev(
            `${polishDetail(POLISH_FLAT)}?.querySelector('[data-jarvis-tracker-chunk="F1"]')?.click()`
        );
        const sidebarUp = await polishWaitFor(h, `!!document.querySelector('[data-jarvis-chunk-sidebar]')`, 3000);
        await polishNap(300);
        const crumb = await h.ev(`document.querySelector('[data-jarvis-chunk-sidebar]')?.innerText ?? ''`);
        const sidebarSweep = await h.ev(polishSweep(`document.querySelector('[data-jarvis-chunk-sidebar]')`));
        await h.shot("cdp-shots/brief-initiatives-polish-3-sidebar.png");
        rec(
            "3. a flat chunk opens the Chunk sidebar with no \"unstaged\" crumb, nothing under 10.5px",
            sidebarUp && !/unstaged/i.test(crumb) && sweptOk(sidebarSweep),
            JSON.stringify({ sidebarUp, unstaged: /unstaged/i.test(crumb), sweep: sidebarSweep })
        );
        const SIDEBAR = `document.querySelector('[data-jarvis-chunk-sidebar]')`;
        steps.push(await floorStep(h, `3b. no visible text in the Chunk sidebar is under ${MIN_FONT_PX}px`, SIDEBAR));

        // 3c. under a 1280px container the sidebar overlays the content, on the side-sheet shadow
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_NARROW);
        await polishNap(500);
        const side = await paintEval(h, `return shadowVs(${SIDEBAR}, "@max-[1280px]:shadow-sheet-side", ${OBS_NARROW.width});`);
        await h.shot(lookShot("brief-initiatives-polish-sidebar-narrow"));
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await polishNap(300);
        rec("3c. at a 1000px window the Chunk sidebar casts shadow-sheet-side over no raw overlay", side.ok === true, JSON.stringify(side));

        // 4. its activity link opens the grouped feed
        await h.ev(
            `[...(document.querySelector('[data-jarvis-chunk-sidebar]')?.querySelectorAll('button') ?? [])].find((b) => /^activity/i.test(b.innerText.trim()) || /activity/i.test(b.getAttribute('aria-label') ?? ''))?.click()`
        );
        const SHEET = `document.querySelector('[data-jarvis-brief-sheet="effort"]')`;
        const sheetUp = await polishWaitFor(h, `!!${SHEET}?.querySelector('[data-jarvis-effort-note]')`, 5000);
        await polishNap(300);
        const feed = await h.ev(`(() => {
            const s = ${SHEET};
            return s
                ? {
                      today: s.textContent.includes('Today'),
                      notes: s.querySelectorAll('[data-jarvis-effort-note]').length,
                      next: !!s.querySelector('[data-jarvis-effort-section="next"]'),
                      bar: !!s.querySelector('[role="img"][aria-label*="done"]'),
                  }
                : null;
        })()`);
        const sheetSweep = await h.ev(polishSweep(SHEET));
        await h.shot("cdp-shots/brief-initiatives-polish-4-activity.png");
        rec(
            "4. the activity sheet opens on its progress bar, a Next card, a Today divider and note lines, nothing under 10.5px",
            sheetUp && feed != null && feed.today && feed.notes >= 1 && feed.next && feed.bar && sweptOk(sheetSweep),
            JSON.stringify({ feed, sweep: sheetSweep })
        );
        steps.push(await floorStep(h, `4b. no visible text in the initiative sheet is under ${MIN_FONT_PX}px`, SHEET));

        // 5. the sheet's loading frame: the initiative dropped from the detail cache, with its re-read held
        const oref = `effort:${ctx.flat}`;
        await holdRpc(h, "EffortGetCommand");
        await lookEval(h, `
            const { effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const cache = new Map(globalStore.get(effortDetailAtom));
            window.__uiDriftEffort = cache.get(${JSON.stringify(oref)});
            cache.delete(${JSON.stringify(oref)});
            globalStore.set(effortDetailAtom, cache);
        `);
        const loading = await lookPlaceholders(h, SHEET);
        await h.shot(lookShot("brief-initiatives-polish-loading"));
        await lookEval(h, `
            const { effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const cache = new Map(globalStore.get(effortDetailAtom));
            if (window.__uiDriftEffort != null) cache.set(${JSON.stringify(oref)}, window.__uiDriftEffort);
            delete window.__uiDriftEffort;
            globalStore.set(effortDetailAtom, cache);
        `);
        await releaseRpc(h, "EffortGetCommand");
        steps.push({
            ...placeholderStep("5. while the initiative loads, its sheet holds three 40px blocks", loading, { height: 40, radius: "10px" }),
            ok: loading.length === 3 && loading.every((_, i) => placeholderStep("", loading, { height: 40, radius: "10px" }, i).ok),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await h
            .ev(`document.querySelector('[data-jarvis-brief-sheet] button[aria-label="Close detail sheet"]')?.click()`)
            .catch(() => {});
        await h
            .ev(
                `[...(document.querySelector('[data-jarvis-chunk-sidebar]')?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === 'Close')?.click()`
            )
            .catch(() => {});
        for (const effortoid of ctx.oids ?? []) {
            await h.rpc("effortdelete", { effortoid }).catch(() => {});
        }
        await h.goto("cockpit");
    },
};

// --- brief-peeks-polish: the record peek and the graph peek on the brief scale ----------------------
// docs/superpowers/specs/2026-09-29-brief-peeks-polish-design.md. A record whose objective is over 400 characters:
// its peek titles by the first sentence and clamps the rest; the graph peek focused on it prints the objective
// neither in its header nor on the canvas, and keeps Open record on screen. A profile with no such record gets one
// from a deferred run (run creation captures a dossier from the goal); the dossier stays in the vault afterwards,
// as run-sheet-polish's does, since no RPC deletes one.
const PEEKS_LONG = 400;
const PEEKS_GOAL =
    "verify brief-peeks-polish: do nothing, make no file changes, stop immediately. " +
    "This goal is long on purpose, so the record it captures has an objective the peek must clamp. ".repeat(6);
const PEEKS_RECORD = `document.querySelector('[data-jarvis-brief-band="peek"]')`;
const PEEKS_GRAPH = `document.querySelector('[data-jarvis-graph-peek]')`;
const PEEKS_OPEN = `[...(${PEEKS_GRAPH}?.querySelectorAll('button') ?? [])].find((b) => /^open record$/i.test((b.innerText || '').trim()))`;

export const briefPeeksPolish = {
    name: "brief-peeks-polish",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        const long = (d) => (d.objective ?? "").trim().length > PEEKS_LONG;
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            let found = ((await h.rpc("listtaskdossiers", null))?.dossiers ?? []).find(long);
            if (found == null) {
                ctx.cwd = mkdtempSync(join(tmpdir(), "verify-brief-peeks-polish-"));
                const wslist = await h.rpc("workspacelist", null);
                const ch = await h.rpc("createchannel", { name: "verify-brief-peeks-polish", projectpath: ctx.cwd });
                ctx.channelId = ch.oid;
                const created = await h.rpc("createrun", {
                    channelid: ctx.channelId,
                    workspaceid: wslist[0].workspacedata.oid,
                    goal: PEEKS_GOAL,
                    runtime: "claude",
                    mode: "orchestrator",
                    deferstart: true,
                });
                ctx.runId = created.run.id;
                found = ((await h.rpc("listtaskdossiers", null))?.dossiers ?? []).find(
                    (d) => (d.objective ?? "").trim() === PEEKS_GOAL.trim()
                );
            }
            if (found == null) throw new Error("no record has an objective over 400 characters, and seeding made none");
            ctx.recordId = found.id;
            ctx.objective = found.objective.trim();
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a record with an objective over 400 characters", false, ctx.arrangeError);
            return steps;
        }
        // narrow columns defeat by-name clicks, and verify.mjs clears any earlier override
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("jarvis");
        await h.ev(PEEKS_ESC);
        await polishNap(400);

        const opened = await h.ev(`(async () => {
            for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (typeof window.__openAddress !== "function") return "no __openAddress hook";
            await window.__openAddress(${JSON.stringify(`task:${ctx.recordId}`)});
            return "ok";
        })()`);
        const shown = await polishWaitFor(h, `!!${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-body]')`, 6000);
        rec("1. the record peek opens on the long record, with a body", opened === "ok" && shown, `opened=${opened} record=${ctx.recordId}`);
        if (!shown) return steps;
        await h.shot("cdp-shots/brief-peeks-polish-1-record.png");

        const text = (sel) => `(${PEEKS_RECORD}?.querySelector('${sel}')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`;
        const split = await h.ev(`({ title: ${text("[data-jarvis-peek-title]")}, body: ${text("[data-jarvis-peek-body]")} })`);
        rec(
            "2. the peek's title is not its body",
            split.title !== "" && split.title !== split.body,
            JSON.stringify({ title: split.title.slice(0, 80), body: split.body.slice(0, 80) })
        );
        const clamped = await h.ev(polishSweep(PEEKS_RECORD));
        rec("3. nothing in the record peek is under 10.5px", sweptOk(clamped), JSON.stringify(clamped));

        const toggled = await h.ev(`(() => {
            const b = ${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-body-toggle]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await polishNap(300);
        const expanded = await h.ev(polishSweep(PEEKS_RECORD));
        rec(
            "4. the long objective has a show-full link, and nothing is under 10.5px with it open",
            toggled === true && sweptOk(expanded),
            JSON.stringify({ toggled, expanded })
        );

        await h.ev(`${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-open-graph]')?.click()`);
        const focused = await polishWaitFor(h, `!!${PEEKS_OPEN}`, 8000);
        const panel = focused
            ? ""
            : await h.ev(`(${PEEKS_GRAPH}?.innerText ?? 'no graph peek').replace(/\\s+/g, ' ').slice(0, 160)`);
        rec("5. the map button opens the graph peek with the record selected", focused, panel);
        if (!focused) return steps;
        await polishNap(800);
        await h.shot("cdp-shots/brief-peeks-polish-2-graph.png");

        // the canvas element holds no text node, so the sweep passes over it
        const graphSweep = await h.ev(polishSweep(PEEKS_GRAPH));
        rec("6. nothing in the graph peek is under 10.5px", sweptOk(graphSweep), JSON.stringify(graphSweep));

        const probe = JSON.stringify(ctx.objective.replace(/\s+/g, " ").slice(0, 40));
        const graph = await h.ev(`(() => {
            const root = ${PEEKS_GRAPH};
            const flat = (el) => (el?.innerText ?? '').replace(/\\s+/g, ' ');
            const pane = root.querySelector('[data-jarvis-graph-canvas]');
            const r = ${PEEKS_OPEN}.getBoundingClientRect();
            return {
                header: flat(root.firstElementChild).includes(${probe}),
                pane: pane != null,
                card: flat(pane).includes(${probe}),
                openInView: r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
            };
        })()`);
        rec("7. the graph header prints no objective", graph.header === false, JSON.stringify(graph));
        rec("8. the side panel's Open record button is inside the viewport", graph.openInView === true, JSON.stringify(graph));
        rec("9. the canvas draws no selection card", graph.pane === true && graph.card === false, JSON.stringify(graph));
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await polishNap(300);
        await h.ev(PEEKS_ESC).catch(() => {});
        // cwd is made first, so a seed that threw before createrun returned still has its channel and dir removed
        if (ctx.cwd != null) await teardownFixtureRun(h, ctx, "brief-peeks-polish");
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
        return steps;
    },
    async teardown(h, ctx) {
        await lookEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            if (window.__liveBriefReal) RpcApi.JarvisStateCommand = window.__liveBriefReal;
            delete window.__liveBriefReal;
            delete window.__liveBriefLoads;
        `).catch(() => {});
        if (ctx?.effortoid) await h.rpc("effortdelete", { effortoid: ctx.effortoid }).catch(() => {});
    },
};

// --- brief-act: the Brief helps you act on what it shows ------------------------------------------------
// The 11-04 review's ten findings, one step each. A real initiative with two blocked chunks drives what writes:
// its waiting rows (needs, newer note, Unblock / Done with undo), the open that lands on the chunk, and Move to
// project. The "act" briefing fixture drives what only reads: ages and order, the filter past every fold, the
// quiet count, Behind you's grouping, Shipped's second line, the pet's room and the stale blocked runs.
const ACT_EFFORT = "verify brief-act blockers";
const ACT_PROJECT = "verify-brief-act";
// steps 28-34 make these two besides: a staged plan whose Beta stage starts folded (all done), and an archived one
const ACT_STAGED = "verify brief-act stages";
const ACT_ARCHIVED = "verify brief-act archived";
const actInitRow = (title) =>
    `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => (r.innerText || "").includes(${JSON.stringify(title)}))`;
const ACT_OPEN_INIT = `document.querySelector('[data-jarvis-brief-row="initiative"][aria-expanded="true"]')`;
// opens an initiative row's context menu and clicks one of its top-level items
async function actMenuClick(h, title, label) {
    return lookEval(h, `
        const row = ${actInitRow(title)};
        if (row == null) return { row: false, clicked: false };
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 40, clientY: r.top + 10 }));
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
        await until(() => globalStore.get(contextMenuAtom) != null, 3000);
        const item = globalStore.get(contextMenuAtom)?.items.find((i) => i.label === ${JSON.stringify(label)});
        item?.click?.();
        closeContextMenu();
        return { row: true, clicked: item != null };
    `);
}
// drops an initiative's plan from the detail cache, so the next open reads it again
const actUncache = (h, oref) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
        const cache = new Map(globalStore.get(effortDetailAtom));
        cache.delete(${JSON.stringify(oref)});
        globalStore.set(effortDetailAtom, cache);
    `);
const actClearToast = (h) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        globalStore.set((await mod("app/view/jarvis/briefundo.ts")).briefToastAtom, null);
    `);
const actQueueRow = (label) =>
    `[...document.querySelectorAll('[data-jarvis-brief-row="queue"]')].find((r) => (r.innerText || "").includes(${JSON.stringify(label)}))`;
const actText = (el) => `((${el})?.innerText || "").replace(/\\s+/g, " ").trim()`;

// lookEval prelude for steps 21-27: the store, the Brief's list-nav controller and the review fixture's roster. The
// roster is read at render, so swapping it and writing any atom the Brief reads re-renders on the same snapshot.
const ACT_BRIEF_LIB = `
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { listNavAtom } = await mod("app/store/keybindings/listnav.ts");
    const { settledChunksAtom } = await mod("app/view/jarvis/briefundo.ts");
    const fx = (await mod("app/view/jarvis/briefingfixtures.ts")).BRIEFING_FIXTURES.review;
    const setAgents = async (agents) => {
        fx.agents = agents;
        globalStore.set(settledChunksAtom, new Map(globalStore.get(settledChunksAtom)));
        await nap(60);
    };
    const scroll = document.querySelector('[data-jarvis-brief-scroll]');
    const cursorRow = () => document.querySelector('[data-jarvis-brief-cursor="true"]');
`;

async function actFixture(h, name) {
    await lookEval(h, `
        const { briefingFixtureAtom } = await mod("app/view/jarvis/briefingstore.ts");
        (await mod("app/store/jotaiStore.ts")).globalStore.set(briefingFixtureAtom, ${JSON.stringify(name)});
    `);
    await h.ev("new Promise((r) => setTimeout(r, 700))");
}

// the review fixture's direct-agent ask (briefingfixtures.ts REVIEW_AGENT_ASK_TEXT)
const REVIEW_AGENT_ASK = "Can I rename the tenant table?";

// steps 35, 36 and 37-38 set the registry, the dev roster and the review queue page-side; these put them back, and
// are no-ops after
const actRestoreConfig = (h) =>
    lookEval(h, `
        if (window.__briefActCfg === undefined) return;
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { atoms } = await mod("app/store/global-atoms.ts");
        globalStore.set(atoms.fullConfigAtom, window.__briefActCfg);
        delete window.__briefActCfg;
    `);
const actRestoreRoster = (h) =>
    lookEval(h, `
        if (!("__briefActRoster" in window)) return;
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        globalStore.set((await mod("app/view/agents/devmock.ts")).devMockAgentsAtom, window.__briefActRoster);
        delete window.__briefActRoster;
    `);
const actRestoreAttention = (h) =>
    lookEval(h, `${ACT_BRIEF_LIB}
        if (window.__briefActAttention === undefined) return;
        fx.attention = window.__briefActAttention;
        delete window.__briefActAttention;
        await setAgents(fx.agents);
    `);

async function actFilter(h, q) {
    await h.ev(`(() => {
        const i = document.querySelector('[data-jarvis-brief-filter]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(q)});
        i.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await h.ev("new Promise((r) => setTimeout(r, 500))");
}

async function actChunk(h, effortoid, label) {
    const { effort } = (await h.rpc("effortget", { effortoid })) ?? {};
    return effort?.chunks?.find((c) => c.label === label) ?? null;
}

async function actWaitChunk(h, effortoid, label, status) {
    for (let i = 0; i < 40; i++) {
        const c = await actChunk(h, effortoid, label);
        if (c?.status === status) return c;
        await new Promise((r) => setTimeout(r, 250));
    }
    return actChunk(h, effortoid, label);
}

export const briefAct = {
    name: "brief-act",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        try {
            ctx.effortoid = (
                await h.rpc("effortcreate", {
                    title: ACT_EFFORT,
                    project: ACT_PROJECT,
                    chunks: [{ label: "act-soak" }, { label: "act-label" }, { label: "act-settle" }],
                })
            ).effortoid;
            await h.rpc("effortmutate", {
                effortoid: ctx.effortoid,
                author: "you",
                ops: [
                    { op: "setChunkStatus", chunk: "act-soak", status: "blocked", note: "needs: a clean DEV soak" },
                    { op: "appendNote", chunk: "act-soak", note: "the empty-buffer blocker is gone on DEV" },
                    { op: "setChunkStatus", chunk: "act-label", status: "blocked", note: "needs: the G4 label" },
                    // F14's own (step 19): step 3 spends the other two
                    { op: "setChunkStatus", chunk: "act-settle", status: "blocked", note: "needs: a settle check" },
                ],
            });
            // a real run: its channel hosts the run sheet of step 24, and step 27 stops it
            ctx.cwd = mkdtempSync(join(tmpdir(), "verify-brief-act-"));
            await arrangeFixtureRun(h, ctx, "brief-act", "brief-act lead");
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("jarvis");
        await actFixture(h, null);
        await actFilter(h, "");
        // a fresh store's first briefing load runs past one CDP evaluate's 30s, so it is waited out here
        for (let i = 0; i < 180 && (await h.ev(`document.querySelector('[data-jarvis-brief-state="loading"]') != null`)); i++) {
            await new Promise((r) => setTimeout(r, 1000));
        }

        // 1. live: the blocked chunk's row says what it needs and shows the note written after the block
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        const live = await lookEval(h, `
            await until(() => ${actQueueRow("act-soak")} != null && ${actQueueRow("act-label")} != null, 30000);
            const row = ${actQueueRow("act-soak")};
            return {
                text: ${actText(actQueueRow("act-soak"))},
                latest: (row?.querySelector('[data-jarvis-queue-latest]')?.innerText || "").trim(),
                acts: [...(row?.querySelectorAll('[data-jarvis-queue-act]') ?? [])].map((b) => b.innerText.trim()),
                summary: ${actText(`document.querySelector('[data-jarvis-brief-attention-summary]')`)},
            };
        `);
        steps.push({
            step: "1. a blocked chunk's waiting row shows what it needs, its newer note, and Unblock / Done",
            ok:
                ctx.arrangeError == null &&
                live.text.includes("needs: a clean DEV soak") &&
                /the empty-buffer blocker is gone on DEV/.test(live.latest) &&
                JSON.stringify(live.acts) === JSON.stringify(["Unblock", "Done"]),
            detail: ctx.arrangeError ?? JSON.stringify(live),
        });
        await h.shot("cdp-shots/brief-act-waiting-live.png");

        // 2. opening the row lands on the chunk in its initiative's plan, notes open, no sheet
        await h.ev(`(${actQueueRow("act-label")})?.click()`);
        const landed = await lookEval(h, `
            await until(() => document.querySelector('[data-jarvis-chunk-sidebar]') != null, 6000);
            const side = document.querySelector('[data-jarvis-chunk-sidebar]');
            const chunk = document.querySelector('[data-jarvis-tracker-chunk="act-label"]');
            return {
                sidebar: (side?.innerText || "").includes("act-label"),
                reason: (side?.innerText || "").includes("needs: the G4 label"),
                pressed: chunk?.getAttribute("aria-pressed") ?? null,
                sheet: !!document.querySelector('[data-jarvis-brief-sheet]'),
            };
        `);
        steps.push({
            step: "2. opening a blocked chunk's row lands on that chunk with its notes, not the initiative's top",
            ok: landed.sidebar && landed.reason && landed.pressed === "true" && landed.sheet === false,
            detail: JSON.stringify(landed),
        });
        await h.shot("cdp-shots/brief-act-landed.png");
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"][aria-expanded="true"]')?.click()`);

        // 3. Unblock writes pending, its undo blocks it again with what it needs; Done finishes the other
        await h.ev(`(${actQueueRow("act-soak")})?.querySelector('[data-jarvis-queue-act="unblock-chunk"]')?.click()`);
        const unblocked = await actWaitChunk(h, ctx.effortoid, "act-soak", "pending");
        const toast = await h.ev(`(document.querySelector('[data-jarvis-brief-toast]')?.innerText || "").trim()`);
        await h.ev(`document.querySelector('[data-jarvis-toast-undo]')?.click()`);
        const reblocked = await actWaitChunk(h, ctx.effortoid, "act-soak", "blocked");
        await lookEval(h, `await until(() => ${actQueueRow("act-label")}?.querySelector('[data-jarvis-queue-act="done-chunk"]') != null, 15000);`);
        await h.ev(`(${actQueueRow("act-label")})?.querySelector('[data-jarvis-queue-act="done-chunk"]')?.click()`);
        const done = await actWaitChunk(h, ctx.effortoid, "act-label", "done");
        const newest = (c) => [...(c?.notes ?? [])].sort((a, b) => b.ts - a.ts)[0]?.text ?? "";
        steps.push({
            step: "3. Unblock and Done act from the row, and Unblock's undo blocks it again with its needs",
            ok:
                unblocked?.status === "pending" &&
                /Unblocked · act-soak/.test(toast) &&
                reblocked?.status === "blocked" &&
                newest(reblocked) === "marked blocked · needs: a clean DEV soak" &&
                done?.status === "done",
            detail: JSON.stringify({ unblocked: unblocked?.status, toast, reblocked: reblocked?.status, note: newest(reblocked), done: done?.status }),
        });

        // 4. Move to project from the initiative row's menu
        const menu = await lookEval(h, `
            await until(() => [...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].some((r) => (r.innerText || "").includes(${JSON.stringify(ACT_EFFORT)})), 15000);
            const row = [...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => (r.innerText || "").includes(${JSON.stringify(ACT_EFFORT)}));
            const r = row.getBoundingClientRect();
            row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 40, clientY: r.top + 10 }));
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { contextMenuAtom } = await mod("app/store/contextmenu.ts");
            await until(() => globalStore.get(contextMenuAtom) != null, 3000);
            const move = globalStore.get(contextMenuAtom)?.items.find((i) => i.label === "Move to project");
            const sub = (move?.submenu ?? []).map((i) => [i.label ?? i.type, i.checked ?? null]);
            const at = [...document.querySelectorAll("span.whitespace-nowrap")].find((s) => s.textContent === "Move to project")?.parentElement?.getBoundingClientRect();
            return { sub, at: at ? { x: Math.round(at.left + 40), y: Math.round(at.top + at.height / 2) } : null };
        `);
        if (menu.at) {
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: menu.at.x, y: menu.at.y });
            await h.ev("new Promise((r) => setTimeout(r, 500))");
        }
        await h.shot("cdp-shots/brief-act-move-menu.png");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
            globalStore.get(contextMenuAtom)?.items.find((i) => i.label === "Move to project")?.submenu?.find((i) => i.label === "No project")?.click();
            closeContextMenu();
        `);
        let moved = null;
        for (let i = 0; i < 40 && moved !== ""; i++) {
            // an empty project is omitted on the wire
            const got = ((await h.rpc("effortget", { effortoid: ctx.effortoid })) ?? {}).effort;
            moved = got != null ? (got.project ?? "") : null;
            if (moved !== "") await new Promise((r) => setTimeout(r, 250));
        }
        steps.push({
            step: "4. an initiative's menu moves it to another project (here: to no project)",
            ok: menu.sub.some(([l, c]) => l === ACT_PROJECT && c === true) && menu.sub.some(([l]) => l === "No project") && moved === "",
            detail: JSON.stringify({ sub: menu.sub, moved }),
        });

        // the rest reads the act fixture
        await actFixture(h, "act");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const queue = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')];
            return {
                summary: ${actText(`document.querySelector('[data-jarvis-brief-attention-summary]')?.parentElement`)},
                rows: rows.map((r) => (r.innerText || "").replace(/\\s+/g, " ").trim()),
            };
        })()`);
        const order = ["G10 validate", "S6 per-tenant", "P2 cut traffic"].map((t) => queue.rows.findIndex((r) => r.includes(t)));
        steps.push({
            step: "5. the queue counts blockers by kind and initiative, and lists them oldest first with their age",
            ok:
                /3 blocked · 2 initiatives · oldest 22d/.test(queue.summary) &&
                order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])) &&
                /22d/.test(queue.rows[order[0]] ?? "") &&
                /needs: the G4 label/.test(queue.rows[order[0]] ?? ""),
            detail: JSON.stringify({ summary: queue.summary, order, first: queue.rows[order[0]] }),
        });
        await h.shot("cdp-shots/brief-act-queue.png");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);

        // 6. the filter reaches rows behind Initiatives' and Behind you's folds
        await actFilter(h, "hypothesis tracker");
        const hitInit = await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].some((r) => (r.innerText || "").includes("Fold-hidden hypothesis tracker"))`);
        await actFilter(h, "dag-motion");
        const hitBehind = await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-row="delta"]')].some((r) => (r.innerText || "").includes("dag-motion easing settled"))`);
        await actFilter(h, "e2e quick run 2");
        const hitRuns = await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-region="sessions"] [data-jarvis-brief-row]')].some((r) => (r.innerText || "").includes("e2e quick run 2"))`);
        await actFilter(h, "");
        steps.push({
            step: "6. the filter finds rows behind the Initiatives, Behind you and Runs folds",
            ok: hitInit === true && hitBehind === true && hitRuns === true,
            detail: JSON.stringify({ hitInit, hitBehind, hitRuns }),
        });

        // 7. Initiatives counts the quiet ones instead of saying all moving
        const initMeta = await h.ev(`${actText(`document.querySelector('[data-jarvis-brief-region="initiatives"]')?.firstElementChild`)}`);
        steps.push({
            step: "7. the Initiatives head counts initiatives with no update in 7 days",
            ok: /2 quiet 7d\+/.test(initMeta) && !/all moving/.test(initMeta),
            detail: JSON.stringify(initMeta),
        });

        // 8 + 9. Behind you: an initiative's run folds into its digest, a goal reads as its first sentence with its
        // project, and Shipped's second line is prose with a project name, not report markdown on a cwd path
        const behind = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-region="behind"] [data-jarvis-brief-row]')];
            const t = (r) => (r.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                digest: t(rows.find((r) => t(r).includes("Anomaly-to-rule pipeline")) ?? {}),
                cancelled: t(rows.find((r) => t(r).includes("Clean up the cockpit")) ?? {}),
                attachedOwnRow: rows.some((r) => t(r).includes("Unblock the G10 label check")),
                shipped: t(rows.find((r) => r.dataset.jarvisBriefRow === "shipped") ?? {}),
            };
        })()`);
        steps.push({
            step: "8. Behind you folds an initiative's run into its digest and reads a goal as its first sentence",
            ok:
                /1 run/.test(behind.digest) &&
                !behind.attachedOwnRow &&
                behind.cancelled.includes("Clean up the cockpit's run list so a cancelled run reads plainly.") &&
                !behind.cancelled.includes("Read the run store first") &&
                behind.cancelled.includes("waveterm · cancelled"),
            detail: JSON.stringify(behind),
        });
        steps.push({
            step: "9. Shipped's second line is the project name and prose, no report markdown or cwd path",
            ok:
                behind.shipped.includes("portfolio-redesign · t-1: rebuilt the hero in hero.tsx") &&
                !/[#*`]|:\\/.test(behind.shipped),
            detail: JSON.stringify(behind.shipped),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-behind.png");

        // 10. the pet: the rows end with its reach of room so the last row scrolls clear of it, and Where we
        // were closes once the rows are scrolled by hand (a wheel; a scroll alone no longer closes it, F20)
        const pet = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { petBubbleAtom } = await mod("app/view/jarvis/petstore.ts");
            const scroll = document.querySelector('[data-jarvis-brief-scroll]');
            scroll.scrollTop = scroll.scrollHeight;
            await nap(300);
            const rows = [...scroll.querySelectorAll('[data-jarvis-brief-row]')];
            const last = rows[rows.length - 1]?.getBoundingClientRect();
            const avatar = document.querySelector('[aria-label="Jarvis condition"]')?.getBoundingClientRect();
            globalStore.set(petBubbleAtom, { id: "resume:brief-act:1", at: 1, kind: "resume", text: "Where we were — verify" });
            await nap(200);
            const shown = globalStore.get(petBubbleAtom) != null;
            scroll.scrollTop = 0;
            scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
            await nap(200);
            return {
                pad: parseFloat(getComputedStyle(scroll).paddingBottom),
                rowsN: rows.length,
                lastBottom: last ? Math.round(last.bottom) : null,
                avatarTop: avatar ? Math.round(avatar.top) : null,
                shown,
                closed: globalStore.get(petBubbleAtom) == null,
            };
        `);
        steps.push({
            step: "10. F20: the Brief's last row scrolls clear of the pet, and Where we were closes on a wheel",
            ok:
                pet.pad >= 124 &&
                pet.lastBottom != null &&
                (pet.avatarTop == null || pet.lastBottom <= pet.avatarTop) &&
                pet.shown &&
                pet.closed,
            detail: JSON.stringify(pet),
        });

        // 11. blocked runs a month old fold as stale, so Runs' live count agrees with the header
        const runs = await h.ev(`(() => ({
            regions: [...document.querySelectorAll('[data-jarvis-brief-region]')].map((s) => s.dataset.jarvisBriefRegion),
            rows: document.querySelectorAll('[data-jarvis-brief-scroll] [data-jarvis-brief-row]').length,
            head: ${actText(`document.querySelector('[data-jarvis-brief-region="sessions"]')?.firstElementChild`)},
            stale: ${actText(`document.querySelector('[data-jarvis-brief-stale]')`)},
            fleet: ${actText(`document.querySelector('[data-jarvis-brief-band="fleet"]')`)},
        }))()`);
        steps.push({
            step: "11. week-old blocked runs fold as stale: Runs reads 0 live, as the header says nothing running",
            ok: /0 live/.test(runs.head) && /3/.test(runs.stale) && /nothing running/.test(runs.fleet),
            detail: JSON.stringify(runs),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-region="sessions"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-runs.png");

        // 12-18: the 11-05 code review's Waiting and Behind you findings, on the "review" fixture
        await actFixture(h, "review");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const rowActs = (label) => `[...((${actQueueRow(label)})?.querySelectorAll('[data-jarvis-queue-act]') ?? [])].map((b) => b.innerText.trim())`;
        const waiting = await h.ev(`(() => ({
            summary: ${actText(`document.querySelector('[data-jarvis-brief-attention-summary]')?.parentElement`)},
            unverified: ${actText(actQueueRow("review unverified one"))},
            held: ${actText(actQueueRow("review held land"))},
            heldActs: ${rowActs("review held land")},
            ask: ${actText(actQueueRow("Which tenant goes first?"))},
            askActs: ${rowActs("Which tenant goes first?")},
        }))()`);
        steps.push({
            step: "12. F7: an unverified run and a held land read by their own kind words, and the summary counts them",
            ok: /^unverified /.test(waiting.unverified) && /^land held /.test(waiting.held) && /2 unverified/.test(waiting.summary),
            detail: JSON.stringify({ summary: waiting.summary, unverified: waiting.unverified, held: waiting.held }),
        });
        await h.shot("cdp-shots/brief-act-12-kinds.png");

        // 13. the held land's row offers the pet's verbs; Dismiss acks with land: true (the ack is stubbed)
        await lookEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            (window.__heldRpc ??= {}).AckRunCommand ??= RpcApi.AckRunCommand;
            window.__briefActAcks = [];
            RpcApi.AckRunCommand = (_client, data) => {
                window.__briefActAcks.push(data);
                return Promise.resolve();
            };
        `);
        await h.ev(`(${actQueueRow("review held land")})?.querySelector('[data-jarvis-queue-act="dismiss-land"]')?.click()`);
        const dismissed = await lookEval(h, `
            await until(() => (window.__briefActAcks ?? []).length > 0, 3000);
            await until(() => document.querySelector('[data-jarvis-brief-toast]') != null, 3000);
            return {
                acks: window.__briefActAcks ?? [],
                toast: (document.querySelector('[data-jarvis-brief-toast]')?.innerText || "").replace(/\\s+/g, " ").trim(),
            };
        `);
        await h.shot("cdp-shots/brief-act-13-held-land.png");
        await releaseRpc(h, "AckRunCommand");
        steps.push({
            step: "13. F8: a held land offers Retry land and Dismiss, and Dismiss acks the land",
            ok:
                JSON.stringify(waiting.heldActs) === JSON.stringify(["Retry land", "Dismiss"]) &&
                dismissed.acks.length === 1 &&
                dismissed.acks[0].land === true &&
                dismissed.acks[0].runid === "r-review-held" &&
                /Dismissed · review held land/.test(dismissed.toast),
            detail: JSON.stringify({ acts: waiting.heldActs, ...dismissed }),
        });

        steps.push({
            step: "14. F9: an ask with no channel draws no button, not a dead Open",
            ok: waiting.ask.includes("Which tenant goes first?") && waiting.askActs.length === 0,
            detail: JSON.stringify({ ask: waiting.ask, acts: waiting.askActs }),
        });
        await h.ev(`(${actQueueRow("Which tenant goes first?")})?.scrollIntoView({ block: "center" })`);
        await h.shot("cdp-shots/brief-act-14-no-act.png");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);

        // 15 + 16. Behind you: newest first across projects, and the cap counts folded lines. Its window is
        // module state, so one left open by hand is closed first.
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"] [data-jarvis-brief-more="less"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        const behindRows = await h.ev(`(() => {
            const sec = document.querySelector('[data-jarvis-brief-region="behind"]');
            const t = (r) => (r?.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                rows: [...(sec?.querySelectorAll('[data-jarvis-brief-row="delta"]') ?? [])].map(t),
                more: t(sec?.querySelector('[data-jarvis-brief-more]')),
            };
        })()`);
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"]')?.scrollIntoView({ block: "start" })`);
        steps.push({
            step: "15. F1: Behind you leads with today's newest line, not the decisions the server lists first",
            ok:
                behindRows.rows.length > 0 &&
                /Review notes initiative|Review run from today/.test(behindRows.rows[0]) &&
                !/review decision/.test(behindRows.rows[0]),
            detail: JSON.stringify(behindRows.rows.slice(0, 3)),
        });
        await h.shot("cdp-shots/brief-act-15-newest-first.png");
        const digest = behindRows.rows.find((r) => r.includes("Review notes initiative")) ?? "";
        // eight lines fold out of 47 events (the digest, the run, six decisions): the cap of 5 hides 3 lines
        steps.push({
            step: "16. F2: 40 notes fold to one digest, and +N more counts the folded lines it hides, not events",
            ok:
                /40 notes/.test(digest) &&
                behindRows.rows.filter((r) => r.includes("Review notes initiative")).length === 1 &&
                behindRows.rows.length === 5 &&
                behindRows.more === "+3 more",
            detail: JSON.stringify({ digest, drawn: behindRows.rows.length, more: behindRows.more }),
        });
        await h.shot("cdp-shots/brief-act-16-digest.png");

        // 17. a filter that matches nothing says so in the delta and in Shipped, and mark seen stays
        await actFilter(h, "zz-no-match");
        const noMatch = await h.ev(`(() => {
            const sec = document.querySelector('[data-jarvis-brief-region="behind"]');
            const text = (sec?.innerText || "").replace(/\\s+/g, " ");
            return {
                noMatch: text.split("Nothing here matches the filter.").length - 1,
                nothingNew: text.includes("Nothing new since you last looked."),
                markSeen: sec?.querySelector('[data-jarvis-brief-mark-seen]') != null,
            };
        })()`);
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-17-no-match.png");
        await actFilter(h, "");
        steps.push({
            step: "17. F17: a filter matching nothing reads as no match in Behind you and in Shipped, and mark seen stays",
            ok: noMatch.noMatch === 2 && !noMatch.nothingNew && noMatch.markSeen,
            detail: JSON.stringify(noMatch),
        });

        // 18. Behind you's head shows only that region, and a second press shows all four
        const regions = `[...document.querySelectorAll('[data-jarvis-brief-region]')].map((s) => s.dataset.jarvisBriefRegion)`;
        const behindHead = `document.querySelector('[data-jarvis-brief-region="behind"] button[aria-pressed]')`;
        await h.ev(`${behindHead}?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const onlyBehind = await h.ev(regions);
        await h.shot("cdp-shots/brief-act-18-only-behind.png");
        await h.ev(`${behindHead}?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const allRegions = await h.ev(regions);
        steps.push({
            step: "18. F18: pressing Behind you's head shows only it, and pressing again shows all four regions",
            ok: JSON.stringify(onlyBehind) === JSON.stringify(["behind"]) && allRegions.length === 4,
            detail: JSON.stringify({ onlyBehind, allRegions }),
        });

        // 19. live: Unblock hides the row and drops the initiative's count at the click; Undo brings both back
        await actFixture(h, null);
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        const initRow = `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => (r.innerText || "").includes(${JSON.stringify(ACT_EFFORT)}))`;
        const blockedN = `Number(/(\\d+) blocked/.exec((${initRow})?.innerText || "")?.[1] ?? 0)`;
        const settle = await lookEval(h, `
            await until(() => ${actQueueRow("act-settle")} != null && ${initRow} != null, 30000);
            const before = ${blockedN};
            ${actQueueRow("act-settle")}?.querySelector('[data-jarvis-queue-act="unblock-chunk"]')?.click();
            const t0 = Date.now();
            const gone = await until(() => ${actQueueRow("act-settle")} == null && ${blockedN} === before - 1, 1000);
            const goneMs = Date.now() - t0;
            const after = ${blockedN};
            return { before, gone, goneMs, after };
        `);
        await h.shot("cdp-shots/brief-act-19-settled.png");
        const restored = await lookEval(h, `
            await until(() => document.querySelector('[data-jarvis-toast-undo]') != null, 5000);
            document.querySelector('[data-jarvis-toast-undo]')?.click();
            const back = await until(() => ${actQueueRow("act-settle")} != null && ${blockedN} === ${settle.before}, 20000);
            return { back, n: ${blockedN} };
        `);
        const reblocked19 = await actWaitChunk(h, ctx.effortoid, "act-settle", "blocked");
        steps.push({
            step: "19. F14: Unblock removes its Waiting row and one of the initiative's N blocked at once; Undo brings both back",
            ok: settle.before > 0 && settle.gone && settle.after === settle.before - 1 && restored.back && reblocked19?.status === "blocked",
            detail: JSON.stringify({ ...settle, restored, chunk: reblocked19?.status }),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);

        // 20. live: mark seen empties Behind you at the click; its Undo brings the rows back
        const deltaN = `document.querySelectorAll('[data-jarvis-brief-region="behind"] [data-jarvis-brief-row="delta"]').length`;
        const seen = await lookEval(h, `
            await until(() => ${deltaN} > 0 && document.querySelector('[data-jarvis-brief-mark-seen]') != null, 20000);
            const before = ${deltaN};
            document.querySelector('[data-jarvis-brief-mark-seen]')?.click();
            const emptied = await until(() => ${deltaN} === 0, 1000);
            return { before, emptied, after: ${deltaN} };
        `);
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-20-marked-seen.png");
        const unseen = await lookEval(h, `
            await until(() => document.querySelector('[data-jarvis-toast-undo]') != null, 5000);
            document.querySelector('[data-jarvis-toast-undo]')?.click();
            const back = await until(() => ${deltaN} > 0, 20000);
            return { back, n: ${deltaN} };
        `);
        steps.push({
            step: "20. F14: mark seen empties Behind you at the click, and its Undo restores the rows",
            ok: seen.before > 0 && seen.emptied && unseen.back,
            detail: JSON.stringify({ ...seen, unseen }),
        });

        // 21-27: the 11-05 code review's Runs, snapshot and pet findings. The review fixture's Runs: an asking direct
        // agent above two live quick runs and twelve week-quiet orchestrator runs, and Shipped past its cap.
        await actFixture(h, "review");
        await actFilter(h, "");
        const sessionRows = `[...document.querySelectorAll('[data-jarvis-brief-region="sessions"] [data-jarvis-brief-row="session"]')]`;
        const LIVE_RUN = "sessions:run:run:r-review-live-2";
        const f5 = await lookEval(h, `${ACT_BRIEF_LIB}
            window.__briefActAgents ??= fx.agents;
            await setAgents([]);
            await nap(400);
            globalStore.get(listNavAtom)?.setCursor(${JSON.stringify(LIVE_RUN)});
            await nap(400);
            const before = { cursor: flat(cursorRow()), top: scroll.scrollTop };
            await setAgents(window.__briefActAgents);
            // an entrance replay starts from opacity 0, so 60ms in it still reads below 1
            const row = cursorRow();
            const opacity = row != null ? Number(getComputedStyle(row.parentElement).opacity) : null;
            await nap(400);
            const names = ${sessionRows}.map(flat);
            return {
                before,
                after: { cursor: flat(cursorRow()), top: scroll.scrollTop },
                opacity,
                asker: names.findIndex((t) => t.includes("review asker")),
                live: names.findIndex((t) => t.includes("Review live quick run 2")),
            };
        `);
        steps.push({
            step: "21. F5: an asking agent arriving above a Runs row leaves the cursor and the scroll where they were, with no entrance replay",
            ok:
                f5.before.cursor.includes("Review live quick run 2") &&
                f5.after.cursor === f5.before.cursor &&
                f5.after.top === f5.before.top &&
                f5.opacity === 1 &&
                f5.asker >= 0 &&
                f5.asker < f5.live,
            detail: JSON.stringify(f5),
        });
        await h.shot("cdp-shots/brief-act-21-stable-key.png");

        // 22. the asking agent's Answer goes to the Agent surface on that agent; a run whose Run has not loaded keeps
        // its run badge
        const f6 = await lookEval(h, `${ACT_BRIEF_LIB}
            const brief = document.querySelector('[data-jarvis-region="brief"]');
            const fk = brief && Object.keys(brief).find((k) => k.startsWith("__reactFiber$"));
            let model = null;
            for (let f = fk ? brief[fk] : null; f && model == null; f = f.return) {
                if (f.memoizedProps?.model?.focusIdAtom) model = f.memoizedProps.model;
            }
            const rows = ${sessionRows};
            const asker = rows.find((r) => flat(r).includes("review asker"));
            const live = rows.find((r) => flat(r).includes("Review live quick run 1"));
            const liveBadge = flat([...(live?.querySelectorAll("span") ?? [])].find((s) => s.className.includes("rounded-[5px]")));
            button(asker, /^Answer$/)?.click();
            await until(() => model != null && globalStore.get(model.surfaceAtom) === "agent", 3000);
            return {
                model: model != null,
                answer: button(asker, /^Answer$/) != null || !document.contains(asker),
                liveBadge,
                focus: model != null ? globalStore.get(model.focusIdAtom) : null,
                surface: model != null ? globalStore.get(model.surfaceAtom) : null,
            };
        `);
        await h.shot("cdp-shots/brief-act-22-answer-agent.png");
        steps.push({
            step: "22. F6: an asking direct agent's Answer lands on the Agent surface with that agent focused; an unloaded run keeps its run badge",
            ok: f6.focus === "tab-review-asker" && f6.surface === "agent" && f6.liveBadge === "quick run",
            detail: JSON.stringify(f6),
        });
        await h.goto("jarvis");
        await h.ev("new Promise((r) => setTimeout(r, 700))");

        // 23. the kind chips count what the head's N live counts, not the week-quiet runs behind the fold
        const f15 = await h.ev(`(() => {
            const sec = document.querySelector('[data-jarvis-brief-region="sessions"]');
            const t = (el) => (el?.innerText || "").replace(/\\s+/g, " ").trim();
            const chip = (k) => t(sec?.querySelector('[data-jarvis-run-kind] [data-filter-option="' + k + '"]'));
            return { head: t(sec?.firstElementChild), all: chip("all"), orchestrator: chip("orchestrator"), quick: chip("quick") };
        })()`);
        const chipN = (s) => Number(/(\d+)\s*$/.exec(s ?? "")?.[1] ?? NaN);
        const liveN = Number(/(\d+) live/.exec(f15.head)?.[1] ?? NaN);
        steps.push({
            step: "23. F15: the all chip counts the runs the head's N live counts, not the 12 stale ones",
            ok: liveN === 3 && chipN(f15.all) === liveN && chipN(f15.orchestrator) === 0 && chipN(f15.quick) === 2,
            detail: JSON.stringify(f15),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-region="sessions"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-23-live-chips.png");

        // 24. a run sheet on a shipped run steps through all of Shipped: the fourth run opens Shipped's fold and sits
        // under the cursor. The fixture's runs exist only on this page, so they ride a real channel's run list, and
        // the scenario lands the sheet on each one as the router would.
        const SHIPPED_RUNS = ["r-review-shipped", ...Array.from({ length: 4 }, (_, i) => `r-review-shipped-${i + 1}`)];
        await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-shipped-more]')].find((b) => /show less/.test(b.innerText))?.click()`);
        const f16 = await lookEval(h, `${ACT_BRIEF_LIB}
            const ch = ${JSON.stringify(ctx.channelId ?? "")};
            const ids = ${JSON.stringify(SHIPPED_RUNS)};
            const { activeChannelIdAtom, activeChannelAtom, activeChannelRunsAtom } = await mod("app/view/agents/channelsstore.ts");
            const { activeSubjectAtom, activeRunIdAtom } = await mod("app/view/jarvis/jarvissubjectstore.ts");
            const { briefSheetOpenAtom, briefRunListAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            globalStore.set(activeChannelIdAtom, ch);
            const loaded = await until(() => globalStore.get(activeChannelAtom) != null && globalStore.get(activeChannelRunsAtom).length > 0, 15000);
            const real = globalStore.get(activeChannelRunsAtom)[0];
            globalStore.set(activeChannelRunsAtom, ids.map((id) => ({ ...real, id, status: "done", mode: "quick" })));
            globalStore.set(activeRunIdAtom, { [ch]: ids[0] });
            globalStore.set(activeSubjectAtom, { kind: "channel", id: ch });
            globalStore.set(briefSheetOpenAtom, true);
            await nap(700);
            const behind = document.querySelector('[data-jarvis-brief-region="behind"]');
            const shippedHead = [...(behind?.querySelectorAll("div") ?? [])].find((d) => d.firstElementChild?.textContent === "Shipped · 7 days");
            const list = globalStore.get(briefRunListAtom);
            const navN = globalStore.get(listNavAtom)?.navigableIds.length ?? 0;
            const stepped = [];
            for (let i = 1; i <= 3; i++) {
                const c = globalStore.get(listNavAtom);
                const next = c.navigableIds[c.navigableIds.indexOf(c.cursorId) + 1];
                stepped.push(next);
                c.setCursor(next);
                globalStore.set(activeRunIdAtom, { [ch]: ids[i] });
                await nap(500);
            }
            const cur = cursorRow();
            return {
                loaded,
                list,
                head: flat(shippedHead?.children[1]),
                navN,
                stepped,
                cursor: flat(cur),
                cursorRow: cur?.dataset.jarvisBriefRow ?? null,
                fold: flat(behind?.querySelector('[data-jarvis-brief-shipped-more]')),
                drawn: behind?.querySelectorAll('[data-jarvis-brief-row="shipped"]').length ?? 0,
            };
        `);
        await h.ev(`document.querySelector('[data-jarvis-brief-cursor="true"]')?.scrollIntoView({ block: "center" })`);
        await h.shot("cdp-shots/brief-act-24-shipped-fold.png");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { activeChannelIdAtom } = await mod("app/view/agents/channelsstore.ts");
            const { clearSubject } = await mod("app/view/jarvis/jarvissubjectstore.ts");
            const { briefSheetOpenAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            globalStore.set(briefSheetOpenAtom, false);
            clearSubject();
            globalStore.set(activeChannelIdAtom, undefined);
            await nap(400);
        `);
        await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-shipped-more]')].find((b) => /show less/.test(b.innerText))?.click()`);
        steps.push({
            step: "24. F16: a run sheet on a shipped run counts all of Shipped, and stepping to the fourth run opens Shipped's fold under the cursor",
            ok:
                ctx.arrangeError == null &&
                f16.loaded &&
                JSON.stringify(f16.list) === JSON.stringify(SHIPPED_RUNS) &&
                Number(f16.head) === SHIPPED_RUNS.length &&
                f16.navN === SHIPPED_RUNS.length &&
                f16.cursorRow === "shipped" &&
                f16.cursor.includes("Review shipped run 3") &&
                f16.fold === "show less" &&
                f16.drawn === SHIPPED_RUNS.length,
            detail: ctx.arrangeError ?? JSON.stringify(f16),
        });

        // 25. a partial snapshot says which legs it could not read, and the regions they feed say so instead of
        // claiming nothing is there
        await actFixture(h, "partial");
        const f10 = await h.ev(`(() => {
            const t = (s) => (document.querySelector(s)?.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                band: t('[data-jarvis-brief-band="partial"]'),
                retry: document.querySelector('[data-jarvis-brief-partial-retry]') != null,
                runs: t('[data-jarvis-brief-region="sessions"]'),
                behind: t('[data-jarvis-brief-region="behind"]'),
                initiatives: t('[data-jarvis-brief-region="initiatives"]'),
            };
        })()`);
        await h.shot("cdp-shots/brief-act-25-partial.png");
        steps.push({
            step: "25. F10: a partial snapshot shows a band naming Runs and Initiatives with Retry, and Runs, Shipped and Initiatives say they couldn't be read",
            ok:
                /Partial snapshot: couldn't read Runs, Initiatives\./.test(f10.band) &&
                /Retry/.test(f10.band) &&
                f10.retry &&
                /couldn't read runs/i.test(f10.runs) &&
                /couldn't read shipped runs/i.test(f10.behind) &&
                !/nothing shipped/i.test(f10.behind) &&
                /couldn't read initiatives/i.test(f10.initiatives) &&
                !/no initiative is active/i.test(f10.initiatives),
            detail: JSON.stringify(f10),
        });

        // 26. a cursor move that scrolls the rows is not the user moving on: Where we were stays open. The stale fold
        // is opened first so the last row sits below the fold.
        await actFixture(h, "review");
        await h.ev(`document.querySelector('[data-jarvis-brief-stale][aria-expanded="false"]')?.click()`);
        const f20 = await lookEval(h, `${ACT_BRIEF_LIB}
            const { petBubbleAtom } = await mod("app/view/jarvis/petstore.ts");
            scroll.scrollTop = 0;
            await nap(300);
            globalStore.set(petBubbleAtom, { id: "resume:brief-act:2", at: 2, kind: "resume", text: "Where we were — verify" });
            await nap(200);
            const shown = globalStore.get(petBubbleAtom) != null;
            const top0 = scroll.scrollTop;
            const ids = globalStore.get(listNavAtom)?.navigableIds ?? [];
            globalStore.get(listNavAtom)?.setCursor(ids[ids.length - 1]);
            await nap(600);
            return { shown, top0, top: scroll.scrollTop, open: globalStore.get(petBubbleAtom) != null };
        `);
        await h.shot("cdp-shots/brief-act-26-bubble-stays.png");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { petBubbleAtom } = await mod("app/view/jarvis/petstore.ts");
            globalStore.set(petBubbleAtom, null);
        `);
        await h.ev(`document.querySelector('[data-jarvis-brief-stale][aria-expanded="true"]')?.click()`);
        steps.push({
            step: "26. F20: a cursor move that scrolls the rows with no key or pointer event leaves Where we were open",
            ok: f20.shown && f20.top > f20.top0 && f20.open,
            detail: JSON.stringify(f20),
        });

        // 27. live: a Stop the server refuses shows the reason in an error toast, and the run still reads as before
        await actFixture(h, null);
        const stopRow = `[...document.querySelectorAll('[data-jarvis-brief-region="sessions"] [data-jarvis-brief-row="session"]')].find((r) => (r.innerText || "").includes("verify brief-act: do nothing"))`;
        const STOP_REFUSED = "verify: the cancel was refused";
        const f22before = await lookEval(h, `
            (await mod("app/view/jarvis/briefingstore.ts")).refreshBriefing();
            const found = await until(() => ${stopRow}?.querySelector('button[title="Stop this session"]') != null, 60000);
            return { found, text: flat(${stopRow}) };
        `);
        await failRpc(h, "CancelRunCommand", STOP_REFUSED);
        const f22 = await lookEval(h, `
            ${stopRow}?.querySelector('button[title="Stop this session"]')?.click();
            await nap(300);
            button(dialog(), /^Cancel run$/)?.click();
            await until(() => document.querySelector('[data-jarvis-brief-toast="error"]') != null, 5000);
            await nap(300);
            return {
                toast: flat(document.querySelector('[data-jarvis-brief-toast]')),
                error: document.querySelector('[data-jarvis-brief-toast="error"]') != null,
                text: flat(${stopRow}),
            };
        `);
        await h.shot("cdp-shots/brief-act-27-stop-refused.png");
        await releaseRpc(h, "CancelRunCommand");
        steps.push({
            step: "27. F22: a Stop the server refuses shows an error toast with its message, and the run row is unchanged",
            ok:
                ctx.arrangeError == null &&
                f22before.found &&
                f22.error &&
                f22.toast.includes(STOP_REFUSED) &&
                f22.text === f22before.text &&
                !/stopped/.test(f22.text),
            detail: ctx.arrangeError ?? JSON.stringify({ before: f22before, ...f22 }),
        });

        // 28-34: the 11-05 code review's Initiatives findings, live. Two more initiatives: a staged one and an
        // archived one, deleted in teardown; act-label is blocked again for the filter of step 28.
        try {
            ctx.stagedoid = (
                await h.rpc("effortcreate", {
                    title: ACT_STAGED,
                    chunks: [{ label: "st-a" }, { label: "st-b" }, { label: "st-c" }],
                })
            ).effortoid;
            await h.rpc("effortmutate", {
                effortoid: ctx.stagedoid,
                author: "you",
                ops: [
                    { op: "setChunkStage", chunk: "st-a", stage: "Alpha" },
                    { op: "setChunkStage", chunk: "st-b", stage: "Beta" },
                    { op: "setChunkStage", chunk: "st-c", stage: "Beta" },
                    { op: "setChunkStatus", chunk: "st-b", status: "done" },
                    { op: "setChunkStatus", chunk: "st-c", status: "done" },
                ],
            });
            ctx.archivedoid = (
                await h.rpc("effortcreate", { title: ACT_ARCHIVED, chunks: [{ label: "arch-one" }, { label: "arch-two" }] })
            ).effortoid;
            await h.rpc("effortmutate", { effortoid: ctx.archivedoid, author: "you", ops: [{ op: "setStatus", status: "archived" }] });
            await h.rpc("effortmutate", {
                effortoid: ctx.effortoid,
                author: "you",
                ops: [{ op: "setChunkStatus", chunk: "act-label", status: "blocked", note: "needs: the G4 label" }],
            });
        } catch (e) {
            ctx.initError = String(e?.message ?? e);
        }
        const stagedOref = `effort:${ctx.stagedoid}`;
        const archivedOref = `effort:${ctx.archivedoid}`;

        // 28. a filter matching a Waiting row's needs but not its initiative: opening the row lands on the chunk
        await actFilter(h, "G4 label");
        const f3 = await lookEval(h, `
            const found = await until(() => ${actQueueRow("act-label")} != null, 30000);
            ${actQueueRow("act-label")}?.click();
            const landed = await until(() => (document.querySelector('[data-jarvis-chunk-sidebar]')?.innerText || "").includes("act-label"), 6000);
            await nap(300);
            return {
                found,
                landed,
                filter: document.querySelector('[data-jarvis-brief-filter]')?.value ?? null,
                pressed: document.querySelector('[data-jarvis-tracker-chunk="act-label"]')?.getAttribute("aria-pressed") ?? null,
                open: flat(${ACT_OPEN_INIT}),
            };
        `);
        await h.shot("cdp-shots/brief-act-28-filter-landing.png");
        steps.push({
            step: "28. F3: with a filter that matches a Waiting row's needs but not its initiative, opening the row lands on its chunk and clears the filter",
            ok: ctx.initError == null && f3.found && f3.landed && f3.filter === "" && f3.pressed === "true" && f3.open.includes(ACT_EFFORT),
            detail: ctx.initError ?? JSON.stringify(f3),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);

        // 29. the ↳ reveal on an archived initiative turns Show archived on and opens its plan on the chunk
        await h.ev(`document.querySelector('[data-jarvis-brief-archived="hide"]')?.click()`);
        const f4 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { loadArchivedEfforts } = await mod("app/view/jarvis/effortstore.ts");
            const { briefRevealChunkAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            await loadArchivedEfforts();
            await nap(300);
            const hiddenBefore = document.querySelector('[data-jarvis-brief-archived="hide"]') == null && ${actInitRow(ACT_ARCHIVED)} == null;
            globalStore.get(briefRevealChunkAtom)?.(${JSON.stringify(archivedOref)}, "arch-two");
            const landed = await until(() => document.querySelector('[data-jarvis-tracker-chunk="arch-two"]')?.getAttribute("aria-pressed") === "true", 6000);
            await nap(300);
            return {
                hiddenBefore,
                landed,
                showing: document.querySelector('[data-jarvis-brief-archived="hide"]') != null,
                open: flat(${ACT_OPEN_INIT}),
            };
        `);
        await h.ev(`${ACT_OPEN_INIT}?.scrollIntoView({ block: "center" })`);
        await h.shot("cdp-shots/brief-act-29-archived-reveal.png");
        steps.push({
            step: "29. F4: the ↳ reveal on an archived initiative turns Show archived on and opens its plan on the chunk",
            ok: f4.hiddenBefore && f4.landed && f4.showing && f4.open.includes(ACT_ARCHIVED),
            detail: JSON.stringify(f4),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);
        await h.ev(`document.querySelector('[data-jarvis-brief-archived="hide"]')?.click()`);

        // 30. a plan whose first load fails shows the error and Retry in place of the loading line; Retry loads it
        const PLAN_REFUSED = "verify: the plan read was refused";
        await actFilter(h, ACT_STAGED);
        await actUncache(h, stagedOref);
        await failRpc(h, "EffortGetCommand", PLAN_REFUSED);
        const f13 = await lookEval(h, `
            await until(() => ${actInitRow(ACT_STAGED)} != null, 30000);
            ${actInitRow(ACT_STAGED)}?.click();
            const shown = await until(() => document.querySelector('[data-jarvis-initiative-detail="error"]') != null, 6000);
            return {
                shown,
                text: flat(document.querySelector('[data-jarvis-initiative-detail="error"]')),
                retry: document.querySelector('[data-jarvis-plan-retry]') != null,
                loading: document.querySelector('[data-jarvis-initiative-detail="loading"]') != null,
            };
        `);
        await h.shot("cdp-shots/brief-act-30-plan-error.png");
        await releaseRpc(h, "EffortGetCommand");
        // the retried read waits on a gate rather than holdRpc's never-settling promise, so the Retry's own load
        // is the one that draws the plan once the gate opens
        const retrying = await lookEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            const real = RpcApi.EffortGetCommand;
            let open;
            const gate = new Promise((r) => (open = r));
            window.__planRetryGate = () => { RpcApi.EffortGetCommand = real; open(); };
            RpcApi.EffortGetCommand = (...args) => gate.then(() => real.apply(RpcApi, args));
            document.querySelector('[data-jarvis-plan-retry]')?.click();
            const loading = await until(() => document.querySelector('[data-jarvis-initiative-detail="loading"]') != null, 6000);
            return { loading, error: document.querySelector('[data-jarvis-initiative-detail="error"]') != null };
        `);
        await h.shot("cdp-shots/brief-act-30-plan-retrying.png");
        const f13b = await lookEval(h, `
            window.__planRetryGate?.();
            delete window.__planRetryGate;
            const drawn = await until(() => document.querySelector('[data-jarvis-tracker-stage]') != null, 10000);
            return { drawn, error: document.querySelector('[data-jarvis-initiative-detail="error"]') != null };
        `);
        await h.shot("cdp-shots/brief-act-30-plan-retried.png");
        steps.push({
            step: "30. F13: an initiative whose plan fails to load shows the error with Retry, and Retry draws the plan, showing the plan loading while it retries",
            ok:
                f13.shown &&
                f13.text.includes(PLAN_REFUSED) &&
                f13.retry &&
                !f13.loading &&
                retrying.loading &&
                !retrying.error &&
                f13b.drawn &&
                !f13b.error,
            detail: JSON.stringify({ ...f13, retrying, retried: f13b }),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);

        // 31. Details asked of an unloaded initiative, which is then collapsed, does not open on the next one
        await actFilter(h, "verify brief-act");
        await actUncache(h, stagedOref);
        await holdRpc(h, "EffortGetCommand");
        const f19menu = await actMenuClick(h, ACT_STAGED, "Details");
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const f19loading = await h.ev(`document.querySelector('[data-jarvis-initiative-detail="loading"]') != null`);
        await h.ev(`${ACT_OPEN_INIT}?.click()`);
        await releaseRpc(h, "EffortGetCommand");
        const f19 = await lookEval(h, `
            await nap(400);
            ${actInitRow(ACT_EFFORT)}?.click();
            const drawn = await until(() => document.querySelector('[data-jarvis-tracker-chunk="act-soak"]') != null, 10000);
            await nap(600);
            return { drawn, open: flat(${ACT_OPEN_INIT}), form: document.querySelector('[data-effort-field]') != null };
        `);
        await h.shot("cdp-shots/brief-act-31-no-stray-details.png");
        steps.push({
            step: "31. F19: Details from the menu of an unloaded initiative, collapsed before it loads, does not show on the next initiative opened",
            ok: f19menu.clicked && f19loading && f19.drawn && f19.open.includes(ACT_EFFORT) && !f19.form,
            detail: JSON.stringify({ menu: f19menu, loading: f19loading, ...f19 }),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);
        await actFilter(h, "");

        // 32. with Alpha's only chunk waiting out its delete, landing on st-c unfolds Beta (folded: all done) under the
        // cursor. The delete is scheduled as the plan's Delete schedules it, then undone inside its window.
        const f21 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { briefUndo, chunkKey } = await mod("app/view/jarvis/briefundo.ts");
            const { loadEffortDetail, removeChunks, effortChunkRows, effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
            const { briefRevealChunkAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            const oref = ${JSON.stringify(stagedOref)};
            await loadEffortDetail(oref);
            const plan = effortChunkRows(globalStore.get(effortDetailAtom).get(oref));
            briefUndo.schedule([chunkKey(oref, "st-a")], "Deleted “st-a”", () => removeChunks(oref, plan, ["st-a"]));
            globalStore.get(briefRevealChunkAtom)?.(oref, "st-c");
            const landed = await until(() => document.querySelector('[data-jarvis-tracker-chunk="st-c"]')?.getAttribute("aria-pressed") === "true", 3000);
            return {
                landed,
                beta: document.querySelector('[data-jarvis-tracker-stage="Beta"]')?.getAttribute("aria-expanded") ?? null,
                alpha: document.querySelector('[data-jarvis-tracker-stage="Alpha"]') != null,
            };
        `);
        await h.shot("cdp-shots/brief-act-32-pending-delete-landing.png");
        const f21undo = await lookEval(h, `
            document.querySelector('[data-jarvis-toast-undo]')?.click();
            const back = await until(() => document.querySelector('[data-jarvis-tracker-stage="Alpha"]') != null, 3000);
            return { back };
        `);
        const kept = await actChunk(h, ctx.stagedoid, "st-a");
        steps.push({
            step: "32. F21: with the first stage's only chunk pending delete, landing on a later stage's chunk unfolds that stage with the cursor on it; Undo keeps the chunk",
            ok: f21.landed && f21.beta === "true" && !f21.alpha && f21undo.back && kept != null,
            detail: JSON.stringify({ ...f21, undo: f21undo, kept: kept?.label ?? null }),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);

        // 33. a Pause the server refuses shows an error toast, and no "Paused"
        const MUTATE_REFUSED = "verify: the pause was refused";
        await actFilter(h, ACT_STAGED);
        await actClearToast(h);
        await failRpc(h, "EffortMutateCommand", MUTATE_REFUSED);
        const f11menu = await actMenuClick(h, ACT_STAGED, "Pause");
        const f11 = await lookEval(h, `
            const shown = await until(() => document.querySelector('[data-jarvis-brief-toast="error"]') != null, 5000);
            await nap(300);
            return { shown, toast: flat(document.querySelector('[data-jarvis-brief-toast]')) };
        `);
        await h.shot("cdp-shots/brief-act-33-pause-refused.png");
        await releaseRpc(h, "EffortMutateCommand");
        const stagedStatus = ((await h.rpc("effortget", { effortoid: ctx.stagedoid })) ?? {}).effort?.status ?? null;
        steps.push({
            step: "33. F11: a Pause from the menu that the server refuses shows an error toast with its reason, and no Paused toast",
            ok: f11menu.clicked && f11.shown && f11.toast.includes(MUTATE_REFUSED) && !/Paused/.test(f11.toast) && stagedStatus != null && stagedStatus !== "paused",
            detail: JSON.stringify({ menu: f11menu, ...f11, status: stagedStatus }),
        });
        await actFilter(h, "");

        // 34. a status change from the record peek that the server refuses names the reason in an error toast. The
        // refused write leaves whichever record it opens unchanged.
        const STATUS_REFUSED = "verify: the status write was refused";
        await actClearToast(h);
        await failRpc(h, "SetDossierStatusCommand", STATUS_REFUSED);
        const f12 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
            const { briefPeekRecordAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            const spaces = (await RpcApi.ListDossiersCommand(TabRpcClient))?.spaces ?? [];
            const record = (spaces.find((s) => s.id === "verify-brief-act-do-nothing") ?? spaces[0])?.id ?? null;
            if (record == null) return { record };
            globalStore.set(briefPeekRecordAtom, record);
            const band = '[data-jarvis-brief-band="peek"]';
            await until(() => document.querySelector(band + ' [data-jarvis-peek-status-toggle]') != null, 10000);
            const pick = [...document.querySelectorAll(band + ' button[data-jarvis-peek-status]')].find((b) => ["active", "paused"].includes(b.dataset.jarvisPeekStatus));
            const status = pick?.dataset.jarvisPeekStatus ?? null;
            pick?.click();
            const shown = await until(() => document.querySelector('[data-jarvis-brief-toast="error"]') != null, 5000);
            await nap(300);
            // the toast answers the open peek, so it must draw above the dialog scrim, not under it
            const el = document.querySelector("[data-jarvis-brief-toast]");
            const r = el?.getBoundingClientRect();
            const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
            const onTop = hit?.closest("[data-jarvis-brief-toast]") != null;
            return { record, status, shown, onTop, toast: flat(el) };
        `);
        await h.shot("cdp-shots/brief-act-34-status-refused.png");
        await releaseRpc(h, "SetDossierStatusCommand");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            globalStore.set((await mod("app/view/jarvis/jarvisstore.ts")).briefPeekRecordAtom, null);
        `);
        steps.push({
            step: "34. F12: a status change from the record peek that the server refuses shows an error toast naming the reason, drawn above the peek",
            ok: f12.record != null && f12.status != null && f12.shown && f12.onTop === true && f12.toast.includes("Couldn't set the record's status") && f12.toast.includes(STATUS_REFUSED),
            detail: JSON.stringify(f12),
        });

        // 35-40: the 11-05 Brief live pass. The review fixture's work keys name one project by path and by name
        // beside a run worktree and "(none)"; the registry is set page-side to that one project (Final's has none)
        // and put back after the step.
        await actFixture(h, "review");
        const f1 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { atoms } = await mod("app/store/global-atoms.ts");
            window.__briefActCfg ??= globalStore.get(atoms.fullConfigAtom);
            globalStore.set(atoms.fullConfigAtom, {
                ...window.__briefActCfg,
                projects: { waveterm: { path: "C:/Users/dev/IdeaProjects/waveterm" } },
            });
            const fact = '[data-jarvis-region="brief"] [data-jarvis-brief-band="projects"]';
            await until(() => /1 project$/.test(flat(document.querySelector(fact))), 3000);
            return { fact: flat(document.querySelector(fact)) };
        `);
        await h.shot("cdp-shots/brief-act-35-projects.png");
        await actRestoreConfig(h);
        steps.push({
            step: "35. F1: the header counts the registered projects the work spans, not its keys: one project by path and by name, a worktree and (none) read as all work · 1 project",
            ok: f1.fact === "all work · 1 project",
            detail: JSON.stringify(f1),
        });

        // 36. a direct agent's ask (no channel, its tab in the oref) names the agent and answers on the Agent surface.
        // The router opens a tab only when the live roster holds it, so the review asker joins the dev roster for the
        // step (devMockAgentsAtom, as sessions-detail-states does) and leaves it after.
        const f2 = await lookEval(h, `${ACT_BRIEF_LIB}
            if (window.__briefActAgents != null) await setAgents(window.__briefActAgents);
            const dm = await mod("app/view/agents/devmock.ts");
            if (!("__briefActRoster" in window)) window.__briefActRoster = globalStore.get(dm.devMockAgentsAtom);
            const asker = fx.agents.find((a) => a.id === "tab-review-asker");
            globalStore.set(dm.devMockAgentsAtom, [...globalStore.get(dm.devRosterAtom).filter((a) => a.id !== asker?.id), asker]);
            // step 22 left the focus on this agent, so it is moved off first: the step must see the open move it back
            const brief0 = document.querySelector('[data-jarvis-region="brief"]');
            const fk0 = brief0 && Object.keys(brief0).find((k) => k.startsWith("__reactFiber$"));
            for (let f = fk0 ? brief0[fk0] : null; f; f = f.return) {
                if (f.memoizedProps?.model?.focusIdAtom) {
                    globalStore.set(f.memoizedProps.model.focusIdAtom, undefined);
                    break;
                }
            }
            document.querySelector('[data-jarvis-brief-region="waiting"] [data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click();
            await until(() => ${actQueueRow(REVIEW_AGENT_ASK)} != null, 3000);
            await nap(300);
            const row = ${actQueueRow(REVIEW_AGENT_ASK)};
            const text = flat(row);
            const acts = [...(row?.querySelectorAll('[data-jarvis-queue-act]') ?? [])].map(flat);
            const brief = document.querySelector('[data-jarvis-region="brief"]');
            const fk = brief && Object.keys(brief).find((k) => k.startsWith("__reactFiber$"));
            let model = null;
            for (let f = fk ? brief[fk] : null; f && model == null; f = f.return) {
                if (f.memoizedProps?.model?.focusIdAtom) model = f.memoizedProps.model;
            }
            row?.querySelector('[data-jarvis-queue-act]')?.click();
            await until(() => model != null && globalStore.get(model.surfaceAtom) === "agent", 3000);
            return {
                text,
                acts,
                focus: model != null ? globalStore.get(model.focusIdAtom) : null,
                surface: model != null ? globalStore.get(model.surfaceAtom) : null,
            };
        `);
        await h.shot("cdp-shots/brief-act-36-agent-ask.png");
        await actRestoreRoster(h);
        steps.push({
            step: "36. F2: a direct agent's ask names the agent, offers one Answer, and Answer lands on the Agent surface with that agent focused",
            ok:
                f2.text.includes("review asker") &&
                !/\bworker\b/.test(f2.text) &&
                JSON.stringify(f2.acts) === JSON.stringify(["Answer"]) &&
                f2.focus === "tab-review-asker" &&
                f2.surface === "agent",
            detail: JSON.stringify(f2),
        });
        await h.goto("jarvis");
        await h.ev("new Promise((r) => setTimeout(r, 700))");

        // 37 + 38. the ask's age reads "just now" on one line at both sizes, and the summary counts a single ask.
        // The queue is narrowed page-side to that ask, made fresh, and put back after.
        const f14 = (size) =>
            lookEval(h, `${ACT_BRIEF_LIB}
                window.__briefActAttention ??= fx.attention;
                const ask = window.__briefActAttention.find((a) => a.key === "ask:review-agent");
                fx.attention = [{ ...ask, waitingsince: Date.now() }];
                await setAgents(fx.agents);
                const region = '[data-jarvis-brief-region="waiting"]';
                document.querySelector(region + ' [data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click();
                await until(() => document.querySelector(region + ' [data-jarvis-queue-age]') != null, 3000);
                await nap(400);
                const age = document.querySelector(region + ' [data-jarvis-queue-age]');
                const cs = age != null ? getComputedStyle(age) : null;
                const lineHeight = cs != null ? parseFloat(cs.lineHeight) : NaN;
                const fontSize = cs != null ? parseFloat(cs.fontSize) : NaN;
                const height = age?.getBoundingClientRect().height ?? 0;
                return {
                    size: ${JSON.stringify(size)},
                    text: flat(age),
                    height,
                    lineHeight,
                    oneLine: Number.isNaN(lineHeight) ? height < fontSize * 2 : Math.abs(height - lineHeight) < 1,
                    scrollWidth: age?.scrollWidth ?? 0,
                    clientWidth: age?.clientWidth ?? 0,
                    summary: flat(document.querySelector(region + ' [data-jarvis-brief-summary-detail]')),
                };
            `);
        const ageOk = (r) => r.text === "just now" && r.oneLine && r.scrollWidth <= r.clientWidth;
        const f14wide = await f14("1600x950");
        await h.shot("cdp-shots/brief-act-37-age-wide.png");
        steps.push({
            step: "37. F14: at 1600x950 the ask's age reads just now on one line, and the summary counts it as 1 ask",
            ok: ageOk(f14wide) && /(^| )1 ask( |$)/.test(f14wide.summary),
            detail: JSON.stringify(f14wide),
        });
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const f14narrow = await f14("1000x700");
        await h.shot("cdp-shots/brief-act-38-age-narrow.png");
        steps.push({
            step: "38. F14: at 1000x700 the ask's age cell does not wrap",
            ok: ageOk(f14narrow),
            detail: JSON.stringify(f14narrow),
        });
        await actRestoreAttention(h);
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });

        // 39. ten initiatives whose 8th and 9th by activity hold blocked work: both show without +N more, and the head
        // counts them. The window, the project pick and the filter are module state, so each starts from its default.
        await actFixture(h, "initiatives");
        await actFilter(h, "");
        const initRegion = '[data-jarvis-brief-region="initiatives"]';
        await h.ev(`document.querySelector('${initRegion} [data-jarvis-brief-more="less"]')?.click()`);
        await h.ev(`document.querySelector('${initRegion} [data-jarvis-initiative-project] [data-filter-option="all"][aria-pressed="false"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const f8 = await h.ev(`(() => {
            const sec = document.querySelector('${initRegion}');
            const t = (el) => (el?.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                rows: [...(sec?.querySelectorAll('[data-jarvis-brief-row="initiative"]') ?? [])].map(t),
                head: t(sec?.querySelector('button[aria-pressed]')),
                more: t(sec?.querySelector('[data-jarvis-brief-more]')),
            };
        })()`);
        await h.ev(`document.querySelector('${initRegion}')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-39-blocked-initiatives.png");
        const shownInit = (c) => f8.rows.some((r) => r.includes(`Window initiative ${c}`));
        steps.push({
            step: "39. F8: the initiatives holding blocked work (8th and 9th by activity) show without +N more, and the head leads with 2 blocked",
            ok:
                shownInit("H") &&
                shownInit("I") &&
                !shownInit("E") &&
                f8.rows.length === 6 &&
                f8.more === "+4 more" &&
                /2 blocked/.test(f8.head),
            detail: JSON.stringify(f8),
        });

        // 40. a filter matching nothing reads 0 of N on Waiting's summary, Initiatives' all chip and Shipped's; cleared,
        // the counts read as before
        const f16Counts = () =>
            h.ev(`(() => {
                const t = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim();
                const chip = (sel) => t(document.querySelector(sel)?.querySelector("span"));
                return {
                    waiting: t(document.querySelector('[data-jarvis-brief-region="waiting"] [data-jarvis-brief-summary-title]')),
                    initiatives: chip('${initRegion} [data-jarvis-initiative-project] [data-filter-option="all"]'),
                    shipped: chip('[data-jarvis-brief-region="behind"] [data-jarvis-run-kind] [data-filter-option="all"]'),
                };
            })()`);
        const f16before = await f16Counts();
        await actFilter(h, "zz-no-match");
        const f16during = await f16Counts();
        await h.shot("cdp-shots/brief-act-40-filtered-counts.png");
        await actFilter(h, "");
        const f16after = await f16Counts();
        const waitingN = /^(\d+) things? (?:is|are) waiting on you$/.exec(f16before.waiting)?.[1] ?? null;
        steps.push({
            step: "40. F16: a filter matching nothing reads 0 of N on the Waiting summary, the Initiatives all chip and the Shipped all chip; cleared, they read N again",
            ok:
                waitingN != null &&
                f16before.initiatives === "10" &&
                f16before.shipped === "3" &&
                f16during.waiting === `0 of ${waitingN} waiting match the filter` &&
                f16during.initiatives === "0 of 10" &&
                f16during.shipped === "0 of 3" &&
                JSON.stringify(f16after) === JSON.stringify(f16before),
            detail: JSON.stringify({ before: f16before, during: f16during, after: f16after }),
        });
        await actFixture(h, null);
        return steps;
    },
    async teardown(h, ctx) {
        await actRestoreConfig(h).catch(() => {});
        await actRestoreRoster(h).catch(() => {});
        await actRestoreAttention(h).catch(() => {});
        await releaseRpc(h, "AckRunCommand").catch(() => {});
        await releaseRpc(h, "CancelRunCommand").catch(() => {});
        for (const command of ["EffortGetCommand", "EffortMutateCommand", "SetDossierStatusCommand"]) {
            await releaseRpc(h, command).catch(() => {});
        }
        for (const effortoid of [ctx?.stagedoid, ctx?.archivedoid]) {
            if (effortoid) {
                await h.rpc("effortdelete", { effortoid }).catch((e) => {
                    console.error(`brief-act teardown: delete an initiative failed: ${e?.message ?? e}`);
                });
            }
        }
        await actFilter(h, "").catch(() => {});
        await actFixture(h, null).catch(() => {});
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
        if (ctx?.effortoid) {
            await h.rpc("effortdelete", { effortoid: ctx.effortoid }).catch((e) => {
                console.error(`brief-act teardown: delete the initiative failed: ${e?.message ?? e}`);
            });
        }
        // the channel, its run and the temp dir; it reloads, which also drops the review fixture's swapped roster
        if (ctx?.cwd != null) await teardownFixtureRun(h, ctx, "brief-act");
    },
};
