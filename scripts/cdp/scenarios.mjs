// Verification scenario manifest. Each entry: { name, surface, arrange(h)->ctx, assert(h,ctx)->steps,
// teardown(h,ctx) }. arrange/assert/teardown run in Node and drive the browser via h (see attach.mjs).
// Asserts are RPC-based (backend state) or DOM-based (h.ev) — NOT jotai atom reads (globalStore is not
// exposed on window). steps are { step, ok, detail }.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";

// --- exemplar 1: behavioral --------------------------------------------------------------------
// Drives the real CreateRun/AdvanceRun/CancelRun RPCs, which spawn REAL claude worker tabs. Blast
// radius is contained: the worker cwd is an isolated temp dir, spawned worker blocks are killed in
// teardown (deleteblock -> ShellProc.Close kills claude in ~1s), and the channel is deleted at the end.
const workerOf = (phase) => phase && phase.workerorefs && phase.workerorefs[0];

const runsLifecycle = {
    name: "runs-lifecycle",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-runs-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-runs", projectpath: cwd });
        return { cwd, workspaceId, channelId: ch.oid, workers: [] };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const getRun = async (runId) => {
            const res = await h.rpc("getchannels", null);
            const cc = (res.channels || []).find((x) => x.oid === ctx.channelId) || {};
            return (cc.runs || []).find((x) => x.id === runId);
        };
        const track = (oref) => {
            if (oref) ctx.workers.push(oref);
        };

        const created = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid: ctx.workspaceId,
            goal: "spawn-test only: do nothing, make no file changes, stop immediately",
        });
        const run = created.run;
        const runId = run.id;
        track(workerOf(run.phases[0]));
        rec(
            "1. CreateRun -> 3 phases, p0 running + worker, status planning",
            run.phases.length === 3 && run.phases[0].state === "running" && !!workerOf(run.phases[0]) && run.status === "planning",
            JSON.stringify({ status: run.status, states: run.phases.map((p) => p.state) })
        );

        await h.rpc("advancerun", { channelid: ctx.channelId, runid: runId, phaseidx: 0, action: "complete", artifacts: ["docs/spec.md"] });
        const r2 = await getRun(runId);
        track(workerOf(r2.phases[1]));
        rec(
            "2. Advance complete p0 -> p1 running + worker, status planning",
            r2.phases[0].state === "done" && r2.phases[1].state === "running" && !!workerOf(r2.phases[1]) && r2.status === "planning",
            JSON.stringify({ status: r2.status, states: r2.phases.map((p) => p.state) })
        );

        await h.rpc("advancerun", { channelid: ctx.channelId, runid: runId, phaseidx: 1, action: "complete", artifacts: ["docs/plan.md"] });
        const r3 = await getRun(runId);
        rec(
            "3. Advance complete p1 -> awaiting-review, p2 pending, NO new worker",
            r3.phases[1].state === "done" && r3.phases[2].state === "pending" && !workerOf(r3.phases[2]) && r3.status === "awaiting-review",
            JSON.stringify({ status: r3.status, states: r3.phases.map((p) => p.state) })
        );

        await h.rpc("advancerun", { channelid: ctx.channelId, runid: runId, action: "approve" });
        const r4 = await getRun(runId);
        track(workerOf(r4.phases[2]));
        rec(
            "4. Approve gate -> p2 running + worker, status executing",
            r4.phases[2].state === "running" && !!workerOf(r4.phases[2]) && r4.status === "executing",
            JSON.stringify({ status: r4.status, states: r4.phases.map((p) => p.state) })
        );

        await h.rpc("cancelrun", { channelid: ctx.channelId, runid: runId });
        const r5 = await getRun(runId);
        rec(
            "5. Cancel -> status cancelled, p2 skipped",
            r5.status === "cancelled" && r5.phases[2].state === "skipped",
            JSON.stringify({ status: r5.status, states: r5.phases.map((p) => p.state) })
        );

        return steps;
    },
    async teardown(h, ctx) {
        for (const oref of ctx.workers) {
            try {
                const tab = await h.rpc("gettab", oref.slice(4));
                const bid = tab && tab.blockids && tab.blockids[0];
                if (bid) await h.rpc("deleteblock", { blockid: bid });
            } catch {
                // best-effort cleanup
            }
        }
        try {
            await h.rpc("deletechannel", { channelid: ctx.channelId });
        } catch {
            // best-effort cleanup
        }
        try {
            rmSync(ctx.cwd, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    },
};

// --- exemplar 2: visual + DOM ------------------------------------------------------------------
// Navigate each key surface, screenshot it, and assert (a) the active nav label matches and (b) the
// content region rendered non-empty text — which catches a surface that blanks out on render. No
// arrange needed; a populated-roster visual still relies on the manual inject-live-agents path.
// Channels/Graph/Tasks merged into Jarvis and have no nav button left, so listing one here would make
// h.goto throw before any step is recorded.
const SMOKE_SURFACES = ["cockpit", "jarvis", "radar", "usage", "memory", "files", "settings"];

const surfaceSmoke = {
    name: "surface-smoke",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        for (const surface of SMOKE_SURFACES) {
            await h.goto(surface);
            const active = await h.activeSurfaceLabel();
            const contentLen = await h.ev(
                `(() => { const n=document.querySelector('nav'); const c=n&&n.nextElementSibling; return c?(c.textContent||'').trim().length:0; })()`
            );
            const expected = SURFACE_LABEL[surface];
            steps.push({
                step: `goto ${surface} -> active nav "${expected}", content non-empty`,
                ok: active === expected && contentLen > 0,
                detail: `active=${active} contentLen=${contentLen}`,
            });
            await h.shot(`cdp-shots/surface-${surface}.png`);
        }
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

// --- shared jarvis drivers ---------------------------------------------------------------------
// The Stage's ask box exists only once a subject is selected, and only the record/thread faces are an ask
// box (a channel subject gets the Launch composer instead). "+ Thread" is the deterministic way in: the
// active subject is session state a prior scenario may have left on a channel or a dev fixture.
const newThread = (h) =>
    h.ev(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '+ Thread');
        if (!b) return false;
        b.click();
        return true;
    })()`);

// Type a question into the Stage's ask box and submit it. The placeholder varies by subject kind
// ("Ask Jarvis anything…" for a thread, "Ask Jarvis about this record…"), so match the stable prefix.
const askJarvis = (h, text) =>
    h.ev(`(() => {
        const input = document.querySelector('input[placeholder^="Ask Jarvis"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
    })()`);

// --- jarvis: render every surface state via the dev fixture bar --------------------------------
// The bar is DEV-only and clickable (globalStore is not on window, so we drive by button text like nav).
// Each fixture is screenshotted; we assert the conversation region rendered non-empty text.
const jarvisStates = {
    name: "jarvis-states",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        const states = ["empty", "active", "grounded", "working", "weak", "notfound", "stale", "contextual", "narrow"];
        for (const s of states) {
            const clicked = await h.ev(`(() => {
                const b = [...document.querySelectorAll('[data-testid="jarvis-fixture-bar"] button')]
                    .find((x) => x.getAttribute('data-fixture') === ${JSON.stringify(s)});
                if (!b) return false;
                b.click();
                return true;
            })()`);
            // small settle for the width-reveal animation before shooting
            await h.ev("new Promise((r) => setTimeout(r, 300))");
            const contentLen = await h.ev(
                `(() => { const n=document.querySelector('nav'); const c=n&&n.nextElementSibling; return c?(c.textContent||'').trim().length:0; })()`
            );
            steps.push({
                step: `jarvis fixture "${s}" -> bar present + content non-empty`,
                ok: clicked === true && contentLen > 0,
                detail: `clicked=${clicked} contentLen=${contentLen}`,
            });
            await h.shot(`cdp-shots/jarvis-${s}.png`);
        }
        // Plan 4: citation/card click is wired to openORef (real nav for channel/run/agent; fake fixture
        // ids no-op cleanly). Assert the click path runs without throwing.
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('[data-fixture]')].find((x) => x.getAttribute('data-fixture') === 'grounded');
            if (b) b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");
        const clickOk = await h.ev(`(() => {
            const card = document.querySelector('button[class*="rounded-[10px]"]');
            const cite = [...document.querySelectorAll('p button')].find((x) => /^\\d+$/.test((x.textContent||'').trim()));
            try { card && card.click(); cite && cite.click(); return true; } catch (e) { return String(e); }
        })()`);
        steps.push({ step: "citation/card click runs without throwing", ok: clickOk === true, detail: String(clickOk) });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- jarvis fleet: the fleet manager on the merged surface -------------------------------------
// Create a channel, select it in the Subjects column, and assert the Stage header's autonomy ladder plus
// the context rail's Fleet section render. No worker is dispatched — the roster's empty-state is a valid
// render assertion and keeps the run light. Channel + temp dir are cleaned up in teardown (mirrors
// runs-lifecycle).
//
// This also covers where the @jarvis summary handoff lands: pendingFleetSummaryAtom drives runSummary into
// the same Fleet section as its own "Summarize the fleet" button, so asserting that button is present is
// asserting the handoff has a home. The reroute's decision (dispatch vs summary) is covered by
// channelmessages.test.ts; the atom hop itself has no keyboard entry point to drive from here.
const jarvisFleet = {
    name: "jarvis-fleet",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-fleet-"));
        const ch = await h.rpc("createchannel", { name: "verify-fleet", projectpath: cwd });
        return { cwd, channelId: ch.oid };
    },
    async assert(h) {
        const steps = [];
        // channelsAtom is a loadChannels snapshot with no refresh on surface mount, so a channel created
        // out-of-band over RPC is invisible to an already-running app. Reload to re-fetch the list (same
        // pattern as jarvis-proactive).
        await h.ev("location.reload()");
        await h.ev("new Promise((r) => setTimeout(r, 2500))");
        await h.goto("jarvis");
        // stageRailOpenAtom is persisted, so a prior run may have left the rail collapsed to its 44px
        // strip. Expand it if the strip is showing; the sections only exist in the DOM while open.
        await h.ev(`(() => {
            const b = document.querySelector('button[aria-label="Stage context"]');
            if (b) b.click();
            return true;
        })()`);
        // select the channel by its row label in the Subjects column (same drive-by-text pattern as nav).
        // A row's textContent is the kind glyph immediately followed by the label ("#verify-fleet"), so
        // strip the leading mark before comparing.
        const selected = await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')]
                .find((x) => (x.textContent || '').trim().replace(/^[#▤~]/, '') === 'verify-fleet');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))"); // settle selectSubject + roster derive
        // innerText reflects CSS text-transform and the ladder's eyebrow is uppercased, so compare the
        // header case-insensitively (same caveat as jarvis-proactive).
        const rendered = await h.ev(`(() => {
            const t = document.body.innerText || '';
            const upper = t.toUpperCase();
            return {
                autonomy: upper.includes('AUTONOMY') && upper.includes('CONCIERGE') && upper.includes('DELEGATOR'),
                roster: t.includes('No workers dispatched') && t.includes('working'),
                summarize: t.includes('Summarize the fleet'),
            };
        })()`);
        steps.push({
            step: `select the channel subject -> autonomy ladder + Fleet roster + summary button render`,
            ok:
                selected === true &&
                rendered.autonomy === true &&
                rendered.roster === true &&
                rendered.summarize === true,
            detail: `clicked=${selected} ${JSON.stringify(rendered)}`,
        });
        await h.shot("cdp-shots/jarvis-fleet.png");
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit"); // leave the app where a human expects it
        try {
            await h.rpc("deletechannel", { channelid: ctx.channelId });
        } catch {
            // best-effort cleanup
        }
        try {
            rmSync(ctx.cwd, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    },
};

// --- jarvis ask: Ctrl+P "Ask Jarvis" lead group hands a question off to the Jarvis surface (Plan 4) ---
// Open the palette via its global chord (Ctrl:p; bindings.ts id "palette", no `when` guard). The
// dispatcher listens on window capture, so a keydown dispatched on document reaches it. Type a goal,
// assert the Ask lead row renders, fire it, then assert the active surface is Jarvis and the typed
// question shows as a user turn. We do NOT assert the streamed answer (live backend, timing-sensitive).
const jarvisAsk = {
    name: "jarvis-ask",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("cockpit");
        const opened = await h.ev(`(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 250))");
        const typed = await h.ev(`(() => {
            const inp = document.querySelector('input[placeholder^="Search"]');
            if (!inp) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, 'why did we drop worktrees');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 250))");
        const askRow = await h.ev(`(() => (document.body.innerText || '').includes('Ask Jarvis'))()`);
        steps.push({
            step: "type goal -> Ask Jarvis lead row present",
            ok: opened === true && typed === true && askRow === true,
            detail: `typed=${typed} askRow=${askRow}`,
        });
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Ask Jarvis'));
            if (b) b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        const activeLabel = await h.activeSurfaceLabel();
        const userTurn = await h.ev(`(() => (document.body.innerText || '').includes('why did we drop worktrees'))()`);
        steps.push({
            step: "fire Ask row -> Jarvis surface shows the question as a user turn",
            ok: activeLabel === SURFACE_LABEL.jarvis && userTurn === true,
            detail: JSON.stringify({ activeLabel, userTurn }),
        });
        await h.shot("cdp-shots/jarvis-ask.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- jarvis contextual entry: "Ask Jarvis" on a Memory detail attaches the source + pre-fills prompt ----
// Memory data is loaded from the real memory store (reliably non-empty; see surface-smoke), so this needs
// no channel/run setup. Open the memory surface (default List view), select the first note, click
// "Ask Jarvis", and assert the Jarvis surface shows the "This memory" attached chip + the suggested prompt.
// This is the durable contextual-entry live check (Task 3); the builders themselves are unit-tested.
const jarvisContextual = {
    name: "jarvis-contextual",
    surface: "memory",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("memory");
        const selected = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('button')].filter((b) => (b.className || '').includes('rounded-[11px]'));
            if (rows.length === 0) return false;
            rows[0].click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const asked = await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Ask Jarvis');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const activeLabel = await h.activeSurfaceLabel();
        const landed = await h.ev(`(() => {
            const body = document.body.innerText || '';
            const draft = (document.querySelector('input[placeholder^="Ask Jarvis"]') || {}).value || '';
            return { chip: body.includes('This memory'), draft: draft.includes('Recall decisions') };
        })()`);
        steps.push({
            step: "select memory note -> Ask Jarvis -> Jarvis surface + attached chip + suggested prompt",
            ok:
                selected === true &&
                asked === true &&
                activeLabel === SURFACE_LABEL.jarvis &&
                landed.chip === true &&
                landed.draft === true,
            detail: JSON.stringify({ selected, asked, activeLabel, ...landed }),
        });
        await h.shot("cdp-shots/jarvis-contextual.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- jarvis ambient: engine D's real task-tag chips render on real rows (J1) -------------------------
// Ambient attribution renders a chip per attributed dossier, titled "<label> · <bucket> confidence ·
// <state>" (ambientviews.tagTitle). This asserts the *join*: D's dossier->Run edges reaching rows the
// user actually sees. It is only meaningful against a profile whose wstore holds the runs the vault's
// dossiers reference — with an unrelated wstore the correct result is zero chips everywhere, which
// proves nothing (see docs/jarvis-second-brain-open-issues.md J1).
// jarvis replaces channels here: the run body that carries a run's ambient chips (runbody AmbientTags) now
// renders in the Stage.
const AMBIENT_SURFACES = ["cockpit", "jarvis", "radar", "memory"];

const jarvisAmbient = {
    name: "jarvis-ambient",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const counts = {};
        let total = 0;
        for (const surface of AMBIENT_SURFACES) {
            await h.goto(surface);
            if (surface === "jarvis") {
                // the Stage starts with no subject, so a run body (and its chips) only exists once a channel
                // is selected. "#" marks a channel row in the Subjects column; the old Channels surface got
                // this for free from loadChannels' auto-select.
                await h.ev(`(() => {
                    const b = [...document.querySelectorAll('button')]
                        .find((x) => (x.textContent || '').trim().startsWith('#'));
                    if (b) b.click();
                    return true;
                })()`);
                await h.ev("new Promise((r) => setTimeout(r, 900))");
            }
            const seen = await h.ev(`(() => {
                const chips = [...document.querySelectorAll('span[title*=" confidence \\u00b7 "]')];
                const dashed = chips.filter((e) => e.className.includes("border-dashed")).length;
                const decisions = [...document.querySelectorAll("div")].filter(
                    (e) => e.textContent.trim() === "Relevant past decisions"
                ).length;
                return { chips: chips.length, dashed, decisions, labels: chips.slice(0, 4).map((e) => e.title) };
            })()`);
            counts[surface] = seen;
            total += seen.chips;
            await h.shot(`cdp-shots/ambient-${surface}.png`);
        }
        steps.push({
            step: "an attributed row renders >=1 real ambient tag chip",
            ok: total > 0,
            detail: JSON.stringify(counts),
        });
        // Weak/informing edges must recede rather than read as canonical — D emits 0.3 layer-3 edges on
        // this corpus, so a run with only structural attribution should carry a dashed chip.
        const dashedAnywhere = Object.values(counts).some((c) => c.dashed > 0);
        steps.push({
            step: "informing (weak) edges render dashed, not solid",
            ok: total === 0 || dashedAnywhere,
            detail: `dashed by surface: ${JSON.stringify(
                Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.dashed]))
            )}`,
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- jarvis multi-turn + persistence: ask a question, reload -> conversation persists in the rail (Plan F) --
const jarvisMultiturn = {
    name: "jarvis-multiturn",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        const threaded = await newThread(h);
        await h.ev("new Promise((resolve) => setTimeout(resolve, 400))");
        const asked = await askJarvis(h, "what changed in the worktree work");
        await h.ev("new Promise((resolve) => setTimeout(resolve, 4000))");
        const firstTurn = await h.ev(
            `(() => (document.body.innerText || '').includes('what changed in the worktree work'))()`
        );
        steps.push({
            step: "first question renders as a user turn",
            ok: threaded === true && asked === true && firstTurn === true,
            detail: `threaded=${threaded} asked=${asked} firstTurn=${firstTurn}`,
        });

        await h.ev("location.reload()");
        await h.ev("new Promise((resolve) => setTimeout(resolve, 2500))");
        await h.goto("jarvis");
        const persisted = await h.ev(
            `(() => (document.body.innerText || '').includes('what changed in the worktree work'))()`
        );
        steps.push({
            step: "conversation persists across reload in the history rail",
            ok: persisted === true,
            detail: `persisted=${persisted}`,
        });

        await h.shot("cdp-shots/jarvis-multiturn.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- jarvis vault recall: a dispatched Run captures a dossier; recall traverses the vault (sub-project C) --
// arrange dispatches a REAL Run via createrun — which now (Task 1 hook) writes a dossier into the Wave Vault
// carrying the run's ticket + objective and a [[run-<oid>]] reference, committed before createrun returns.
// We then ask Jarvis a question matching that ticket and assert recall surfaced a grounding card (dossier or
// run) rather than the empty-vault notfound state. Grounding cards stream before synthesis, so the assert
// does not depend on a live claude synthesis completing. The run goal keeps the spawned worker inert (like
// runs-lifecycle); worker block + run + channel + temp dir are cleaned up in teardown.
const VAULT_TICKET = "ZZZ-4242";
const VAULT_GOAL = `${VAULT_TICKET} spawn-test only: do nothing, make no file changes, stop immediately`;

const jarvisVaultRecall = {
    name: "jarvis-vault-recall",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-vault-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-vault", projectpath: cwd });
        const created = await h.rpc("createrun", { channelid: ch.oid, workspaceid: workspaceId, goal: VAULT_GOAL });
        const run = created.run;
        const worker = run.phases && run.phases[0] && run.phases[0].workerorefs && run.phases[0].workerorefs[0];
        return { cwd, channelId: ch.oid, runId: run.id, workers: worker ? [worker] : [] };
    },
    async assert(h, ctx) {
        const steps = [];
        await h.goto("jarvis");
        await newThread(h);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const asked = await askJarvis(h, `what is the ${VAULT_TICKET} spawn test about`);
        // grounding cards stream before synthesis; poll briefly for a non-notfound grounded answer.
        let grounded = { cards: 0, notfound: false };
        for (let i = 0; i < 20; i++) {
            await h.ev("new Promise((r) => setTimeout(r, 500))");
            grounded = await h.ev(`(() => {
                const body = document.body.innerText || '';
                const cards = document.querySelectorAll('button[class*="rounded-[10px]"]').length;
                return { cards, notfound: body.includes('No Wave source in scope references this') };
            })()`);
            if (grounded.cards > 0) break;
        }
        steps.push({
            step: "ask matching question -> >=1 grounding card, not the empty-vault notfound state",
            ok: asked === true && grounded.cards > 0 && grounded.notfound === false,
            detail: JSON.stringify(grounded),
        });
        await h.shot("cdp-shots/jarvis-vault-recall.png");
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit"); // leave the app where a human expects it
        try {
            await h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId });
        } catch {
            // best-effort cleanup
        }
        for (const oref of ctx.workers) {
            try {
                const tab = await h.rpc("gettab", oref.slice(4));
                const bid = tab && tab.blockids && tab.blockids[0];
                if (bid) await h.rpc("deleteblock", { blockid: bid });
            } catch {
                // best-effort cleanup
            }
        }
        try {
            await h.rpc("deletechannel", { channelid: ctx.channelId });
        } catch {
            // best-effort cleanup
        }
        try {
            rmSync(ctx.cwd, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    },
};

// --- jarvis continuity resume: a completed Run writes the dossier's completion narrative (sub-project E) --
// Builds on jarvis-vault-recall's C leg. arrange dispatches a REAL quick-mode Run (createrun -> C writes the
// dossier + [[run-<oid>]] ref) then advances the single phase to done via advancerun complete — E's
// AdvanceRunCommand hook then writes the dossier's "where it stands" completion narrative + flips its status
// to completed, off-band. A bare complete carries no end commit / blockers / decisions, so E takes the terse
// deterministic path (no model call), keeping this scenario fast and deterministic. We confirm the run
// reached done (E's trigger) and that asking Jarvis where the ticket landed surfaces a grounding card rather
// than the empty-vault notfound state (recall traverses the now-completed dossier). Worker block + channel +
// temp dir cleaned up in teardown.
const CONTINUITY_TICKET = "ZZZ-7373";
const CONTINUITY_GOAL = `${CONTINUITY_TICKET} spawn-test only: do nothing, make no file changes, stop immediately`;

const jarvisContinuityResume = {
    name: "jarvis-continuity-resume",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-continuity-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-continuity", projectpath: cwd });
        const created = await h.rpc("createrun", { channelid: ch.oid, workspaceid: workspaceId, goal: CONTINUITY_GOAL, mode: "quick" });
        const run = created.run;
        const worker = run.phases && run.phases[0] && run.phases[0].workerorefs && run.phases[0].workerorefs[0];
        // advance the single quick phase to done -> E's rest-boundary hook writes the completion narrative.
        await h.rpc("advancerun", { channelid: ch.oid, runid: run.id, phaseidx: 0, action: "complete" });
        return { cwd, channelId: ch.oid, runId: run.id, workers: worker ? [worker] : [] };
    },
    async assert(h, ctx) {
        const steps = [];
        // E's trigger precondition: the run actually reached the done rest state.
        const res = await h.rpc("getchannels", null);
        const cc = (res.channels || []).find((x) => x.oid === ctx.channelId) || {};
        const doneRun = (cc.runs || []).find((x) => x.id === ctx.runId) || {};
        steps.push({
            step: "run advanced to done (E's rest-boundary trigger)",
            ok: doneRun.status === "done",
            detail: JSON.stringify({ status: doneRun.status }),
        });

        await h.goto("jarvis");
        await newThread(h);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const asked = await askJarvis(h, `where did the ${CONTINUITY_TICKET} task land`);
        // grounding cards stream before synthesis; poll briefly for a non-notfound grounded answer.
        let grounded = { cards: 0, notfound: false };
        for (let i = 0; i < 20; i++) {
            await h.ev("new Promise((r) => setTimeout(r, 500))");
            grounded = await h.ev(`(() => {
                const body = document.body.innerText || '';
                const cards = document.querySelectorAll('button[class*="rounded-[10px]"]').length;
                return { cards, notfound: body.includes('No Wave source in scope references this') };
            })()`);
            if (grounded.cards > 0) break;
        }
        steps.push({
            step: "ask where the completed task landed -> >=1 grounding card, not notfound",
            ok: asked === true && grounded.cards > 0 && grounded.notfound === false,
            detail: JSON.stringify(grounded),
        });
        await h.shot("cdp-shots/jarvis-continuity-resume.png");
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit"); // leave the app where a human expects it
        for (const oref of ctx.workers) {
            try {
                const tab = await h.rpc("gettab", oref.slice(4));
                const bid = tab && tab.blockids && tab.blockids[0];
                if (bid) await h.rpc("deleteblock", { blockid: bid });
            } catch {
                // best-effort cleanup
            }
        }
        try {
            await h.rpc("deletechannel", { channelid: ctx.channelId });
        } catch {
            // best-effort cleanup
        }
        try {
            rmSync(ctx.cwd, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    },
};

// --- jarvis proactive: the S3 "related prior work" card renders on a run, and dismissal persists ------
// The eval pipeline (cosine pre-filter -> model judge) is covered by pkg/jarvisproactive's Go tests, so
// this scenario needs neither live embeddings nor a model: arrange dispatches a REAL quick-mode run and
// then writes a hit suggestion straight onto run.Meta via setmeta — the same wstore.UpdateObjectMeta path
// the backend hook writes through. What it proves is the delivery + render + dismiss legs: the card shows
// on the run body, the × clears it, and the dismissal is persisted server-side (so it stays gone across a
// reload — the "flag present => no card" half is unit-tested in proactive.test.ts).
const PROACTIVE_GOAL = "spawn-test only: do nothing, make no file changes, stop immediately";
const PROACTIVE_TITLE = "Drop-oldest on overflow";
const PROACTIVE_SUGGESTION = {
    status: "hit",
    nodeId: "dec-demo",
    sourceType: "decision",
    title: PROACTIVE_TITLE,
    snippet: "chose drop-oldest to bound memory",
    why: "Related to this run",
};

const jarvisProactive = {
    name: "jarvis-proactive",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-proactive-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-proactive", projectpath: cwd });
        const created = await h.rpc("createrun", {
            channelid: ch.oid,
            workspaceid: workspaceId,
            goal: PROACTIVE_GOAL,
            mode: "quick",
        });
        const run = created.run;
        const worker = run.phases && run.phases[0] && run.phases[0].workerorefs && run.phases[0].workerorefs[0];
        await h.rpc("setmeta", { oref: `run:${run.id}`, meta: { "jarvis:proactive": PROACTIVE_SUGGESTION } });
        return { cwd, channelId: ch.oid, runId: run.id, workers: worker ? [worker] : [] };
    },
    async assert(h, ctx) {
        const steps = [];
        const runMeta = async () => {
            const rtn = await h.rpc("getchannelruns", { channelid: ctx.channelId });
            const r = (rtn.runs || []).find((x) => x.id === ctx.runId) || {};
            return r.meta || {};
        };
        // innerText reflects CSS text-transform, and the card's eyebrow is uppercased — compare case-insensitively.
        const cardState = () =>
            h.ev(`(() => {
                const body = (document.body.innerText || '').toUpperCase();
                return {
                    label: body.includes('RELATED PRIOR WORK'),
                    title: body.includes(${JSON.stringify(PROACTIVE_TITLE.toUpperCase())}),
                    btn: !!document.querySelector('button[aria-label="Dismiss suggestion"]'),
                };
            })()`);

        // The Subjects column renders a snapshot refreshed by loadChannels(), so a channel created
        // out-of-band over RPC is invisible to an already-running app. Reload to re-fetch the list (same
        // pattern as jarvis-multiturn), then select the scenario's channel; the Stage auto-resolves its
        // single run.
        await h.ev("location.reload()");
        await h.ev("new Promise((r) => setTimeout(r, 2500))");
        await h.goto("jarvis");
        const picked = await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')]
                .find((x) => (x.textContent || '').includes('verify-proactive'));
            if (!b) return false;
            b.click();
            return true;
        })()`);
        // the run strip + body mount after the channel's row-backed streams load; poll briefly.
        let shown = { label: false, title: false, btn: false };
        for (let i = 0; i < 20; i++) {
            await h.ev("new Promise((r) => setTimeout(r, 500))");
            shown = await cardState();
            if (shown.label && shown.title) break;
        }
        const rendered = picked === true && shown.label && shown.title && shown.btn;
        steps.push({
            step: "proactive card renders on the run body (label + suggestion title)",
            ok: rendered,
            detail: JSON.stringify({ picked, ...shown }),
        });
        await h.shot("cdp-shots/jarvis-proactive.png");

        // dismiss -> the card leaves the DOM immediately (optimistic atom). Requires the button to have been
        // there: without this the step would pass vacuously whenever the card never rendered.
        const clicked = await h.ev(`(() => {
            const b = document.querySelector('button[aria-label="Dismiss suggestion"]');
            if (b) b.click();
            return !!b;
        })()`);
        let gone = { label: true, title: true, btn: true };
        for (let i = 0; i < 10; i++) {
            await h.ev("new Promise((r) => setTimeout(r, 300))");
            gone = await cardState();
            if (!gone.label && !gone.btn) break;
        }
        steps.push({
            step: "dismiss (×) removes the card from the run body",
            ok: clicked === true && !gone.label && !gone.btn,
            detail: JSON.stringify({ clicked, ...gone }),
        });

        // ...and the dismissal is persisted server-side, so it stays gone across a reload
        let persisted;
        for (let i = 0; i < 10; i++) {
            persisted = await runMeta();
            if (persisted["jarvis:proactive:dismissed"] === true) break;
            await h.ev("new Promise((r) => setTimeout(r, 300))");
        }
        steps.push({
            step: "dismissal persisted to run.meta (survives reload)",
            ok: persisted["jarvis:proactive:dismissed"] === true,
            detail: JSON.stringify(persisted),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit"); // leave the app where a human expects it
        try {
            await h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId });
        } catch {
            // best-effort cleanup
        }
        for (const oref of ctx.workers) {
            try {
                const tab = await h.rpc("gettab", oref.slice(4));
                const bid = tab && tab.blockids && tab.blockids[0];
                if (bid) await h.rpc("deleteblock", { blockid: bid });
            } catch {
                // best-effort cleanup
            }
        }
        try {
            await h.rpc("deletechannel", { channelid: ctx.channelId });
        } catch {
            // best-effort cleanup
        }
        try {
            rmSync(ctx.cwd, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    },
};

