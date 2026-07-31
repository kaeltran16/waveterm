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
// Create a channel, select it in the Subjects column, and assert the Stage header's autonomy chip plus
// the context rail's Fleet section render. No worker is dispatched — the roster's empty-state is a valid
// render assertion and keeps the run light. Channel + temp dir are cleaned up in teardown (mirrors
// runs-lifecycle). The autonomy half also carries this control's own regression check: the chip's left edge
// must not move when Delegator is selected, and Escape must dismiss the panel without leaving the surface.
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
        // The autonomy control is a fixed-width chip now, so the header carries only the current tier; the
        // three rungs live in its popover. Assert the chip, then open it and assert the ladder.
        const rendered = await h.ev(`(() => {
            const t = document.body.innerText || '';
            const chip = document.querySelector('[data-jarvis-autonomy="chip"]');
            return {
                chip: chip ? chip.innerText.replace(/\\n/g, ' ').trim() : null,
                panelClosed: document.querySelector('[data-jarvis-autonomy="panel"]') == null,
                roster: t.includes('No workers dispatched') && t.includes('working'),
                summarize: t.includes('Summarize the fleet'),
            };
        })()`);
        steps.push({
            step: `select the channel subject -> autonomy chip + Fleet roster + summary button render`,
            ok:
                selected === true &&
                /Concierge/.test(rendered.chip ?? "") &&
                rendered.panelClosed === true &&
                rendered.roster === true &&
                rendered.summarize === true,
            detail: `clicked=${selected} ${JSON.stringify(rendered)}`,
        });
        await h.shot("cdp-shots/jarvis-fleet.png");

        // open the chip: the ladder, its blurbs and (at Delegator) the dispatch mode are all in the panel
        const opened = await h.ev(`(() => {
            const chip = document.querySelector('[data-jarvis-autonomy="chip"]');
            if (!chip) return null;
            chip.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 450))"); // PopoverReveal enter
        const panel = await h.ev(`(() => {
            const p = document.querySelector('[data-jarvis-autonomy="panel"]');
            if (!p) return null;
            const t = p.innerText || '';
            const upper = t.toUpperCase();
            return {
                caption: upper.includes('AUTONOMY'),
                rungs: t.includes('Concierge') && t.includes('Gatekeeper') && t.includes('Delegator'),
                blurb: t.includes('watches and narrates'),
                modesHidden: !t.includes('fanout'),
            };
        })()`);
        steps.push({
            step: `chip opens -> three rungs with blurbs, dispatch mode absent below Delegator`,
            ok:
                opened === true &&
                panel != null &&
                panel.caption === true &&
                panel.rungs === true &&
                panel.blurb === true &&
                panel.modesHidden === true,
            detail: JSON.stringify(panel),
        });
        await h.shot("cdp-shots/jarvis-fleet-autonomy.png");

        // The regression this control was rebuilt for: selecting Delegator used to grow the header group
        // ~140px and slide it left, out from under the cursor. The chip's left edge must not move.
        const beforeLeft = await h.ev(
            `Math.round(document.querySelector('[data-jarvis-autonomy="chip"]').getBoundingClientRect().left)`
        );
        const picked = await h.ev(`(() => {
            const p = document.querySelector('[data-jarvis-autonomy="panel"]');
            if (!p) return false;
            const row = [...p.querySelectorAll('button')].find((b) => (b.innerText || '').trim().startsWith('Delegator'));
            if (!row) return false;
            row.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 1400))"); // SetChannelTier RPC + loadChannels refetch
        const after = await h.ev(`(() => {
            const chip = document.querySelector('[data-jarvis-autonomy="chip"]');
            const p = document.querySelector('[data-jarvis-autonomy="panel"]');
            return {
                left: chip ? Math.round(chip.getBoundingClientRect().left) : null,
                width: chip ? Math.round(chip.getBoundingClientRect().width) : null,
                text: chip ? chip.innerText.replace(/\\n/g, ' ').trim() : null,
                stillOpen: p != null,
                modes: p ? /report/.test(p.innerText || '') && /fanout/.test(p.innerText || '') : false,
            };
        })()`);
        steps.push({
            step: `pick Delegator -> chip does not move, panel stays open, dispatch mode appears`,
            ok:
                picked === true &&
                after.left === beforeLeft &&
                /Delegator/.test(after.text ?? "") &&
                after.stillOpen === true &&
                after.modes === true,
            detail: `left ${beforeLeft} -> ${after.left} ${JSON.stringify(after)}`,
        });

        // Escape dismisses, and must dismiss ONLY the panel: Escape on a deep surface is also bound to
        // "back to Cockpit" (bindings.ts surface:back-home), which the panel suppresses while it is open.
        // A real key event, not a synthetic KeyboardEvent — floating-ui's dismissal never sees a dispatched
        // one, so a synthetic Escape asserts nothing here.
        const realEscape = async () => {
            for (const type of ["keyDown", "keyUp"]) {
                await h.cdp("Input.dispatchKeyEvent", {
                    type,
                    key: "Escape",
                    code: "Escape",
                    windowsVirtualKeyCode: 27,
                });
            }
            await h.ev("new Promise((r) => setTimeout(r, 700))"); // PopoverReveal exit
        };
        // focus the chip first: picking a tier lets the Stage composer take focus back, and Escape with a
        // field focused belongs to jarvis:blur-composer (it leaves the field, panel untouched). Focusing
        // the chip is the keyboard-driven path this step is about.
        await h.ev(`(() => { document.querySelector('[data-jarvis-autonomy="chip"]').focus(); return true; })()`);
        await realEscape();
        const dismissed = await h.ev(`(() => ({
            panelGone: document.querySelector('[data-jarvis-autonomy="panel"]') == null,
            chipStillThere: document.querySelector('[data-jarvis-autonomy="chip"]') != null,
        }))()`);
        const stayed = (await h.activeSurfaceLabel()) === SURFACE_LABEL.jarvis;
        steps.push({
            step: `Escape closes the autonomy panel without leaving the surface`,
            ok: dismissed.panelGone === true && dismissed.chipStillThere === true && stayed === true,
            detail: `${JSON.stringify(dismissed)} surfaceStillJarvis=${stayed}`,
        });
        // and with the panel closed, Escape must still do its surface-level job
        await realEscape();
        const wentHome = (await h.activeSurfaceLabel()) === SURFACE_LABEL.cockpit;
        steps.push({
            step: `Escape with the panel closed still returns to the Cockpit`,
            ok: wentHome === true,
            detail: `surface=${await h.activeSurfaceLabel()}`,
        });
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

        // Asking about the same object twice must land in the same thread. It used to mint a new one per
        // click, which is what filled the Threads group with duplicate rows — four distinct questions
        // occupying twelve rows, each copy carrying none of the others' answers.
        // counts subject rows, not buttons: a group's first button is its disclosure header now, which would
        // make every count one too many.
        const countThreads = () =>
            h.ev(`(() => {
                const group = document.querySelector('[data-jarvis-group="threads"]');
                return group ? group.querySelectorAll('[data-jarvis-subject-kind]').length : -1;
            })()`);
        const before = await countThreads();
        await h.goto("memory");
        await h.ev(`(() => {
            const rows = [...document.querySelectorAll('button')].filter((b) => (b.className || '').includes('rounded-[11px]'));
            if (rows[0]) rows[0].click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Ask Jarvis');
            if (b) b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        const after = await countThreads();
        steps.push({
            step: "Ask Jarvis twice on the same note -> one thread, not two",
            ok: before > 0 && after === before,
            detail: `threadRowsBefore=${before} after=${after}`,
        });
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
//   - selecting a non-channel subject closes the drawer, which has no trigger on the rail to close there;
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
        // which is a kind with no ⚙ on the rail — exactly the state the drawer used to be stranded in.
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

// --- jarvis subject state: what must NOT follow you between subjects, and what the peek opens on -----
// The regression net for findings 7-10 of the 2026-07-28 pass. All four are cross-atom or layout defects
// that a green unit suite could not see:
//   - the composer draft and the channel picker were global, so a half-typed question (and an open
//     "Dispatch into which channel?" prompt) followed the user to the next subject;
//   - the graph peek only self-focused for a record, opening on the whole vault from anything else;
//   - two legends inside the peek disagreed on case and order;
//   - the record variant of the rail's fleet line overflowed the 300px rail, clipped mid-word.
// The dev fixture bar is the subject source here: each button selects a *conversation* subject whose id is
// the fixture name, so two clicks give two genuinely different subjects with no backend involved.
// Steps 5-6 need one record in the vault (any record — the row is found structurally, never by name); with
// an empty vault they report that rather than passing quietly.
const KINDS_JSON = JSON.stringify(["task", "run", "decision", "memory"]);
const jarvisSubjectState = {
    name: "jarvis-subject-state",
    surface: "jarvis",
    // step 9 restores a subject across a reload, so it needs one that still exists on the other side. It
    // creates its own rather than borrowing a rendered row: the other scenarios' channels are deleted in
    // their teardown while the local list still shows them, so borrowing one stores a doomed id and the
    // restore correctly clears it - a false failure. Mirrors jarvis-fleet/jarvis-drawer's own setup.
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-subject-"));
        const ch = await h.rpc("createchannel", { name: "verify-subject", projectpath: cwd });
        return { cwd, channelId: ch.oid };
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.goto("jarvis");
        await settle(400);

        const pickFixture = (name) =>
            h.ev(`(() => {
                const b = [...document.querySelectorAll('[data-fixture]')]
                    .find((x) => x.getAttribute('data-fixture') === ${JSON.stringify(name)});
                if (!b) return false;
                b.click();
                return true;
            })()`);
        // the Jarvis ask box: the one composer input off a channel.
        const typeDraft = (text) =>
            h.ev(`(() => {
                const i = document.querySelector('input[placeholder^="Ask Jarvis"]');
                if (!i) return false;
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                setter.call(i, ${JSON.stringify(text)});
                i.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`);
        const readDraft = () =>
            h.ev(`(() => {
                const i = document.querySelector('input[placeholder^="Ask Jarvis"]');
                return i ? i.value : null;
            })()`);
        const submitDraft = () =>
            h.ev(`(() => {
                const i = document.querySelector('input[placeholder^="Ask Jarvis"]');
                if (!i) return false;
                i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                return true;
            })()`);
        const pickerOpen = () => h.ev(`/dispatch into which channel/i.test(document.body.innerText || '')`);

        // 1-2. a draft belongs to the subject it was typed on: gone on the next subject, still there on
        // return. Two assertions, because clearing the box on every switch would satisfy the first alone.
        await pickFixture("grounded");
        await settle(300);
        const typed = await typeDraft("tighten the record band copy");
        await settle(150);
        await pickFixture("active");
        await settle(300);
        const onOther = await readDraft();
        rec(
            "1. a draft typed on one thread does not follow to the next subject",
            typed === true && onOther === "",
            `typed=${typed} draftOnOtherSubject=${JSON.stringify(onOther)}`
        );
        await pickFixture("grounded");
        await settle(300);
        const back = await readDraft();
        rec(
            "2. returning to that thread restores its own draft",
            back === "tighten the record band copy",
            JSON.stringify(back)
        );
        await h.shot("cdp-shots/jarvis-subject-draft.png");

        // 3. the picker's twin defect. An @run off a channel has to ask which channel to dispatch into;
        // that prompt was component state on a component that never unmounts, so it followed too.
        await typeDraft("@run tighten the record band copy");
        await settle(150);
        await submitDraft();
        await settle(400);
        const raised = await pickerOpen();
        await pickFixture("active");
        await settle(400);
        const followed = await pickerOpen();
        rec(
            "3. an open channel picker does not follow to the next subject",
            raised === true && followed === false,
            `raisedOnThread=${raised} stillOpenOnNextSubject=${followed}`
        );

        // 4. one legend in the peek. The header drew "task run decision memory" (lowercase) while the
        // canvas drew "Task Decision Memory Run" — same four kinds, twice, in two orders.
        const openPeek = () =>
            h.ev(`(() => {
                const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Graph');
                if (!b) return false;
                b.click();
                return true;
            })()`);
        const closePeek = () =>
            h.ev(`(() => {
                const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('Close'));
                if (b) b.click();
                return b != null;
            })()`);
        const peeked = await openPeek();
        await settle(1200); // the force graph is lazy-loaded
        // a legend is any element whose children are exactly the four node kinds — precise enough not to
        // count the detail panel's single "task" read-out of a selected node.
        const legends = await h.ev(`(() => {
            const kinds = ${KINDS_JSON};
            return [...document.querySelectorAll('div')].filter((d) => {
                const kids = [...d.children].map((c) => (c.textContent || '').trim().toLowerCase());
                return kids.length === kinds.length && kinds.every((k) => kids.includes(k));
            }).length;
        })()`);
        rec("4. the graph peek draws exactly one node-kind legend", peeked === true && legends === 1, `legends=${legends}`);

        // 5. the node filter: the way in when the subject resolves to no node (an unattributed run, a
        // radar or memory thread). Assert it answers, not what this vault happens to contain.
        const filtered = await h.ev(`(() => {
            const i = document.querySelector('input[aria-label="Find a node"]');
            if (!i) return null;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(i, 'e');
            i.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await settle(300);
        const answered = await h.ev(`/(\\d+ match(es)?|No node matches)/i.test(document.body.innerText || '')`);
        rec("5. the peek's node filter answers a query", filtered === true && answered === true, `answered=${answered}`);
        await h.shot("cdp-shots/jarvis-subject-peek-filter.png");
        await closePeek();
        await settle(300);

        // 6. the peek opens *on* something. A record subject blooms and selects itself, so the detail
        // panel reads out a node instead of "Click a node to open it".
        // Records defaults collapsed, so open it before looking for a row. Keyed off data-jarvis-group
        // rather than a /^records/i test on the group's first child: that child is the disclosure header now,
        // and its text reads "▸RECORDS17".
        await h.ev(`(() => {
            if (document.querySelector('[data-jarvis-subject-kind="dossier"]') == null) {
                document.querySelector('[data-jarvis-group-toggle="dossiers"]')?.click();
            }
        })()`);
        await settle(300);
        const record = await h.ev(`(() => {
            const b = document.querySelector('[data-jarvis-group="dossiers"] [data-jarvis-subject-kind="dossier"]');
            if (!b) return null;
            b.click();
            return (b.getAttribute('aria-label') || '').trim();
        })()`);
        await settle(1200); // selectSubject -> selectDossier + ResolveSpaceScope
        if (record == null) {
            rec("6. the peek self-focuses from a record subject", false, "no record in this vault — nothing to select");
            rec("7. the rail's fleet line stays inside the rail", false, "no record subject reachable");
            return steps;
        }
        await openPeek();
        await settle(1500); // graph load + the record's attribution bloom
        const focused = await h.ev(`(() => {
            const t = document.body.innerText || '';
            return { selected: /selected node/i.test(t), hint: /click a node to open it/i.test(t) };
        })()`);
        rec(
            "6. the peek self-focuses from a record subject",
            focused.selected === true && focused.hint === false,
            `${JSON.stringify(focused)} record=${JSON.stringify(record)}`
        );
        await h.shot("cdp-shots/jarvis-subject-peek-focus.png");
        await closePeek();
        await settle(400);

        // 7. the fleet line's own row. It used to read "N working · across M channels" under
        // whitespace-nowrap beside the "Fleet · on this record" title and ran 37px past the rail, clipped
        // to "…across 0 ch" — a clipped count reads as a smaller fleet than the real one.
        await h.ev(`(() => {
            const b = document.querySelector('button[aria-label="Stage context"]');
            if (b) b.click();
            return true;
        })()`);
        await settle(500);
        const fleet = await h.ev(`(() => {
            const rail = document.querySelector('aside[aria-label="Stage context"]');
            if (!rail) return { rail: false };
            const span = [...rail.querySelectorAll('span')].find((s) => /\\d+ working ·/.test(s.textContent || ''));
            if (!span) return { rail: true, counts: null };
            const r = span.getBoundingClientRect();
            const rr = rail.getBoundingClientRect();
            return {
                rail: true,
                counts: (span.textContent || '').trim(),
                overflowPx: Math.round(r.right - rr.right),
                clipped: span.scrollWidth > span.clientWidth + 1,
            };
        })()`);
        rec(
            "7. the rail's fleet line stays inside the rail",
            fleet.counts != null && fleet.overflowPx <= 0 && fleet.clipped === false,
            JSON.stringify(fleet)
        );
        await h.shot("cdp-shots/jarvis-subject-fleet-line.png");

        // 8. a thread nobody asked anything in is a false start: "+ Thread" creates the conversation up
        // front, so clicking it repeatedly used to leave a permanent "New conversation" row behind each
        // time. Nothing durable is lost by dropping them — the backend record is created by the first turn.
        // counts subject rows, not buttons: a group's first button is its disclosure header now, which would
        // make every count one too many.
        const countThreads = () =>
            h.ev(`(() => {
                const group = document.querySelector('[data-jarvis-group="threads"]');
                return group ? group.querySelectorAll('[data-jarvis-subject-kind]').length : -1;
            })()`);
        const newThread = () =>
            h.ev(`(() => {
                const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '+ Thread');
                if (!b) return false;
                b.click();
                return true;
            })()`);
        await newThread();
        await settle(500);
        const oneEmpty = await countThreads();
        await newThread();
        await settle(500);
        await newThread();
        await settle(500);
        const stillOne = await countThreads();
        rec(
            "8. repeated + Thread does not pile up unasked threads",
            oneEmpty > 0 && stillOne === oneEmpty,
            `afterFirst=${oneEmpty} afterThree=${stillOne}`
        );

        // 9-11. the last subject survives a launch. Persisting the pair is the easy half; the point is the
        // validation - a stored id can name something since deleted, and each kind's list lands
        // asynchronously, so the restore must wait on its own list and then degrade silently.
        // A reload is the real boot path: the surface remounts with an empty activeSubjectAtom.
        // a row is identified by data-jarvis-subject-kind, not by colour alone: the column's header carries
        // accent-tinted buttons too ("+ Channel"), and those would match a bg-accentbg test. This was a test
        // on the row's leading subject mark, which stopped identifying a record once record rows started
        // drawing a status-toned bar in place of the glyph. The label comes off aria-label rather than
        // textContent for the same reason — a record row's text also carries its status chip and age.
        const activeSubjectLabel = () =>
            h.ev(`(() => {
                const rows = [...document.querySelectorAll('[data-jarvis-region="subjects"] [data-jarvis-subject-kind]')];
                const on = rows.find((b) => /bg-accentbg/.test(b.className || ''));
                return on ? (on.getAttribute('aria-label') || '').trim() : null;
            })()`);
        const reload = async () => {
            await h.ev("location.reload()");
            await settle(2500);
            await h.goto("jarvis");
            await settle(1200);
        };
        // start from a clean surface: step 6 selected a record, which leaves a Space active whose scope
        // filters the Subjects column - and this scenario's own channel is not in that scope, so the row
        // would be genuinely absent rather than the restore being broken.
        await reload();
        // this scenario's own channel: a channel is the one kind whose list is a live subscription, so it is
        // the strictest of the three for the wait-on-my-own-list rule.
        // aria-label, matching activeSubjectLabel above: both sides of the before/after comparison have to
        // read the row's name the same way, and a mark-prefixed textContent would never equal a bare label.
        const picked = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-region="subjects"] [data-jarvis-subject-kind]')];
            const b = rows.find((x) => (x.getAttribute('aria-label') || '').trim() === 'verify-subject');
            if (!b) return null;
            b.click();
            return 'verify-subject';
        })()`);
        if (picked == null) {
            rec("9. the last subject is restored after a reload", false, "the scenario's own channel row is missing");
        } else {
            await settle(600);
            const beforeReload = await activeSubjectLabel();
            await reload();
            const afterReload = await activeSubjectLabel();
            rec(
                "9. the last subject is restored after a reload",
                afterReload != null && afterReload === beforeReload,
                `before=${JSON.stringify(beforeReload)} after=${JSON.stringify(afterReload)}`
            );
        }

        // 10. a stored id nothing holds any more must land on the empty Stage, not on a wrong row and not
        // stuck waiting. Written straight into storage so the case does not need a real deletion.
        await h.ev(
            `localStorage.setItem('jarvis.subject.last', JSON.stringify({ kind: 'channel', id: 'does-not-exist' }))`
        );
        await reload();
        const afterStale = await activeSubjectLabel();
        const cleared = await h.ev(`localStorage.getItem('jarvis.subject.last')`);
        rec(
            "10. a stored subject that no longer exists degrades to the empty Stage and is cleared",
            afterStale == null && (cleared === null || cleared === "null"),
            `active=${JSON.stringify(afterStale)} stored=${JSON.stringify(cleared)}`
        );

        // 11. archiving a thread moves it out of Threads and into the shared trailing Archived group -
        // channels and threads share one header, because two "Archived" headers would read as two states.
        // group headers are Tailwind `uppercase` and innerText/textContent applies text-transform, so the
        // match has to be case-insensitive.
        // Groups are addressed by data-jarvis-group (their key), not by a regex on the group's first child:
        // that child is the disclosure header now and reads "▸ARCHIVED3". Archived and Records both default
        // collapsed, so a lookup has to open the group first or it reads back an empty list and the archive
        // assertions fail for the wrong reason. Rows are read by aria-label, and counted as
        // [data-jarvis-subject-kind] rather than as buttons, so the header is never mistaken for a row.
        const expandGroup = async (key) => {
            const r = await h.ev(`(() => {
                const g = document.querySelector('[data-jarvis-group="${key}"]');
                if (g == null) return 'no-group';
                if (g.querySelector('[data-jarvis-subject-kind]') != null) return 'open';
                g.querySelector('[data-jarvis-group-toggle]')?.click();
                return 'clicked';
            })()`);
            if (r === "clicked") await settle(300);
            return r;
        };
        const groupItems = async (key) => {
            await expandGroup(key);
            return h.ev(`(() => {
                const group = document.querySelector('[data-jarvis-group="${key}"]');
                if (!group) return null;
                return [...group.querySelectorAll('[data-jarvis-subject-kind]')]
                    .map((b) => (b.getAttribute('aria-label') || '').trim());
            })()`);
        };
        // Archive needs a thread the BACKEND holds: the flag lives on the persisted record, so archiving a
        // local unasked thread ("New conversation", created up front by + Thread) has nothing to update.
        // A real converse turn runs a headless CLI up to 120s, far too slow to create one here, so this
        // takes an already-persisted row and puts it back afterwards - the workspace is the user's.
        // scoped to a group, because several threads here share a title: an unscoped match would right-click
        // one of the identically-titled rows still in Threads and then look for an Unarchive item that row's
        // menu does not have.
        const rightClickRow = async (group, title) => {
            await expandGroup(group);
            return h.ev(`(() => {
                const box = document.querySelector('[data-jarvis-group="${group}"]');
                if (!box) return false;
                const row = [...box.querySelectorAll('[data-jarvis-subject-kind]')]
                    .find((b) => (b.getAttribute('aria-label') || '').trim() === ${JSON.stringify(title)});
                if (!row) return false;
                row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 200 }));
                return true;
            })()`);
        };
        const clickMenuItem = (label) =>
            h.ev(`(() => {
                const want = new RegExp('^' + ${JSON.stringify(label)} + '$', 'i');
                const item = [...document.querySelectorAll('*')].find(
                    (e) => e.children.length === 0 && want.test((e.textContent || '').trim())
                );
                if (!item) return false;
                item.click();
                return true;
            })()`);

        // counted, not membership-tested: this workspace holds several identically-titled threads (the very
        // duplication gap 12c fixes), so "is it still in Threads" would read false for a row that moved.
        const countOf = (arr, t) => (arr ?? []).filter((x) => x === t).length;

        const threadsBefore = await groupItems("threads");
        const archivedBefore = await groupItems("archived");
        // a persisted thread got its title from a real first turn, so never "New conversation". Dev fixture
        // threads also carry real titles but have no backend record - they sort last, so take the first.
        const target = (threadsBefore ?? []).find((t) => !/New conversation$/.test(t));
        if (target == null) {
            rec(
                "11. archiving a thread moves it into the shared Archived group",
                false,
                `no persisted thread to archive: ${JSON.stringify(threadsBefore)}`
            );
        } else {
            const opened = await rightClickRow("threads", target);
            await settle(400);
            const clickedArchive = await clickMenuItem("archive thread");
            await settle(1500); // the RPC plus the re-list the Threads group is rebuilt from
            const threadsAfter = await groupItems("threads");
            const archivedAfter = await groupItems("archived");
            const leftThreads = countOf(threadsAfter, target) === countOf(threadsBefore, target) - 1;
            const joinedArchived = countOf(archivedAfter, target) === countOf(archivedBefore, target) + 1;
            rec(
                "11. archiving a thread moves it into the shared Archived group",
                opened === true && clickedArchive === true && leftThreads && joinedArchived,
                `row=${JSON.stringify(target)} menu=${opened}/${clickedArchive} threads=${countOf(threadsBefore, target)}->${countOf(threadsAfter, target)} archived=${countOf(archivedBefore, target)}->${countOf(archivedAfter, target)}`
            );
            await h.shot("cdp-shots/jarvis-subject-archived-thread.png");
            // put it back: this scenario runs against the user's real workspace.
            if (joinedArchived) {
                await rightClickRow("archived", target);
                await settle(400);
                await clickMenuItem("unarchive thread");
                await settle(1500);
                const restored = await groupItems("threads");
                rec(
                    "12. unarchiving puts the thread back in Threads",
                    countOf(restored, target) === countOf(threadsBefore, target),
                    `threads=${countOf(threadsBefore, target)}->${countOf(restored, target)}`
                );
            }
        }
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        // the persisted subject points at the channel about to go; step 10 already proves a stale one
        // degrades, but leaving one behind would make the NEXT run's step 9 start from a cleared restore.
        await h.ev(`localStorage.removeItem('jarvis.subject.last')`).catch(() => {});
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

// The design's narrow-window collapse order (JC16). This is the check the previous conformance pass
// could not make: "the thread is still mounted" passed on the broken layout, where the chrome held a
// constant 572px and the Stage went 1270 -> 70px. So rule 5 is asserted as a *width* — the Stage never
// drops below its floor while the order still has a region left to yield — plus the order itself, which
// must run rail-then-Subjects and never the other way round.
const STAGE_MIN_PX = 640; // mirrors frontend/app/view/jarvis/jarvislayout.ts

// stageRailOpenAtom is persisted, and the surface writes it false the first time it collapses. So any run
// that drove a narrow width - including a previous run of one of these two scenarios - leaves the rail
// already collapsed at 1920, where step 3 then cannot observe it yield. Pin the flag and reload so the
// width scan starts from a known rail, rather than inheriting a preference formed at some other width.
const resetRail = async (h) => {
    await h.ev(`localStorage.setItem('jarvis.stagerail.open', 'true')`);
    await h.ev("location.reload()");
    await h.ev("new Promise((r) => setTimeout(r, 2500))");
    return {};
};

// The width no longer has a vote on the rail (jarvissurface.tsx), so a scenario about the Stage's floor has
// to pin the rail itself: with a 300px rail the user opened, the floor is legitimately unreachable below a
// ~1074px window and that is the design's answer, not a regression.
const setRail = (open) => async (h) => {
    await h.ev(`localStorage.setItem('jarvis.stagerail.open', ${JSON.stringify(String(open))})`);
    await h.ev("location.reload()");
    await h.ev("new Promise((r) => setTimeout(r, 2500))");
    return {};
};

const jarvisCollapseOrder = {
    name: "jarvis-collapse-order",
    surface: "jarvis",
    arrange: setRail(false),
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.goto("jarvis");
        await settle(400);

        const probe = () =>
            h.ev(`(() => {
                const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
                const region = (n) => document.querySelector('[data-jarvis-region="' + n + '"]');
                const surface = region('surface');
                // by aria-label, not by child position: once the rail can overlay it sits inside a
                // display:contents wrapper, so it is no longer a direct child of the surface row.
                const rail = surface ? surface.querySelector('aside[aria-label="Stage context"]') : null;
                return {
                    surface: w(surface),
                    subjects: w(region('subjects')),
                    stage: w(region('stage')),
                    rail: w(rail),
                    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                };
            })()`);

        // 50px steps from 900 to 1600 rather than five spot widths. The dip this scenario missed lived
        // between 1000 and 1050: the staircase gave the Stage 822px at a 1000px window and 656px at 1050,
        // and the old sample grid (1920/1440/1100/900/720) straddled it. jarvislayout.test.ts owns the 1px
        // proof; this owns "the live layout agrees".
        const sweep = [];
        for (let width = 900; width <= 1600; width += 50) {
            await h.cdp("Emulation.setDeviceMetricsOverride", {
                width,
                height: 900,
                deviceScaleFactor: 1,
                mobile: false,
            });
            await settle(320);
            sweep.push({ width, ...(await probe()) });
        }
        const at = Object.fromEntries(sweep.map((s) => [s.width, s]));
        await h.shot("cdp-shots/jarvis-collapse-1600.png");
        await settle(300);

        // 1. rule 5, as a width, with the rail closed — the widths where the column can fund the floor.
        const floored = [1600, 1400, 1200, 1000, 900];
        const held = floored.filter((wd) => at[wd].stage >= STAGE_MIN_PX);
        rec(
            `1. the Stage holds >= ${STAGE_MIN_PX}px at ${floored.join("/")}`,
            held.length === floored.length,
            floored.map((wd) => `${wd}:${at[wd].stage}`).join(" ")
        );

        // 2. THE regression. Widening the window must never narrow the thread. The old order was monotone in
        //    its collapse *flags* and sawtoothed in the width that matters.
        const shrank = sweep.filter((s, i) => i > 0 && s.stage < sweep[i - 1].stage);
        rec(
            "2. the Stage never shrinks as the window widens",
            shrank.length === 0,
            shrank.length > 0
                ? shrank.map((s) => `${s.width}:${s.stage}`).join(" ")
                : `${sweep[0].stage}..${sweep[sweep.length - 1].stage}`
        );

        // 3. the column funds the floor continuously — it must actually take intermediate widths, not just
        //    snap between 272 and 56. A continuous lever nothing ever lands mid-range is a staircase.
        const between = sweep.filter((s) => s.subjects > 56 && s.subjects < 272);
        rec(
            "3. the Subjects column takes intermediate widths",
            between.length > 0,
            between.map((s) => `${s.width}:${s.subjects}`).join(" ") || "always 272 or 56"
        );

        // 4. nothing escapes horizontally at any width — the band's chips used to draw over the rail.
        const overflowing = sweep.filter((s) => s.docOverflow > 0);
        rec("4. no horizontal document overflow at any width", overflowing.length === 0, overflowing.map((s) => s.width).join(","));

        // 5. the width does not close a rail the user opened. This used to write the open atom shut on every
        //    transition into narrow — and since the first measurement counts as one and the surface unmounts
        //    on each nav switch, the rail was a 44px strip at every width until clicked open again.
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
        await settle(320);
        await h.ev(`document.querySelector('aside[aria-label="Stage context"] button')?.click()`);
        await settle(450);
        const railOpened = (await probe()).rail;
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
        await settle(450);
        const railAfterNarrow = (await probe()).rail;
        rec(
            "5. narrowing the window leaves an opened rail open",
            railOpened > 44 && railAfterNarrow === railOpened,
            `opened=${railOpened} after-narrow=${railAfterNarrow}`
        );
        return steps;
    },
    async teardown(h) {
        // the runner restores its pinned viewport after every scenario, so this only has to leave the
        // surface where the others expect it.
        await h.goto("cockpit");
    },
};

// The two layers added on top of the collapse order: the nav rail collapsing itself below a narrow window
// (navrailwidth.ts, the design's step 4) and the context rail leaving the flow entirely once collapsing
// both regions to strips is still not enough (jarvislayout.ts's railOverlay). jarvis-collapse-order owns
// the *order*; this owns the two widths where the new steps fire.
const jarvisNarrow = {
    name: "jarvis-narrow",
    surface: "jarvis",
    // closed: the overlay substitutes for the 44px strip. A rail the user opened is never overlaid
    // (jarvislayout.layoutFor), so with it open this scenario's subject does not exist.
    arrange: setRail(false),
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.goto("jarvis");
        await settle(400);

        // measured, not computed: the point of this scenario is that the live layout agrees with
        // jarvislayout.ts's arithmetic. STAGE_MIN_PX is mirrored above - if they drift, this fails.
        const boxes = () =>
            h.ev(`(() => {
                const q = (sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return { left: r.left, right: r.right, width: r.width };
                };
                return JSON.stringify({
                    surface: q('[data-jarvis-region="surface"]'),
                    stage: q('[data-jarvis-region="stage"]'),
                    subjects: q('[data-jarvis-region="subjects"]'),
                    rail: q('aside[aria-label="Stage context"]'),
                });
            })()`);

        // raw CDP passthrough - the harness exposes h.cdp for exactly this (attach.mjs:143). verify.mjs
        // re-applies VERIFY_VIEWPORT after every scenario, so no teardown is needed here.
        const atWidth = async (width) => {
            await h.cdp("Emulation.setDeviceMetricsOverride", {
                width,
                height: 1000,
                deviceScaleFactor: 1,
                mobile: false,
            });
            await settle(350);
            return JSON.parse(await boxes());
        };

        for (const width of [1600, 1200, 1000, 900]) {
            const b = await atWidth(width);
            const ok = b.stage != null && b.stage.width >= STAGE_MIN_PX;
            rec(`stage holds its floor at ${width}px`, ok, `stage=${Math.round(b.stage?.width ?? 0)}px`);
        }

        // below the point where strips are still enough, the rail must stop taking inline width: its box
        // overlaps the Stage's rather than sitting beside it. 760, not 800: the nav rail's own collapse
        // frees 22px, so at 800 the two strips already clear the floor (644px) and the overlay is correctly
        // NOT engaged. The overlay's first width is 796 and below.
        const narrow = await atWidth(760);
        const overlapping = narrow.rail != null && narrow.stage != null && narrow.rail.left < narrow.stage.right;
        rec(
            "rail overlays the Stage once collapsing is not enough",
            overlapping,
            `rail.left=${Math.round(narrow.rail?.left ?? 0)} stage.right=${Math.round(narrow.stage?.right ?? 0)}`
        );
        rec(
            "stage still holds its floor with the rail overlaid",
            narrow.stage != null && narrow.stage.width >= STAGE_MIN_PX,
            `stage=${Math.round(narrow.stage?.width ?? 0)}px`
        );

        // the nav rail is global chrome, so its collapse is asserted on the nav itself rather than inferred
        // from the surface getting wider.
        const navWidth = () =>
            h.ev(`(() => {
                const nav = document.querySelector('nav');
                return nav ? Math.round(nav.getBoundingClientRect().width) : null;
            })()`);
        const navNarrow = await navWidth();
        await atWidth(1200);
        const navWide = await navWidth();
        rec(
            "the nav rail collapses itself below 900px and reopens above it",
            navNarrow === 56 && navWide === 78,
            `at760=${navNarrow} at1200=${navWide}`
        );

        await atWidth(760);
        await h.shot("cdp-shots/jarvis-narrow.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// One gutter, one header band (jarvis/stagemeasure.ts). The surface was assembled by merging three
// destinations, and each region kept the padding, header height and divider tone it had as its own screen:
// measured at 1500px, the Stage's stacked bands started their content at 366 (header, px-4), 382 (thread,
// max-w-[900px] px-8) and 370 (composer, px-5), the record subject added 432 (max-w-[720px] centred) over a
// full-bleed 18, and the three columns' header rules landed at y=44, 81 and 96 in two tones. Nothing here is
// derivable from a unit test — it is where the boxes actually are.
//
// The first version of this asserted one left edge across the elements carrying the shared measure's class,
// which is circular: a sealed run's header band did not carry it, kept its own px-6, and put the largest
// text on the Stage 20px left of everything else while this scenario stayed green. So the probe below finds
// bands by geometry, and the loop walks every subject kind rather than only the fixture conversation.
const jarvisMeasure = {
    name: "jarvis-measure",
    surface: "jarvis",
    arrange: setRail(true),
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        await h.goto("jarvis");
        await settle(400);

        // A band is anything as wide as the Stage (allowing for a scrollbar). Its content-left is where its
        // own padding starts; 0 means a bare rule/background wrapper that pads nothing, and every other
        // value has to be the one gutter. `reach` is the widest content box any gutter band gets — the check
        // that the Stage is actually being used, which a centred column fails by design.
        const probe = () =>
            h.ev(`(() => {
                const stage = document.querySelector('[data-jarvis-region="stage"]');
                const r0 = stage.getBoundingClientRect();
                const surfaceTop = document.querySelector('[data-jarvis-region="surface"]')?.getBoundingClientRect().top ?? 0;
                const lefts = [];
                let reach = 0;
                for (const el of stage.querySelectorAll('div,button,section,header,aside')) {
                    const r = el.getBoundingClientRect();
                    if (r.width < r0.width - 12 || r.height < 10) continue;
                    const cs = getComputedStyle(el);
                    const padL = parseFloat(cs.paddingLeft) || 0;
                    if (padL <= 0) continue;
                    lefts.push(Math.round(r.left - r0.left + padL));
                    reach = Math.max(reach, Math.round(r.width - padL - (parseFloat(cs.paddingRight) || 0)));
                }
                // each column's first horizontal rule, as a y relative to the surface
                const ruleY = (sel) => {
                    const col = document.querySelector(sel);
                    if (col == null) return null;
                    for (const el of [col, ...col.querySelectorAll('*')]) {
                        const cs = getComputedStyle(el);
                        if ((parseFloat(cs.borderBottomWidth) || 0) > 0) {
                            const r = el.getBoundingClientRect();
                            if (r.width > 40) return Math.round(r.bottom - surfaceTop);
                        }
                    }
                    return null;
                };
                return JSON.stringify({
                    stage: Math.round(r0.width),
                    lefts: [...new Set(lefts)],
                    reach,
                    rules: {
                        subjects: ruleY('[data-jarvis-region="subjects"]'),
                        stage: ruleY('[data-jarvis-region="stage"]'),
                        rail: ruleY('aside[aria-label="Stage context"]'),
                    },
                });
            })()`);

        // the conversation comes from the dev-only fixture bar; the channel and record rows come from
        // whatever the dev DB holds, matched on data-jarvis-subject-kind. Matching on the row's leading
        // subject mark used to work, but a record row draws a status-toned bar instead of a glyph now, and a
        // mark-based lookup would silently find nothing and drop the record kind while still reporting green.
        const selectKind = (kind) =>
            kind == null
                ? h.ev(`(() => { const b = document.querySelector('[data-fixture="active"]'); if (b == null) return "none"; b.click(); return "ok"; })()`)
                : h.ev(`(() => {
                      const row = document.querySelector('[data-jarvis-subject-kind="${kind}"]');
                      if (row == null) return "none";
                      row.click();
                      return "ok";
                  })()`);

        // Records defaults collapsed, so its rows are absent from the DOM until the group is opened — and the
        // open has to settle before the row can be queried, which is why this is its own step rather than a
        // branch inside selectKind.
        const expandRecords = async () => {
            const r = await h.ev(`(() => {
                if (document.querySelector('[data-jarvis-subject-kind="dossier"]') != null) return "open";
                const hdr = document.querySelector('[data-jarvis-group-toggle="dossiers"]');
                if (hdr == null) return "no-group";
                hdr.click();
                return "clicked";
            })()`);
            if (r === "clicked") await settle(300);
            return r;
        };

        for (const width of [1500, 1920]) {
            await h.cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
            await settle(450);

            const seen = [];
            let recordsGroup = "n/a";
            for (const [label, kind] of [
                ["conversation", null],
                ["channel", "channel"],
                ["record", "dossier"],
            ]) {
                if (kind === "dossier") {
                    recordsGroup = await expandRecords();
                }
                if ((await selectKind(kind)) !== "ok") continue;
                await settle(800);
                seen.push([label, JSON.parse(await probe())]);
            }
            const kinds = seen.map(([k]) => k).join("+") || "none";
            const lefts = [...new Set(seen.flatMap(([, m]) => m.lefts))];

            rec(`at least two subject kinds reachable at ${width}px`, seen.length >= 2, kinds);
            // asserted on its own so a record row that has stopped being findable fails here instead of
            // quietly dropping out of the loop and leaving the measurements below looking green
            rec(
                `the collapsed Records group opens and yields a record row at ${width}px`,
                kinds.includes("record"),
                `group=${recordsGroup} kinds=${kinds}`
            );
            rec(
                `every band on the Stage shares one left edge at ${width}px`,
                lefts.length === 1,
                `kinds=${kinds} lefts=${lefts.join(",")}`
            );
            rec(
                `content reaches the Stage's width at ${width}px — no dead gutter`,
                seen.length > 0 && seen.every(([, m]) => m.reach >= m.stage - 80),
                seen.map(([k, m]) => `${k} ${m.reach}/${m.stage}`).join("  ")
            );
            const ys = Object.values(seen[seen.length - 1]?.[1].rules ?? {});
            rec(
                `the three columns' header rules share one y at ${width}px`,
                ys.length === 3 && ys.every((y) => y != null) && new Set(ys).size === 1,
                JSON.stringify(seen[seen.length - 1]?.[1].rules ?? {})
            );
        }

        await h.shot("cdp-shots/jarvis-measure.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- usage charts: the meter primitives + the visx DailyChart actually render -------------------
// Class names asserted below were read off the installed packages, not guessed: @visx/axis puts
// `visx-axis visx-axis-left` on the axis group and `visx-axis-tick` on each tick, and @visx/tooltip
// puts `visx-tooltip` on the portal. Step 5 is scoped to the chart's own <svg> — a page-wide title
// query would trip over icon <title> elements that have nothing to do with the chart.
const usageCharts = {
    name: "usage-charts",
    surface: "usage",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

        // The surface fetches its stats over RPC and shows a skeleton until they land, so the chart is
        // NOT in the DOM the instant goto returns. Poll for it instead of sleeping a fixed amount —
        // the all-time scan's duration depends on how many transcripts exist.
        let ready = false;
        for (let waited = 0; waited <= 10000 && !ready; waited += 250) {
            ready = (await h.ev(`document.querySelectorAll(".visx-axis-left .visx-axis-tick").length`)) > 0;
            if (!ready) await settle(250);
        }
        rec("0. usage surface loaded and the chart mounted", ready, ready ? "chart present" : "timed out after 10s");

        // the visx chart renders an <svg> with axis ticks and at least one bar rect
        const chart = await h.ev(`(() => {
            const svgs = [...document.querySelectorAll("svg")];
            const withTicks = svgs.filter((s) => s.querySelectorAll(".visx-axis-left .visx-axis-tick").length > 0);
            const s = withTicks[0];
            if (!s) return { found: false };
            return {
                found: true,
                leftTicks: s.querySelectorAll(".visx-axis-left .visx-axis-tick").length,
                bottomTicks: s.querySelectorAll(".visx-axis-bottom .visx-axis-tick").length,
                bars: s.querySelectorAll("path[fill^='var(--color-']").length,
            };
        })()`);
        rec(
            "1. DailyChart renders a visx svg with axes and bars",
            chart.found && chart.leftTicks >= 2 && chart.bars >= 1,
            JSON.stringify(chart)
        );

        // the tokens the chart and the class bars paint with all resolve (no invented chart palette —
        // these are the pre-existing design-system tokens, so a rename would break the fills silently)
        const palette = await h.ev(`(() => {
            const cs = getComputedStyle(document.documentElement);
            const names = ["--color-cacheread","--color-accent","--color-warning","--color-success","--color-accent-200","--color-accent-800"];
            return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
        })()`);
        rec(
            "2. the design-system tokens the chart paints with all resolve",
            Object.values(palette).every((v) => /^#[0-9a-f]{6}$/i.test(v)),
            JSON.stringify(palette)
        );

        // ArcMeter sweep: --usage-arc is set per element, so several rings coexist
        const arcs = await h.ev(`(() => {
            const els = [...document.querySelectorAll("*")].filter((e) => e.style && e.style.getPropertyValue("--usage-arc"));
            return { count: els.length, values: els.slice(0, 6).map((e) => e.style.getPropertyValue("--usage-arc")) };
        })()`);
        rec("3. ArcMeter rings scope --usage-arc per element", arcs.count >= 1, JSON.stringify(arcs));

        // hovering a column opens the visx tooltip (replacing the old native title attribute). React
        // delegates pointer events from a child rect, so dispatch there rather than on the <g>.
        const tip = await h.ev(`(() => {
            const svg = [...document.querySelectorAll("svg")].find((s) => s.querySelector(".visx-axis-left"));
            const r = svg && svg.querySelector("path[fill^='var(--color-']");
            if (!r) return { hovered: false };
            for (const type of ["pointerover", "mouseover", "mouseenter"]) {
                r.dispatchEvent(new MouseEvent(type, { bubbles: true }));
            }
            return { hovered: true };
        })()`);
        await settle(250);
        const tipText = await h.ev(
            `(() => { const t = document.querySelector("[class*='visx-tooltip']"); return t ? t.textContent : ""; })()`
        );
        rec("4. hover opens a styled tooltip", tip.hovered && tipText.length > 0, JSON.stringify({ tipText }));

        // no native title tooltips left on the chart itself
        const titles = await h.ev(`(() => {
            const svg = [...document.querySelectorAll("svg")].find((s) => s.querySelector(".visx-axis-left"));
            if (!svg) return -1;
            return svg.querySelectorAll("[title], title").length;
        })()`);
        rec("5. no native title tooltips on the chart", titles === 0, String(titles));

        // verify.mjs shoots before assert, which catches the skeleton; take our own once loaded.
        await h.shot("cdp-shots/usage-charts-loaded.png");

        // The brush only exists on All-time with >14 days, so the default 7d window never renders it.
        const clicked = await h.ev(`(() => {
            const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "All time");
            if (!b) return false;
            b.click();
            return true;
        })()`);
        let brush = { skipped: true };
        if (clicked) {
            for (let waited = 0; waited <= 20000; waited += 500) {
                brush = await h.ev(`(() => {
                    const svgs = [...document.querySelectorAll("svg")];
                    const chart = svgs.find((s) => s.querySelector(".visx-axis-left"));
                    if (!chart) return { loaded: false };
                    const strip = svgs.find((s) => s.querySelector(".visx-brush"));
                    // the chart card's own label, NOT the first "Daily" on the page (the "Daily avg" stat card)
                    const h3 = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === "Daily");
                    return {
                        loaded: true,
                        bars: chart.querySelectorAll("path[fill^='var(--color-']").length,
                        brushStrip: !!strip,
                        brushOverlay: !!document.querySelector(".visx-brush-overlay"),
                        label: h3 && h3.nextElementSibling ? h3.nextElementSibling.textContent.trim() : "",
                    };
                })()`);
                if (brush.loaded && brush.brushStrip) break;
                await settle(500);
            }
            await h.shot("cdp-shots/usage-charts-alltime.png");
        }
        rec("6. All-time renders the brush strip under the chart", !!brush.brushStrip, JSON.stringify(brush));

        return steps;
    },
    // leave the surface on the 7-day window the rest of the suite (and the developer) expects
    async teardown(h) {
        await h.ev(`(() => {
            const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "7 days");
            if (b) b.click();
        })()`);
    },
};

// --- the review-gate blind spot ----------------------------------------------------------------
// The whole defect in three steps: park a run at its review gate in one channel, make a DIFFERENT channel
// the active subject, then walk away to Usage and read the Jarvis nav badge. Before the attention list
// moved server-side this read zero — the badge counted only live `asking` workers, and a gated run has
// none (its phase completed and it is waiting on a human), while the frontend's cross-channel list came
// from a channel snapshot refetched only on create/delete/rename/archive.
//
// It parks the run by completing two phases over the real RPC rather than driving an agent to a gate,
// which would take up to two minutes. `wsh jarvis hold` is the other route but needs the phase running AND
// gated (jarvis/run.go HoldPhase) — in a pipeline the gate is phase 1, so it needs phase 0 completed
// first either way, for the same two spawned workers. Both are killed in teardown, as runs-lifecycle does.
//
// The poll wait is a 500ms loop rather than a flat 10s sleep so the step is not flaky at the interval
// boundary, and so a stalled poller fails HERE — distinguishable from the badge assertion failing, which
// means detection broke. The two halves of this change fail differently and must stay tellable apart.
const attentionCrossChannel = {
    name: "attention-cross-channel",
    surface: "usage",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-attn-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const probe = await h.rpc("createchannel", { name: "attn-probe", projectpath: cwd });
        const other = await h.rpc("createchannel", { name: "attn-other", projectpath: cwd });
        return { cwd, workspaceId, probeId: probe.oid, otherId: other.oid, workers: [] };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const track = (oref) => {
            if (oref) ctx.workers.push(oref);
        };
        const getRun = async (runId) => {
            const res = await h.rpc("getchannels", null);
            const cc = (res.channels || []).find((x) => x.oid === ctx.probeId) || {};
            return (cc.runs || []).find((x) => x.id === runId);
        };

        // 1. park a run at its review gate in the probe channel
        const created = await h.rpc("createrun", {
            channelid: ctx.probeId,
            workspaceid: ctx.workspaceId,
            goal: "spawn-test only: do nothing, make no file changes, stop immediately",
        });
        const runId = created.run.id;
        track(workerOf(created.run.phases[0]));
        await h.rpc("advancerun", { channelid: ctx.probeId, runid: runId, phaseidx: 0, action: "complete" });
        const mid = await getRun(runId);
        track(workerOf(mid.phases[1]));
        await h.rpc("advancerun", { channelid: ctx.probeId, runid: runId, phaseidx: 1, action: "complete" });
        const gated = await getRun(runId);
        rec(
            "1. the probe channel's run is parked at its review gate",
            gated.status === "awaiting-review" && gated.phases[2].state === "pending",
            JSON.stringify({ status: gated.status, states: gated.phases.map((p) => p.state) })
        );

        // 2. the server reports it as a gate item — the backend half, asserted before any DOM reading so a
        // failure here is never mistaken for a delivery problem
        const attention = await h.rpc("getattention", null);
        const item = (attention.items || []).find((x) => x.runid === runId);
        rec(
            "2. GetAttention reports the gate with its channel and wait time",
            item != null && item.kind === "gate" && item.channelid === ctx.probeId && item.waitingsince > 0,
            JSON.stringify(item ?? { items: (attention.items || []).length })
        );

        // 3. make a DIFFERENT channel the active subject, so the gate is in a non-active channel.
        // channelsAtom is a load-once snapshot, so channels created over RPC need a reload to appear in the
        // Subjects column at all (same pattern as jarvis-drawer / jarvis-fleet) — which is itself the
        // staleness that made this defect possible. Selecting by the row's visible name, stripping the
        // subject-kind glyph, is jarvis-drawer's proven selector.
        await h.ev("location.reload()");
        await settle(2500);
        await h.goto("jarvis");
        await settle(600);
        const selectedOther = await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')]
                .find((x) => (x.textContent || '').trim().replace(/^[#▤~]/, '').startsWith('attn-other'));
            if (!b) return false;
            b.click();
            return true;
        })()`);
        rec("3. a different channel is the active subject", selectedOther === true, `clicked=${selectedOther}`);

        // 4. leave for a surface nowhere near Jarvis, then wait for one poll tick
        await h.goto("usage");
        await settle(400);
        const jarvisBadge = () =>
            h.ev(`(() => {
                const b = document.querySelector('nav button[aria-label="Jarvis"]');
                if (!b) return null;
                const s = [...b.querySelectorAll('span')].find((x) => /^\\d+$/.test((x.textContent || '').trim()));
                return s ? Number(s.textContent.trim()) : 0;
            })()`);
        let badge = await jarvisBadge();
        for (let i = 0; i < 30 && !(badge >= 1); i++) {
            await settle(500);
            badge = await jarvisBadge();
        }
        rec(
            "4. a poll delivered a non-empty attention list to the nav rail",
            typeof badge === "number" && badge >= 1,
            `badge=${JSON.stringify(badge)} (waited up to 15s for a 10s poll)`
        );

        // 5. the assertion the defect failed: the badge is lit from a surface that is not Jarvis, for a
        // gate in a channel that is not active
        const onUsage = await h.activeSurfaceLabel();
        rec(
            "5. the Jarvis badge counts a review gate in a non-active channel, read from Usage",
            onUsage === "Usage" && badge >= 1,
            `surface=${onUsage} badge=${badge}`
        );
        await h.shot("cdp-shots/attention-cross-channel.png");

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
        for (const id of [ctx.probeId, ctx.otherId]) {
            try {
                await h.rpc("deletechannel", { channelid: id });
            } catch {
                // best-effort cleanup
            }
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
    jarvisSubjectState,
    jarvisCollapseOrder,
    jarvisNarrow,
    jarvisMeasure,
    usageCharts,
    attentionCrossChannel,
];