// --- jarvis drawer: the ⚙ drawer's scope + dismissal, and Needs-you with no subject ------------
// Covers three state-machine defects that the unit suite structurally cannot see, because each one lives
// in the hop between atoms rather than in any pure function:
//   - the rail is mounted with no subject, so Needs you is drawn on a fresh boot (its stated contract is
//     "always drawn, never filtered" — an ask that waits on a click is not an attention channel);
//   - selecting a non-channel subject closes the drawer, which the header has no trigger to close there;
//   - the scope toggle is re-derived per open instead of latching to global once a channel goes away,
//     which used to make Save write global defaults for every project while reading as "This project".
// Case-insensitive: the section heading is Tailwind `uppercase`, and innerText applies text-transform,
// so the rail reads "NEEDS YOU" on screen even though the source says "Needs you".
const HAS_NEEDS = "/needs you/i.test(document.body.innerText || '')";
const jarvisDrawer = {
    name: "jarvis-drawer",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-drawer-"));
        const ch = await h.rpc("createchannel", { name: "verify-drawer", projectpath: cwd });
        return { cwd, channelId: ch.oid };
    },
    // the channel is found by name in the Subjects column rather than by ctx.channelId: selecting a
    // subject is a click, and clicking what the user would click is the point of the scenario.
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        // channelsAtom is a load-once snapshot, so a channel created over RPC needs a reload to appear
        // (same pattern as jarvis-fleet). The reload also gives us the fresh-boot, no-subject state.
        await h.ev("location.reload()");
        await settle(2500);
        await h.goto("jarvis");
        await settle(400);

        // 1. no subject selected: the rail must still be mounted. Before the fix JarvisSurface mounted
        // StageRail only when activeSubjectAtom was non-null, and that atom is not persisted.
        // The aria-label sits on the <aside> itself; the matching *button* only exists in the collapsed
        // strip, so asserting on the aside covers both states. Width, because a force-collapsed rail is
        // still in the DOM at zero width.
        const fresh = await h.ev(`(() => {
            const rail = document.querySelector('aside[aria-label="Stage context"]');
            return {
                rail: rail != null,
                width: rail ? rail.getBoundingClientRect().width : 0,
                needs: ${HAS_NEEDS},
            };
        })()`);
        rec(
            "1. fresh boot, no subject -> the context rail is mounted",
            fresh.rail === true && fresh.width > 0,
            JSON.stringify(fresh)
        );
        await h.shot("cdp-shots/jarvis-drawer-nosubject.png");

        // expand the rail if a prior run left it on its 44px strip (stageRailOpenAtom is persisted).
        await h.ev(`(() => {
            const b = document.querySelector('button[aria-label="Stage context"]');
            if (b) b.click();
            return true;
        })()`);
        await settle(300);
        const needsDrawn = await h.ev(`(() => ${HAS_NEEDS})()`);
        rec("2. Needs you renders before any subject is selected", needsDrawn === true, `needs=${needsDrawn}`);

        const selectChannel = () =>
            h.ev(`(() => {
                const b = [...document.querySelectorAll('button')]
                    .find((x) => (x.textContent || '').trim().replace(/^[#▤~]/, '') === 'verify-drawer');
                if (!b) return false;
                b.click();
                return true;
            })()`);
        const openGear = () =>
            h.ev(`(() => {
                const b = document.querySelector('button[title^="Channel profile"]');
                if (!b) return false;
                b.click();
                return true;
            })()`);
        // the drawer's Save button is the scope tell: "Save" on project scope, "Save global defaults" on
        // global. Reading the label is how a user would tell the two apart, so assert what they see.
        const drawerState = () =>
            h.ev(`(() => {
                const save = [...document.querySelectorAll('button')]
                    .map((x) => (x.textContent || '').trim())
                    .find((x) => x === 'Save' || x === 'Save global defaults' || x === 'Saving…');
                return {
                    gear: !!document.querySelector('button[title^="Channel profile"]'),
                    open: save != null,
                    save: save || null,
                    needs: ${HAS_NEEDS},
                };
            })()`);

        const picked = await selectChannel();
        await settle(900);
        const opened = await openGear();
        await settle(700);
        const onChannel = await drawerState();
        rec(
            "3. gear on a channel -> drawer opens on project scope",
            picked === true && opened === true && onChannel.open === true && onChannel.save === "Save",
            JSON.stringify(onChannel)
        );
        await h.shot("cdp-shots/jarvis-drawer-channel.png");

        // 4. move to a non-channel subject. The dev fixture bar's buttons select a conversation subject,
        // which is a kind with no ⚙ in the header — exactly the state the drawer used to be stranded in.
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('[data-fixture]')].find((x) => x.getAttribute('data-fixture') === 'grounded');
            if (b) b.click();
            return true;
        })()`);
        await settle(700);
        const offChannel = await drawerState();
        rec(
            "4. switch to a thread -> drawer closes, gear gone, Needs you back",
            offChannel.gear === false && offChannel.open === false && offChannel.needs === true,
            JSON.stringify(offChannel)
        );
        await h.shot("cdp-shots/jarvis-drawer-offchannel.png");

        // 5. back to the channel: scope must be project again. It used to latch to global on the visit
        // above and stay there, so Save wrote global defaults while the user believed otherwise.
        await selectChannel();
        await settle(900);
        await openGear();
        await settle(700);
        const back = await drawerState();
        rec(
            "5. back on the channel -> scope is project again, not latched to global",
            back.open === true && back.save === "Save",
            JSON.stringify(back)
        );

        // 6. Esc dismisses the drawer, as it does the graph peek.
        await h.ev(`(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return true;
        })()`);
        await settle(500);
        const afterEsc = await drawerState();
        rec("6. Esc closes the drawer", afterEsc.open === false, JSON.stringify(afterEsc));
        await h.shot("cdp-shots/jarvis-drawer-esc.png");
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        try {
            await h.rpc("deletechannel", { channelid: ctx.channelId });
        } catch {
            // best-effort cleanup
        }
        try {
            rmSync(ctx.cwd, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    },
};

export const SCENARIOS = [
    runsLifecycle,
    surfaceSmoke,
    jarvisStates,
    jarvisFleet,
    jarvisAsk,
    jarvisContextual,
    jarvisAmbient,
    jarvisMultiturn,
    jarvisVaultRecall,
    jarvisContinuityResume,
    jarvisProactive,
    jarvisDrawer,
];
