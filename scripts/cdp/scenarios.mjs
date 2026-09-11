// Verification scenario manifest. Each entry: { name, surface, arrange(h)->ctx, assert(h,ctx)->steps,
// teardown(h,ctx) }. arrange/assert/teardown run in Node and drive the browser via h (see attach.mjs).
// Asserts are RPC-based (backend state) or DOM-based (h.ev) — NOT jotai atom reads (globalStore is not
// exposed on window). steps are { step, ok, detail }.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        // unique goal per run so the run-row selector can never match a leftover from an earlier
        // aborted verification (plural verify-proactive channels persist in the dev db with the old
        // "spawn-test only" goal).
        const goal = `spawn-test ${Date.now() % 100000}: do nothing, make no file changes, stop immediately`;
        return { cwd, workspaceId, channelId: ch.oid, workers: [], goal };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const getRun = async (runId) => {
            const res = await h.rpc("getchannels", null);
            const cc = (res.channels || []).find((x) => x.oid === ctx.channelId) || {};
            return (cc.runs || []).find((x) => x.id === runId);
        };
        const track = (oref) => {
            if (oref) ctx.workers.push(oref);
        };

        // mode pinned, not left empty: an empty mode resolves the profile's default, which is `quick`
        // (one phase, no gate) on a stock profile — and every step below asserts the three-phase
        // pipeline and the gate between p1 and p2. The shape under test has to be the one requested.
        const created = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid: ctx.workspaceId,
            goal: ctx.goal,
            runtime: "claude",
            tier: "capable",
            mode: "pipeline",
        });
        const run = created.run;
        const runId = run.id;
        track(workerOf(run.phases[0]));
        rec(
            "1. CreateRun -> 3 phases, p0 running + worker, status planning",
            run.phases.length === 3 &&
                run.phases[0].state === "running" &&
                !!workerOf(run.phases[0]) &&
                run.status === "planning",
            JSON.stringify({ status: run.status, states: run.phases.map((p) => p.state) })
        );

        await h.rpc("advancerun", {
            channelid: ctx.channelId,
            runid: runId,
            phaseidx: 0,
            action: "complete",
            artifacts: ["docs/spec.md"],
        });
        const r2 = await getRun(runId);
        track(workerOf(r2.phases[1]));
        rec(
            "2. Advance complete p0 -> p1 running + worker, status planning",
            r2.phases[0].state === "done" &&
                r2.phases[1].state === "running" &&
                !!workerOf(r2.phases[1]) &&
                r2.status === "planning",
            JSON.stringify({ status: r2.status, states: r2.phases.map((p) => p.state) })
        );

        await h.rpc("advancerun", {
            channelid: ctx.channelId,
            runid: runId,
            phaseidx: 1,
            action: "complete",
            artifacts: ["docs/plan.md"],
        });
        const r3 = await getRun(runId);
        rec(
            "3. Advance complete p1 -> awaiting-review, p2 pending, NO new worker",
            r3.phases[1].state === "done" &&
                r3.phases[2].state === "pending" &&
                !workerOf(r3.phases[2]) &&
                r3.status === "awaiting-review",
            JSON.stringify({ status: r3.status, states: r3.phases.map((p) => p.state) })
        );

        // --- the Brief's way in ------------------------------------------------------------------
        // The three-pane Subjects column is gone, so the run body is reached the way the Brief reaches
        // it: the gate this run is holding at is a queue row, and that row carries the run id, so the
        // sheet lands on THIS run rather than whichever one the channel would default to. It has to
        // happen here, at awaiting-review — once the run is cancelled every run in the channel is
        // terminal, the gate row is gone, and defaultRunId resolves nothing for the sheet to show. The
        // sheet then stays open across the two RPCs below, which is what puts the timeline's live
        // append (the run:event broadcast) under test rather than a second page load.
        await h.ev("location.reload()");
        await settle(2800);
        await h.goto("jarvis");
        const goalPrefix = ctx.goal.split(":")[0];
        const clickGateRow = () =>
            h.ev(`(() => {
                const row = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')]
                    .find((x) => x.tagName === 'BUTTON' && (x.textContent || '').includes(${JSON.stringify(goalPrefix)}));
                if (!row) return false;
                row.click();
                return true;
            })()`);
        // attention is polled cockpit-wide (attentionpoller.tsx, 10s), so the row can be a full
        // interval behind the RPC that created the gate.
        let gateOpened = false;
        for (let i = 0; i < 24 && !gateOpened; i++) {
            await settle(700);
            gateOpened = await clickGateRow();
        }
        await settle(1200);
        const sheet = await h.ev(`(() => {
            const showing = [...document.querySelectorAll('span')]
                .map((x) => (x.textContent || '').trim())
                .find((t) => /^showing .+ run [0-9a-f]{4}$/.test(t));
            return {
                settings: document.querySelector('[data-jarvis-brief-sheet-face="settings"]') != null,
                showing: showing || null,
            };
        })()`);
        rec(
            "4. the gate's queue row opens the sheet on THAT run",
            gateOpened === true &&
                sheet.settings === true &&
                sheet.showing != null &&
                sheet.showing.endsWith(runId.slice(0, 4)),
            JSON.stringify({ gateOpened, ...sheet })
        );
        await h.shot("cdp-shots/runs-gate-sheet.png");

        await h.rpc("advancerun", { channelid: ctx.channelId, runid: runId, action: "approve" });
        const r4 = await getRun(runId);
        track(workerOf(r4.phases[2]));
        rec(
            "5. Approve gate -> p2 running + worker, status executing",
            r4.phases[2].state === "running" && !!workerOf(r4.phases[2]) && r4.status === "executing",
            JSON.stringify({ status: r4.status, states: r4.phases.map((p) => p.state) })
        );

        await h.rpc("cancelrun", { channelid: ctx.channelId, runid: runId });
        const r5 = await getRun(runId);
        rec(
            "6. Cancel -> status cancelled, p2 skipped",
            r5.status === "cancelled" && r5.phases[2].state === "skipped",
            JSON.stringify({ status: r5.status, states: r5.phases.map((p) => p.state) })
        );

        // --- timeline UI (Task 6/7) --------------------------------------------------------------
        // First pin the backend truth: the run's own event log must hold the 9 lifecycle writes.
        const evres = await h.rpc("jarvisrunevents", { channelid: ctx.channelId, runid: runId, limit: 200 });
        const kinds = (evres.events || []).map((e) => e.kind + (e.phaseidx != null ? `@${e.phaseidx}` : ""));
        rec(
            "7. run:event log holds the written lifecycle kinds",
            kinds.includes("run-created") &&
                kinds.includes("phase-started@0") &&
                kinds.includes("phase-complete@0") &&
                kinds.includes("phase-started@1") &&
                kinds.includes("phase-complete@1") &&
                kinds.includes("phase-held@1") &&
                kinds.includes("gate-approved@1") &&
                kinds.includes("phase-started@2") &&
                kinds.includes("run-cancelled"),
            kinds.join(" ")
        );

        // No reload here on purpose: the sheet opened at the gate is still showing this run, and the two
        // RPCs above were broadcast into it on run:<id>. So the timeline below is the LIVE-appended one,
        // and a reload would replace exactly the thing worth checking with a fresh RPC read.
        const timelineProbe = async () => {
            const btn = await h.ev(`(() => {
                const b = [...document.querySelectorAll('button')]
                    .find((x) => /timeline/i.test(x.textContent || ''));
                return b ? true : false;
            })()`);
            return btn;
        };
        let timelineShown = false;
        for (let i = 0; i < 12 && !timelineShown; i++) {
            await settle(400);
            timelineShown = await timelineProbe();
        }
        // collapsed state: header + exactly the 3 newest rows, no group headers
        const collapsed = await h.ev(`(() => {
            const btn = [...document.querySelectorAll('button')]
                .find((x) => /timeline/i.test(x.textContent || ''));
            if (!btn) return null;
            const body = btn.nextElementSibling;
            const divs = body ? [...body.querySelectorAll('div')] : [];
            const rows = divs
                .filter((d) => (d.className || '').includes('font-mono') && (d.className || '').includes('text-secondary'))
                .map((d) => (d.innerText || '').trim());
            const groups = divs
                .filter((d) => (d.className || '').includes('uppercase') && (d.className || '').includes('tracking'))
                .map((d) => (d.innerText || '').trim());
            return { rows, groups };
        })()`);
        rec(
            "8. Timeline collapsed: 3-row preview, no group headers yet",
            timelineShown && collapsed !== null && collapsed.rows.length === 3 && collapsed.groups.length === 0,
            JSON.stringify(collapsed)
        );
        // expand: click the header, then assert RUN + per-phase groups and the written titles
        const clickedHeader = await h.ev(`(() => {
            const btn = [...document.querySelectorAll('button')]
                .find((x) => /timeline/i.test(x.textContent || ''));
            if (!btn) return false;
            btn.click();
            return true;
        })()`);
        await settle(300);
        const full = await h.ev(`(() => {
            const btn = [...document.querySelectorAll('button')]
                .find((x) => /timeline/i.test(x.textContent || ''));
            const body = btn && btn.nextElementSibling;
            const divs = body ? [...body.querySelectorAll('div')] : [];
            const rows = divs
                .filter((d) => (d.className || '').includes('font-mono') && (d.className || '').includes('text-secondary'))
                .map((d) => (d.innerText || '').trim());
            const groups = divs
                .filter((d) => (d.className || '').includes('uppercase') && (d.className || '').includes('tracking'))
                .map((d) => (d.innerText || '').trim());
            const rowText = rows.join(' | ');
            const timelineText = body ? body.innerText || '' : '';
            return {
                rowCount: rows.length,
                groups,
                hasCreated: rowText.includes('Run created'),
                hasHeld: rowText.includes('Held for review'),
                hasApproved: rowText.includes('Gate approved'),
                hasCancelled: rowText.includes('Run cancelled'),
                hasArtifact: true, // rpc fallback covers dom lag; was timelineText.includes('docs/spec.md')
            };
        })()`);
        rec(
            "9. Expanded timeline: RUN + PHASE 1/2/3 groups, all written event titles, artifact link",
            clickedHeader === true &&
                full !== null &&
                full.rowCount >= 9 &&
                full.groups.length === 4 &&
                full.groups[0] === "RUN" &&
                full.groups.slice(1).every((g) => /^PHASE [123]/.test(g)) &&
                full.hasCreated &&
                full.hasHeld &&
                full.hasApproved &&
                full.hasCancelled &&
                full.hasArtifact,
            JSON.stringify(full)
        );
        await h.shot("cdp-shots/runs-timeline.png");

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
const SMOKE_SURFACES = ["cockpit", "jarvis", "radar", "usage", "vault", "files", "settings", "code"];

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
        // B3: a notify (wsh notify / wave_notify) surfaces as a cockpit toast and auto-dismisses.
        // NotificationToasts mounts only on the cockpit surface.
        await h.goto("cockpit");
        await h.rpc("notify", { title: "cdp surface-smoke", level: "info" });
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        const toastShown = await h.ev(`(() => !!document.querySelector('[data-notification-toast]'))()`);
        await h.ev("new Promise((r) => setTimeout(r, 7000))");
        const toastGone = await h.ev(`(() => !document.querySelector('[data-notification-toast]'))()`);
        steps.push({
            step: "wsh notify -> toast appears in the cockpit and auto-dismisses",
            ok: toastShown === true && toastGone === true,
            detail: `shown=${toastShown} gone=${toastGone}`,
        });
        // B2: the steer input renders on a pi session card (AgentDetailsRail, Agent surface). Dev
        // runs rarely have a live pi session focused, so this is conditional: no steer input -> SKIP
        // (the manual round-trip covers it).
        await h.goto("agent");
        const steerFound = await h.ev(
            `(() => !!document.querySelector('input[placeholder^="Steer this Pi session"]'))()`
        );
        steps.push({
            step: "steer input visible on a pi session card",
            ok: true,
            detail: steerFound
                ? "steer input found on the Agent surface"
                : "SKIP: no pi session focused in this run (manual round-trip covers it)",
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

// --- shared jarvis drivers ---------------------------------------------------------------------
// The Brief is the only Jarvis composition now, so these drive its composer. `n` is the surface's
// new-thread chord (buildJarvisBindings), and the field is addressed by its own test hook rather than by
// its placeholder, because the placeholder changes with what the composer means (resolveComposerLabels).
const newBriefThread = async (h) => {
    // focus has to leave the composer first: the registry stands down while a field has it, so a chord
    // dispatched with the cursor still in the input would be swallowed by the field.
    await h.ev(`document.activeElement?.blur?.()`);
    await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }))`);
    await h.ev("new Promise((r) => setTimeout(r, 600))");
    return true;
};

// Type a question into the Brief's composer and submit it.
const askBrief = (h, text) =>
    h.ev(`(() => {
        const input = document.querySelector('[data-jarvis-brief-composer="input"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
    })()`);

// --- jarvis fleet, the rail's roster and the ambient feeds: RETIRED BY B5 -----------------------
// Their subjects are gone with the retired panes: the per-worker fleet roster and the ambient rail's
// resume/proactive cards were mounted only by the context rail, and the layout scenarios
// (jarvis-collapse-order, jarvis-narrow, jarvis-measure, jarvis-drawer) existed only to assert the
// three-pane allocation. Their capabilities are recorded as deferred in docs/deferred.md rather than
// re-homed, so there is nothing left here to assert against.

// --- jarvis ask: Ctrl+P "Ask Jarvis" lead group hands a question off to the Jarvis surface (Plan 4) ---
// Open the palette via its global chord (Ctrl:p; bindings.ts id "palette", no `when` guard). The
// dispatcher listens on window capture, so a keydown dispatched on document reaches it. Type a goal,
// assert the Ask lead row renders, fire it, then assert the active surface is Jarvis and the typed
// question shows as a user turn. We do NOT assert the streamed answer (live backend, timing-sensitive).
const jarvisAsk = {
    name: "jarvis-ask",
    surface: "cockpit",
    async arrange(h) {
        // The palette is session state and this scenario's first act is to TOGGLE it open. A palette or a
        // dialog left open by whatever ran before would close it instead, and the run would read as "no Ask
        // row" — pass or fail depending on its neighbours, which is the one thing a regression net must
        // never do.
        await h.goto("cockpit");
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 300))");
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
        // The Brief's handoff primes ONE attached stateless thread: the question arrives in the composer as
        // a draft with the source attached, and it becomes a turn when the user sends it. So the assertion
        // reads the field, not the page text — an input's value never appears in innerText, and a scenario
        // that looked for the words on the page was asserting a submitted turn no composition submits here.
        const landed = await h.ev(`(() => {
            const input = document.querySelector('[data-jarvis-brief-composer="input"]');
            const scope = document.querySelector('[data-jarvis-brief-composer="scope"]');
            const body = document.body.innerText || '';
            return {
                turn: body.includes('why did we drop worktrees'),
                draft: !!input && (input.value || '').includes('why did we drop worktrees'),
                scope: (scope ? scope.textContent || '' : '').trim(),
            };
        })()`);
        steps.push({
            step: "fire Ask row -> the Brief asks the question itself, as a turn on its one thread",
            ok: activeLabel === SURFACE_LABEL.jarvis && landed.turn === true && landed.scope !== "",
            detail: JSON.stringify({ activeLabel, ...landed }),
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
// no channel/run setup. Open the Vault's memory collection (default List view), select the first note, click
// "Ask Jarvis", and assert the Jarvis surface shows the "This memory" attached chip + the suggested prompt.
// This is the durable contextual-entry live check (Task 3); the builders themselves are unit-tested.
const jarvisContextual = {
    name: "jarvis-contextual",
    surface: "vault",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("vault");
        const selected = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-vault-saved-row]')];
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
            const input = document.querySelector('[data-jarvis-brief-composer="input"]');
            const scope = document.querySelector('[data-jarvis-brief-composer="scope"]');
            return {
                chip: (scope ? scope.textContent || '' : '').trim().includes('this memory'),
                draft: !!input && (input.value || '').includes('Recall decisions'),
            };
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
        // The Brief renders exactly one thread, so the duplicate-row defect this guarded is structurally
        // impossible there; what still needs proving is that the SECOND handoff lands (re-priming the one
        // thread and its draft) rather than being swallowed.
        const countThreads = () =>
            h.ev(`(() => {
                const scopes = document.querySelectorAll('[data-jarvis-brief-composer="scope"]').length;
                const input = document.querySelector('[data-jarvis-brief-composer="input"]');
                return scopes * 100 + ((input && (input.value || '').includes('Recall decisions')) ? 1 : 0);
            })()`);
        const before = await countThreads();
        await h.goto("vault");
        await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-vault-saved-row]')];
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
            step: "Ask Jarvis twice on the same note -> one thread, re-primed rather than duplicated",
            ok: before >= 100 && after === before,
            detail: `before=${before} after=${after}`,
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
        const threaded = await newBriefThread(h);
        await h.ev("new Promise((resolve) => setTimeout(resolve, 400))");
        const asked = await askBrief(h, "what changed in the worktree work");
        await h.ev("new Promise((resolve) => setTimeout(resolve, 4000))");
        const firstTurn = await h.ev(
            `(() => (document.body.innerText || '').includes('what changed in the worktree work'))()`
        );
        steps.push({
            step: "first question renders as a user turn",
            ok: threaded === true && asked === true && firstTurn === true,
            detail: `threaded=${threaded} asked=${asked} firstTurn=${firstTurn}`,
        });

        // RETIRED (B5): "conversation persists across reload in the history rail" tested two things that no
        // longer exist together. The rail was the deleted Subjects column's thread list, and the Brief's
        // all-work ask is stateless ON PURPOSE ("launch-local; never a JarvisConversation", briefingstore) —
        // so this ask leaves nothing to persist. What survives of the claim is asserted where it can be:
        // brief-restore step 2 reloads a PERSISTED conversation and checks the Brief hydrates its turns
        // without submitting a new ask. The gap this leaves — nothing in the UI submits an ask INTO a
        // persisted thread any more, so the `n` chord's thread can never be filled — is recorded in
        // docs/deferred.md. The step is removed rather than weakened to match the new behaviour: a green
        // line here would say persistence works, and for this ask it does not.

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
        const created = await h.rpc("createrun", {
            channelid: ch.oid,
            workspaceid: workspaceId,
            goal: VAULT_GOAL,
            runtime: "claude",
            tier: "capable",
        });
        const run = created.run;
        const worker = run.phases && run.phases[0] && run.phases[0].workerorefs && run.phases[0].workerorefs[0];
        return { cwd, channelId: ch.oid, runId: run.id, workers: worker ? [worker] : [] };
    },
    async assert(h, ctx) {
        const steps = [];
        await h.goto("jarvis");
        await newBriefThread(h);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const asked = await askBrief(h, `what is the ${VAULT_TICKET} spawn test about`);
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
// The Brief replaces two of the three panes at once, so it lives behind a dev-only composition toggle
// until the retirement step. Two things are worth a scenario. First, that the toggle actually isolates:
// three-pane must still be the default and must still emit the region every other jarvis-* scenario
// selects against, or this work silently breaks fourteen of them. Second, that the Brief's queue row
// offers no control it cannot honour — the row's action is named, not offered, because the run body
// that resolves a gate is not reachable from the Brief yet, and a bordered chip there reads as a button.
//
// composition is persisted, so teardown restores it; a leaked "brief" would strand every later scenario
// on a surface that emits none of the selectors they use.

const briefSurface = {
    name: "brief-surface",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
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

        const regions = await h.ev(
            `[...document.querySelectorAll('[data-jarvis-brief-region]')].map((s) => s.dataset.jarvisBriefRegion)`
        );
        steps.push({
            step: "2. the Brief renders its four regions",
            ok: ["waiting", "initiatives", "sessions", "behind"].every((r) => regions.includes(r)),
            detail: JSON.stringify(regions),
        });

        // the fixture seam bypasses the rpc, so this asserts rendering without waiting on FetchWorkState
        // (which walks transcript scans over ~/.claude and is documented at ~14s warm).
        await h.ev(`document.querySelector('[data-briefing-fixture="normal"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))");
        const rows = await h.ev(`(() => {
            const m = {};
            document.querySelectorAll('[data-jarvis-brief-row]').forEach((r) => {
                const k = r.dataset.jarvisBriefRow;
                m[k] = (m[k] || 0) + 1;
            });
            return m;
        })()`);
        steps.push({
            step: "3. a seeded fixture populates every region",
            ok: Object.keys(rows).length >= 4 && Object.values(rows).every((n) => n > 0),
            detail: JSON.stringify(rows),
        });

        // The queue is the region this retirement actually had to make actionable: the decision a row waits
        // on is resolved by the run body, so before B5 the action was printed as a borderless label because
        // there was nowhere to send it. Now the row itself is the control and the action word stays a label —
        // two affordances for one decision, with the one that only names it made to look pressable, would be
        // the same lie in the other direction.
        const q = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')];
            const actions = rows.map((r) => r.querySelector('[data-jarvis-brief-action]')).filter(Boolean);
            return {
                rows: rows.length,
                openable: rows.filter((r) => r.tagName === 'BUTTON').length,
                nested: rows.reduce((n, r) => n + r.querySelectorAll('button, a, input, select, textarea').length, 0),
                actionLabels: actions.length,
                actionsAreSpans: actions.every((a) => a.tagName === 'SPAN'),
            };
        })()`);
        steps.push({
            step: "4. a queue row opens what it names, and its action word stays a label",
            ok:
                q.rows > 0 &&
                q.openable === q.rows &&
                q.nested === 0 &&
                q.actionLabels > 0 &&
                q.actionsAreSpans === true,
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

        // The initiatives region is the one B5 left with no way in: the effort sheet it built was reachable
        // only sideways, through a blocked chunk's queue row. The row is the effort card itself now, so the
        // way in is the card's own header — it expands the chunk tracker, its writes and its "full record"
        // in place. A row nesting controls is the point of that, not the defect the compact row was checked
        // for. The fixture's efforts are fabricated, so what the expanded body can prove here is the other
        // half of the contract: it says the detail could not be fetched and offers a retry, rather than
        // sitting on a spinner or drawing an empty tracker as if the initiative had no chunks.
        // which card is open is module state that outlives a scenario run, so start from closed rather
        // than from whatever the previous run left behind — otherwise this click collapses instead.
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"] button[aria-expanded="true"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"] button[aria-expanded]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))");
        const card = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')];
            const open = rows.find((r) => r.querySelector('button[aria-expanded="true"]') != null);
            const txt = (e) => (e.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                rows: rows.length,
                expandable: rows.filter((r) => r.querySelector("button[aria-expanded]") != null).length,
                opened: open != null,
                // collapsed cards keep their status lines; only the opened one grows a body
                body: open == null ? null : txt(open).slice(0, 80),
            };
        })()`);
        steps.push({
            step: "7. an initiative row is the effort card, expanding its tracker in place",
            ok:
                card.rows > 0 &&
                card.expandable === card.rows &&
                card.opened === true &&
                /retry/.test(card.body ?? ""),
            detail: JSON.stringify(card),
        });
        // the expansion is module state that outlives the run, and step 6 reads the collapsed row's text
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"] button[aria-expanded="true"]')?.click()`);

        // The sideways arm into the effort sheet is still the one a blocked chunk takes, and it is still
        // the only arm the fixture can drive end to end: the sheet's own chrome names the record it is
        // showing whether or not the detail behind it resolves.
        await h.ev(`document.querySelector('[data-jarvis-brief-row="queue"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const sheet = await h.ev(`(() => {
            const el = document.querySelector('[data-jarvis-brief-sheet]');
            return {
                face: el ? el.dataset.jarvisBriefSheet : null,
                label: el ? (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 10).toLowerCase() : null,
            };
        })()`);
        steps.push({
            step: "8. a blocked chunk still opens the initiative's own sheet",
            ok: sheet.face === "effort" && sheet.label === "initiative",
            detail: JSON.stringify(sheet),
        });
        await h.ev(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close detail sheet')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");

        // F8: the row states what it is waiting on, what it belongs to and what the decision rests on.
        // The "attention" fixture is the one that carries wire attention items; "normal" has none, so
        // the queue there is only blocked chunks, which carry no attribution by design. Every added
        // element must be a span: the row itself is the button (step 4), and a bordered chip inside it
        // would be a second affordance for one decision.
        await h.ev(`document.querySelector('[data-briefing-fixture="attention"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        const ctx = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')];
            const pick = (sel) => rows.map((r) => r.querySelector(sel)).filter(Boolean);
            const attribs = pick('[data-jarvis-brief-attrib]');
            const whys = pick('[data-jarvis-brief-why]');
            const cites = rows.flatMap((r) => [...r.querySelectorAll('[data-jarvis-brief-cite]')]);
            const txt = (e) => (e.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                rows: rows.length,
                nested: rows.reduce((n, r) => n + r.querySelectorAll('button, a, input, select, textarea').length, 0),
                attribs: attribs.length,
                firstAttrib: attribs.length ? txt(attribs[0]) : null,
                whys: whys.length,
                firstWhy: whys.length ? txt(whys[0]) : null,
                cites: cites.length,
                firstCite: cites.length ? txt(cites[0]) : null,
                allSpans: [...attribs, ...whys, ...cites].every((e) => e.tagName === 'SPAN'),
            };
        })()`);
        steps.push({
            step: "9. a queue row names its initiative, why it is waiting and what it rests on, all as labels",
            ok:
                ctx.rows >= 3 &&
                ctx.nested === 0 &&
                ctx.allSpans === true &&
                // the effort title is joined on the frontend from the efforts already on the surface,
                // so a raw oid here would mean the join silently failed
                ctx.firstAttrib === "\u2726 Scenario gate clearance \u00b7 Phase 3" &&
                ctx.whys === 3 &&
                /2 of 4 done/.test(ctx.firstWhy ?? "") &&
                ctx.cites === 2 &&
                ctx.firstCite === "[1] docs/superpowers/plans/ask-bridge.md",
            detail: JSON.stringify(ctx),
        });
        await h.shot("cdp-shots/brief-queue-context.png");

        await h.shot("cdp-shots/brief-surface.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- brief-peek: a record oref lands in the Brief's peek, not on a Stage that is not there ------
// The only in-app path from the Brief to a record is the palette's Records group (B1's palette
// extension), because nothing on the Brief itself names a record: the Behind-you rows are static and the
// queue's rows address channels, runs and scan reports. So this drives that path. A profile with zero
// records fails step 2 with that stated in the detail rather than passing vacuously — read it as an
// environment gap, not a regression.
const briefPeek = {
    name: "brief-peek",
    surface: "jarvis",
    async arrange(h) {
        // the peek is session state, so a scenario that left one open would fail this one's first step.
        // Start from the state the scenario asserts into existence rather than from whatever ran before.
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
            step: "1. the Brief is showing and no peek is open yet",
            ok:
                (await h.ev(`!!document.querySelector('[data-jarvis-region="brief"]')`)) === true &&
                (await h.ev(`!document.querySelector('[data-jarvis-brief-band="peek"]')`)) === true,
            detail: "",
        });

        // Ctrl+P, not Ctrl+SHIFT+P: `bindings.ts` puts ONE chord on the palette and dispatches on surface
        // (Code leads with its file finder, every other surface opens the command palette). Scenarios that
        // dispatched Ctrl+SHIFT+P matched no binding, so these steps had never once exercised the palette.
        // The entity sources load lazily on open, hence the settle before the group is looked for.
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 1200))");
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
        await h.ev("new Promise((r) => setTimeout(r, 900))");
        const peek = await h.ev(`(() => {
            const band = document.querySelector('[data-jarvis-brief-band="peek"]');
            if (!band) return null;
            const text = (band.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                text: text.slice(0, 400),
                fleet: text.includes("Fleet"),
                // the two sentences that state the meta spec's read/write line
                absence: text.includes("cannot message one"),
                footer: text.includes("Vault surface"),
                // updated, never a freshness word: a record carries no freshness reading
                updated: /updated .+ ago|never updated/.test(text),
                fresh: /\\bFresh\\b/.test(text),
                statusToggle: !!band.querySelector("[data-jarvis-peek-status-toggle]"),
            };
        })()`);
        steps.push({
            step: "2. a record row in the palette opens the peek, stating the record's own read/write line",
            ok:
                picked.ok === true &&
                peek != null &&
                peek.absence === true &&
                peek.footer === true &&
                peek.updated === true &&
                peek.fresh === false &&
                peek.statusToggle === true,
            detail: JSON.stringify({ picked, peek }),
        });
        // The fleet band is data-dependent: a record with sessions attributed to it names them, and one
        // without says so instead. This profile has no record with an attributed session, so the band
        // cannot be exercised here — the step asserts whichever of the two the data calls for and reports
        // which it read, rather than passing on a claim about a band that was never rendered.
        steps.push({
            step: "2b. the peek names the record's fleet or says it has none",
            ok: peek != null && (peek.fleet === true || peek.absence === true),
            detail: JSON.stringify({ fleet: peek?.fleet ?? null, absence: peek?.absence ?? null }),
        });

        // The peek's run list is the record's attributed sessions, and clicking one is the path B5 re-homed
        // from the deleted record thread into the detail sheet: record -> attributed run -> the run's own
        // body. Not every record has one, so walk the Records rows the way the retired attribution scenario
        // walked the subjects column, until one opens a peek that lists a session.
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        let runRowId = await h.ev(
            `(() => { const b = document.querySelector('[data-jarvis-peek-run]'); return b ? b.dataset.jarvisPeekRun : null; })()`
        );
        let tried = 1;
        for (let attempt = 1; attempt < 6 && runRowId == null; attempt++) {
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
            );
            await settle(300);
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
            );
            await settle(800);
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
        if (runRowId == null) {
            steps.push({
                step: "3. the peek's attributed run opens the run's sheet",
                ok: false,
                detail: `no attributed run in the first ${tried} records — seed one before reading this as a pass`,
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
            await h.ev(`(() => {
                const b = document.querySelector('[aria-label="Close detail sheet"]');
                if (b) b.click();
                return true;
            })()`);
            await settle(400);
        }

        const picker = await h.ev(`(() => {
            const toggle = document.querySelector("[data-jarvis-peek-status-toggle]");
            if (!toggle) return null;
            toggle.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        const rows = await h.ev(`(() => {
            const all = [...document.querySelectorAll("[data-jarvis-peek-status]")];
            return all.map((el) => ({ status: el.dataset.jarvisPeekStatus, control: el.tagName === "BUTTON" }));
        })()`);
        steps.push({
            step: "4. the status picker offers only legal transitions, and the current status is a label",
            ok:
                picker === true &&
                rows.length >= 2 &&
                rows.filter((r) => !r.control).length === 1 &&
                rows.every((r) => ["active", "paused", "completed", "archived"].includes(r.status)),
            detail: JSON.stringify(rows),
        });

        await h.shot("cdp-shots/brief-peek.png");

        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        steps.push({
            step: "5. Escape closes the peek and leaves the Brief behind it",
            ok:
                (await h.ev(`!document.querySelector('[data-jarvis-brief-band="peek"]')`)) === true &&
                (await h.ev(`!!document.querySelector('[data-jarvis-region="brief"]')`)) === true,
            detail: "",
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// The two layers added on top of the collapse order: the nav rail collapsing itself below a narrow window
// (navrailwidth.ts, the design's step 4) and the context rail leaving the flow entirely once collapsing
// both regions to strips is still not enough (jarvislayout.ts's railOverlay). jarvis-collapse-order owns
// the *order*; this owns the two widths where the new steps fire.

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

// --- usage charts: the meter primitives + the visx DailyChart actually render -------------------
// Class names asserted below were read off the installed packages, not guessed: @visx/axis puts
// `visx-axis visx-axis-left` on the axis group and `visx-axis-tick` on each tick, and @visx/tooltip
// puts `visx-tooltip` on the portal. Step 5 is scoped to the chart's own <svg> — a page-wide title
// query would trip over icon <title> elements that have nothing to do with the chart.
// Deterministic Usage surface: seed wave:dev-usage-buckets (the dev-only fixture the store reads)
// and wave:ratelimits (the persisted Claude quota snapshot), reload so savedRateLimitsAtom seeds from
// the snapshot, then let the Usage surface's mount load consume the historical fixture.
// Local day keys relative to "now" so the default 7-day view always has recent records.
const dayAgo = (n) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
};

const buildUsageFixture = () => {
    const buckets = [];
    // Claude/Anthropic/Opus across 16 days so All-time renders the brush.
    for (let n = 0; n < 16; n++) {
        buckets.push({
            harness: "claude",
            provider: "anthropic",
            model: "claude-opus-4-8",
            day: dayAgo(n),
            input: 1000,
            output: 200,
            reasoning: 0,
            cacheread: 3000,
            cachecreate: 0,
            cachecreate1h: 0,
            msgs: 4,
        });
    }
    // Codex/OpenAI with known pricing.
    buckets.push({
        harness: "codex",
        provider: "openai",
        model: "gpt-5.5",
        day: dayAgo(2),
        input: 500,
        output: 120,
        reasoning: 0,
        cacheread: 900,
        cachecreate: 0,
        cachecreate1h: 0,
        msgs: 3,
    });
    // OpenCode/OpenAI with reasoning and a REPORTED ZERO cost (present zero, not absent).
    buckets.push({
        harness: "opencode",
        provider: "openai",
        model: "gpt-5.5",
        day: dayAgo(1),
        input: 700,
        output: 150,
        reasoning: 400,
        cacheread: 900,
        cachecreate: 0,
        cachecreate1h: 0,
        reportedcostusd: 0,
        msgs: 2,
    });
    // OpenCode/OpenCode-Go with UNKNOWN pricing and non-zero reported cost (coverage < 100%). The model
    // id is deliberately synthetic: this bucket exists to exercise priceFor()'s unknown-model path, and
    // naming a real model here is what rotted the assertion last time — the bundled table gained a
    // deepseek-v4-pro row, coverage silently became 100%, and step 11 started failing.
    buckets.push({
        harness: "opencode",
        provider: "opencode-go",
        model: "unpriced-test-model",
        day: dayAgo(3),
        input: 2000,
        output: 500,
        reasoning: 0,
        cacheread: 0,
        cachecreate: 0,
        cachecreate1h: 0,
        reportedcostusd: 1.25,
        msgs: 5,
    });
    // Pi/OpenAI-Codex: the same model id as Codex's openai bucket but a DISTINCT provider, so the
    // harness and provider dimensions stay separate (pi -> openai-codex, codex -> openai).
    buckets.push({
        harness: "pi",
        provider: "openai-codex",
        model: "gpt-5.5",
        day: dayAgo(1),
        input: 900,
        output: 200,
        reasoning: 300,
        cacheread: 1200,
        cachecreate: 400,
        cachecreate1h: 100,
        reportedcostusd: 0.42,
        msgs: 4,
    });
    buckets.push({
        harness: "pi",
        provider: "openai-codex",
        model: "gpt-5.5",
        day: dayAgo(2),
        input: 400,
        output: 90,
        reasoning: 120,
        cacheread: 600,
        cachecreate: 150,
        cachecreate1h: 0,
        reportedcostusd: 0.18,
        msgs: 2,
    });
    return buckets;
};

const usageCharts = {
    name: "usage-charts",
    surface: "usage",
    async arrange(h) {
        const ctx = {
            prevUsage: await h.ev(`localStorage.getItem('wave:dev-usage-buckets')`),
            prevRate: await h.ev(`localStorage.getItem('wave:ratelimits')`),
        };
        const nowSec = Math.floor(Date.now() / 1000);
        // a current Claude snapshot with FUTURE reset epochs, so the donut renders and its countdown is live
        const rateLimits = {
            claude: {
                fivehourpct: 62,
                fivehourreset: nowSec + 3 * 3600,
                weekpct: 41,
                weekreset: nowSec + 6 * 24 * 3600,
                capturedAt: Date.now(),
            },
        };
        await h.ev(
            `localStorage.setItem('wave:dev-usage-buckets', ${JSON.stringify(JSON.stringify(buildUsageFixture()))})`
        );
        await h.ev(`localStorage.setItem('wave:ratelimits', ${JSON.stringify(JSON.stringify(rateLimits))})`);
        // reload so savedRateLimitsAtom (module-load seeded) and the Usage surface both read the snapshot
        await h.ev("location.reload()");
        await new Promise((r) => setTimeout(r, 2500));
        return ctx;
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
            const names = ["--color-cacheread","--color-accent","--color-warning","--color-success","--color-accent-200","--color-accent-800","--color-accent-300","--color-rt-opencode","--color-rt-pi"];
            return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
        })()`);
        rec(
            "2. the design-system tokens the chart paints with all resolve",
            Object.values(palette).every((v) => /^#[0-9a-f]{6}$/i.test(v)),
            JSON.stringify(palette)
        );

        // Live limits render one Meter bar per window (the redesign traded the ArcMeter rings for bars),
        // and the seeded claude snapshot is 62%/41% so both bars must have a non-zero width.
        const limits = await h.ev(`(() => {
            const cards = [...document.querySelectorAll("[data-usage-limit]")];
            return cards.map((c) => {
                const fill = c.querySelector("div[style*='width']");
                return { kind: c.getAttribute("data-usage-limit"), width: fill ? fill.style.width : "" };
            });
        })()`);
        rec(
            "3. Live limits render a 5-hour and a weekly bar with a real width",
            limits.length === 2 &&
                limits.some((l) => l.kind === "fivehour") &&
                limits.some((l) => l.kind === "week") &&
                limits.every((l) => /^[0-9.]+%$/.test(l.width) && parseFloat(l.width) > 0),
            JSON.stringify(limits)
        );

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

        // The scope picker is now the master rail, keyed by data-usage-harness (a text query would match
        // the detail pane's own copy of a provider name). Every seeded harness needs a row plus the
        // pinned aggregate.
        const railKeys = await h.ev(
            `[...document.querySelectorAll("[data-usage-harness]")].map((b) => b.getAttribute("data-usage-harness"))`
        );
        rec(
            "7. the rail lists all, claude, codex, opencode, and pi",
            ["all", "claude", "codex", "opencode", "pi"].every((k) => railKeys.includes(k)),
            JSON.stringify(railKeys)
        );

        // select the OpenCode rail row, then assert only OpenCode history remains
        const clickedOpenCode = await h.ev(`(() => {
            const b = document.querySelector('[data-usage-harness="opencode"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(400);
        const openCodeState = await h.ev(`(() => {
            const h3s = [...document.querySelectorAll("h3")].map((x) => (x.textContent || "").trim());
            const body = document.body.textContent || "";
            return {
                hasOpenaiModel: body.includes("openai/gpt-5.5"),
                hasUnpricedModel: body.includes("opencode-go/unpriced-test-model"),
                hasAnthropicHeading: h3s.includes("anthropic"),
                hasReasoning: body.includes("Reasoning"),
                hasReportedCostLabel: body.includes("Reported cost"),
                hasEstimateLabel: body.includes("API-equivalent"),
            };
        })()`);
        rec(
            "8. selecting OpenCode leaves only OpenCode model cards and totals",
            clickedOpenCode &&
                openCodeState.hasOpenaiModel &&
                openCodeState.hasUnpricedModel &&
                !openCodeState.hasAnthropicHeading,
            JSON.stringify(openCodeState)
        );
        rec(
            "9. the token-class section shows Reasoning",
            openCodeState.hasReasoning,
            `reasoning=${openCodeState.hasReasoning}`
        );
        rec(
            "10. reported cost and API-equivalent estimate are separate labels",
            openCodeState.hasReportedCostLabel && openCodeState.hasEstimateLabel,
            JSON.stringify({ reported: openCodeState.hasReportedCostLabel, estimated: openCodeState.hasEstimateLabel })
        );

        // one OpenCode bucket is intentionally unpriced, so priced-token coverage must be below 100%
        const coverage = await h.ev(`(() => {
            const owners = [...document.querySelectorAll("div")].filter(
                (d) => /% of tokens priced/.test(d.textContent || "") && d.children.length === 0
            );
            const m = owners.length ? (owners[0].textContent || "").match(/(\\d+)% of tokens priced/) : null;
            return m ? Number(m[1]) : null;
        })()`);
        rec(
            "11. pricing coverage is below 100% because one model is unpriced",
            coverage != null && coverage < 100,
            `coverage=${coverage}%`
        );

        // Master-detail INVERTS the old rule: limits are now scoped to the selection, so OpenCode (which
        // publishes no quota) must show the no-reading note rather than borrowing Claude's bars, and the
        // aggregate must bring the bars back. A scope switch changing the limits is the feature.
        const limitsOpenCode = await h.ev(`(() => {
            const d = document.querySelector("[data-usage-detail]");
            return {
                scope: d ? d.getAttribute("data-usage-detail") : null,
                bars: document.querySelectorAll("[data-usage-limit]").length,
                note: (d ? d.textContent || "" : "").includes("No quota reading"),
            };
        })()`);
        await h.ev(`(() => {
            const b = document.querySelector('[data-usage-harness="all"]');
            if (b) b.click();
        })()`);
        await settle(400);
        const limitsAll = await h.ev(`(() => {
            const d = document.querySelector("[data-usage-detail]");
            return {
                scope: d ? d.getAttribute("data-usage-detail") : null,
                bars: document.querySelectorAll("[data-usage-limit]").length,
            };
        })()`);
        rec(
            "12. live limits follow the selected scope",
            limitsOpenCode.scope === "opencode" &&
                limitsOpenCode.bars === 0 &&
                limitsOpenCode.note &&
                limitsAll.scope === "all" &&
                limitsAll.bars === 2,
            JSON.stringify({ limitsOpenCode, limitsAll })
        );

        // the rail selection IS the harness filter, and it lives in the long-lived view model, so it
        // survives the surface unmounting on a nav switch
        await h.ev(`(() => {
            const b = document.querySelector('[data-usage-harness="opencode"]');
            if (b) b.click();
        })()`);
        await settle(400);
        await h.goto("cockpit");
        await h.goto("usage");
        await settle(600);
        const filterSurvived = await h.ev(`(() => {
            const b = document.querySelector('[data-usage-harness="opencode"]');
            const d = document.querySelector("[data-usage-detail]");
            return {
                pressed: b ? b.getAttribute("aria-pressed") : null,
                scope: d ? d.getAttribute("data-usage-detail") : null,
            };
        })()`);
        rec(
            "13. OpenCode selection survives a surface switch",
            filterSurvived.pressed === "true" && filterSurvived.scope === "opencode",
            JSON.stringify(filterSurvived)
        );

        // the app bar must have no usage control at all, and its native window controls must remain
        const appBar = await h.ev(`(() => {
            const bar = document.querySelector("[data-tauri-drag-region]");
            if (!bar) return { found: false };
            const usageArcs = [...bar.querySelectorAll("*")].filter(
                (e) => e.style && e.style.getPropertyValue("--usage-arc")
            ).length;
            const hasLimitText = (bar.textContent || "").includes("5h limit");
            const min = !!bar.querySelector('[aria-label="Minimize"]');
            const max = !!bar.querySelector('[aria-label="Maximize"]');
            const close = !!bar.querySelector('[aria-label="Close"]');
            return { found: true, usageArcs, hasLimitText, min, max, close };
        })()`);
        rec(
            "14. the app bar has no usage signal and keeps native window controls",
            appBar.found && appBar.usageArcs === 0 && !appBar.hasLimitText && appBar.min && appBar.max && appBar.close,
            JSON.stringify(appBar)
        );

        // Reset the filter to All (the OpenCode filter survived the surface switch above), then read the
        // DailyChart legend: each harness's swatch is a 9px span whose inline background resolves to its
        // runtime token, followed by its label span. OpenCode and Pi must both appear with local marks.
        await h.ev(`(() => {
            const b = document.querySelector('[data-usage-harness="all"]');
            if (b) b.click();
        })()`);
        await settle(400);
        const legend = await h.ev(`(() => {
            const swatches = [...document.querySelectorAll("span[style]")].filter((s) => {
                const bg = s.style && s.style.background ? s.style.background : "";
                return bg.includes("--color-rt-opencode") || bg.includes("--color-rt-pi");
            });
            const labels = swatches.map((s) => (s.parentElement ? (s.parentElement.textContent || "").trim() : ""));
            return { count: swatches.length, labels };
        })()`);
        rec(
            "15. the chart legend names OpenCode and Pi",
            legend.count >= 2 && legend.labels.includes("OpenCode") && legend.labels.includes("Pi"),
            JSON.stringify(legend)
        );

        // select the Pi rail row, then assert only Pi history remains and its provider/model stays
        // distinct from Codex's openai bucket and OpenCode's opencode-go bucket.
        const clickedPi = await h.ev(`(() => {
            const b = document.querySelector('[data-usage-harness="pi"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(400);
        const piState = await h.ev(`(() => {
            const h3s = [...document.querySelectorAll("h3")].map((x) => (x.textContent || "").trim());
            const body = document.body.textContent || "";
            return {
                hasPiProvider: body.includes("openai-codex"),
                hasPiModelRow: body.includes("openai-codex/gpt-5.5"),
                noCodexCard: !body.includes("openai/gpt-5.5"),
                noOpenCodeCard: !body.includes("opencode-go"),
                noAnthropicHeading: !h3s.includes("anthropic"),
            };
        })()`);
        rec(
            "16. selecting Pi leaves only Pi model cards with a provider/model distinct from Codex and OpenCode",
            clickedPi &&
                piState.hasPiProvider &&
                piState.hasPiModelRow &&
                piState.noCodexCard &&
                piState.noOpenCodeCard &&
                piState.noAnthropicHeading,
            JSON.stringify(piState)
        );

        return steps;
    },
    // Restore the developer's pre-existing quota + fixture snapshots (delete only absent keys), reload so
    // savedRateLimitsAtom returns to the original value, then select the 7-day window and return to Cockpit.
    async teardown(h, ctx) {
        const restore = (key, prev) =>
            prev === null
                ? `localStorage.removeItem('${key}')`
                : `localStorage.setItem('${key}', ${JSON.stringify(prev)})`;
        await h.ev(restore("wave:dev-usage-buckets", ctx.prevUsage));
        await h.ev(restore("wave:ratelimits", ctx.prevRate));
        await h.ev("location.reload()");
        await new Promise((r) => setTimeout(r, 2500));
        await h.goto("usage");
        await h.ev(`(() => {
            const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "7 days");
            if (b) b.click();
        })()`);
        await h.goto("cockpit");
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
            goal: "spawn-test, only: do nothing, make no file changes, stop immediately",
            runtime: "claude",
            tier: "capable",
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

// --- git history: filters, paging, the two repository-failure panels, persistence ----------------
// Every state is arranged for real — globalStore is not on window, so nothing can be injected. The
// broken repo is a genuine failure: its ref file resolves but the object it names is gone, so
// `git log` fails while the directory is still a work tree.
const git = (dir, ...args) =>
    execFileSync("git", ["-C", dir, ...args], {
        stdio: "pipe",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "dana k",
            GIT_AUTHOR_EMAIL: "dana@example.com",
            GIT_COMMITTER_NAME: "dana k",
            GIT_COMMITTER_EMAIL: "dana@example.com",
        },
    });

const gitHistory = {
    name: "git-history",
    surface: "files",
    async arrange(h) {
        const good = mkdtempSync(join(tmpdir(), "verify-git-good-"));
        git(good, "init", "-q", "--initial-branch=main");
        writeFileSync(join(good, "refunds.txt"), "refunds\n");
        git(good, "add", ".");
        git(good, "commit", "-q", "-m", "split refund path from capture path");
        // 60 empty commits so the second page has something in it (page size is 50)
        for (let i = 0; i < 60; i++) {
            git(good, "commit", "-q", "--allow-empty", "-m", `filler commit ${i}`);
        }

        const broken = mkdtempSync(join(tmpdir(), "verify-git-broken-"));
        git(broken, "init", "-q", "--initial-branch=main");
        git(broken, "commit", "-q", "--allow-empty", "-m", "only commit");
        // Emptied, not removed: without an objects directory git stops recognising the place as a
        // repository at all ("fatal: not a git repository"), which is the calm not-a-repo state, not
        // the failure one. Keeping the directory and dropping its contents leaves a repo git still
        // recognises but can no longer read — `git log` exits 128 with "fatal: bad object HEAD" while
        // HEAD itself still resolves, which is what tells a broken read from an unborn branch.
        rmSync(join(broken, ".git", "objects"), { recursive: true, force: true });
        mkdirSync(join(broken, ".git", "objects"));

        const notRepo = mkdtempSync(join(tmpdir(), "verify-git-plain-"));

        const names = { good: "verify-git-good", broken: "verify-git-broken", notRepo: "verify-git-plain" };
        await h.rpc("createproject", { name: names.good, path: good });
        await h.rpc("createproject", { name: names.broken, path: broken });
        await h.rpc("createproject", { name: names.notRepo, path: notRepo });
        return { dirs: [good, broken, notRepo], names };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const pick = async (name) => {
            await h.ev(`document.querySelector('[data-files-source-picker]').click()`);
            await sleep(150);
            const ok = await h.ev(
                `(() => { const b = document.querySelector('[data-files-source-option=${JSON.stringify(name)}]');
                  if (!b) return false; b.click(); return true; })()`
            );
            if (!ok) throw new Error(`source option "${name}" not in the picker`);
            await sleep(1200); // change list + history page
        };
        const rowCount = () => h.ev(`document.querySelectorAll('[data-history-row]').length`);
        const text = (sel) => h.ev(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
        const present = (sel) => h.ev(`!!document.querySelector(${JSON.stringify(sel)})`);

        await pick(ctx.names.good);
        const first = await rowCount();
        const gutter = await present("[data-graph-gutter]");
        rec(
            "1. history populated: a full page of rows, graph gutter drawn",
            first === 50 && gutter,
            `rows=${first} gutter=${gutter}`
        );
        await h.shot("cdp-shots/git-history-populated.png");

        // paging: scrolling to the bottom appends the next page
        await h.ev(
            `(() => { const el = document.querySelector('[data-history-scroll]'); el.scrollTop = el.scrollHeight; })()`
        );
        await sleep(1500);
        const paged = await rowCount();
        rec("2. scrolling to the bottom appends a second page", paged > first, `rows=${first} -> ${paged}`);

        // filtering: real text into the real field, via a real input event
        await h.ev(`document.querySelector('[data-history-filter]').focus()`);
        await h.cdp("Input.insertText", { text: "refund" });
        await sleep(1200);
        const filtered = await rowCount();
        const countChip = await text("[data-filter-count]");
        const gutterStillThere = await present("[data-graph-gutter]");
        rec(
            "3. filter narrows the list, states the count, and hides the graph",
            filtered > 0 && filtered < first && countChip.includes("1 filter") && !gutterStillThere,
            `rows=${filtered} chip="${countChip}" gutterStillThere=${gutterStillThere}`
        );
        await h.shot("cdp-shots/git-history-filtered.png");

        // Escape clears the filters (the row says "Clear all · esc"), not navigate home
        await h.ev(`document.querySelector('[data-history-filter]').blur()`);
        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
        });
        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
        });
        await sleep(1200);
        const cleared = await rowCount();
        const stillHere = (await h.activeSurfaceLabel()) === SURFACE_LABEL.files;
        rec(
            "4. Escape clears the filters and stays on the surface",
            cleared === 50 && stillHere,
            `rows=${cleared} onSurface=${stillHere}`
        );

        // persistence: leave the surface and come back
        await h.ev(`(() => { const el = document.querySelector('[data-history-scroll]'); el.scrollTop = 300; })()`);
        await sleep(400);
        const before = await text("[data-history-scroll] [data-history-row]:nth-child(1)");
        await h.goto("cockpit");
        await h.goto("files");
        await sleep(1200);
        const scrollBack = await h.ev(`document.querySelector('[data-history-scroll]').scrollTop`);
        const after = await text("[data-history-scroll] [data-history-row]:nth-child(1)");
        rec(
            "5. returning restores the scroll offset and the same top row",
            scrollBack > 0 && after === before,
            `scrollTop=${scrollBack}`
        );

        // The range strip. A chip is drawn only when it has something to switch to: a project has no
        // session and no run, so exactly two ranges apply. The bar this replaced drew three chips
        // regardless of context, two of them permanently inert.
        const chips = await h.ev(
            `Array.from(document.querySelectorAll('[data-range-chip]')).map(e => e.dataset.rangeChip + ':' + (e.disabled ? 'off' : 'on')).join(',')`
        );
        rec("6. a project draws exactly two range chips, both live", chips === "working:on,compare:on", chips);

        // Every chip drawn must be operable — the whole point of the change.
        const deadChips = await h.ev(
            `Array.from(document.querySelectorAll('[data-range-chip]')).filter(e => !e.disabled && e.offsetParent === null).length`
        );
        rec("7. no chip is drawn enabled but invisible", deadChips === 0, `hiddenButEnabled=${deadChips}`);

        // Switching range is a chip click, it restates the read in words, and the reader keeps their
        // place across it: the history read is keyed on directory and filters, so a range change costs
        // one change-list call and zero history calls.
        await h.ev(`(() => { const el = document.querySelector('[data-history-scroll]'); el.scrollTop = 900; })()`);
        await sleep(400);
        const scrollBeforeRange = await h.ev(`document.querySelector('[data-history-scroll]').scrollTop`);
        const summaryWorking = await text("[data-files-range-summary]");
        await h.ev(`document.querySelector('[data-range-chip="compare"]').click()`);
        await sleep(1800);
        const summaryCompare = await text("[data-files-range-summary]");
        const comparingNow = await present("[data-compare-column]");
        await h.ev(`document.querySelector('[data-range-chip="working"]').click()`);
        await sleep(1800);
        const summaryBack = await text("[data-files-range-summary]");
        const scrollAfterRange = await h.ev(`document.querySelector('[data-history-scroll]').scrollTop`);
        rec(
            "8. the chips switch the read, say so in words, and keep the reader's place",
            summaryWorking.length > 0 &&
                comparingNow &&
                summaryCompare !== summaryWorking &&
                summaryBack === summaryWorking &&
                scrollAfterRange === scrollBeforeRange,
            `working="${summaryWorking}" compare="${summaryCompare}" back="${summaryBack}" scroll=${scrollBeforeRange} -> ${scrollAfterRange}`
        );

        await pick(ctx.names.notRepo);
        const calm = await present("[data-not-a-repo]");
        const noFailure = await present("[data-git-failure]");
        rec(
            "9. a plain directory reads as not-a-repository, not a failure",
            calm && !noFailure,
            `notRepo=${calm} failure=${noFailure}`
        );
        await h.shot("cdp-shots/git-history-notrepo.png");

        await pick(ctx.names.broken);
        const failed = await present("[data-git-failure]");
        const evidence = await text("[data-git-failure]");
        rec(
            "10. an unreadable repository reads as a failure, with git's own message",
            failed && evidence.includes("git log") && evidence.length > 40,
            `failure=${failed} evidence="${evidence.slice(0, 120)}"`
        );
        await h.shot("cdp-shots/git-history-failed.png");

        return steps;
    },
    async teardown(h, ctx) {
        for (const name of Object.values(ctx.names)) {
            try {
                await h.rpc("deleteproject", { name });
            } catch {
                /* leave a stale registry entry rather than failing teardown */
            }
        }
        for (const dir of ctx.dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    },
};

// --- jarvis avatar: the hologram in window chrome ----------------------------------------------
// The avatar is a <canvas>, so there are no attributes to read the way the old SVG creature allowed. It
// publishes its last built scene on window in DEV builds instead (petview.tsx), which is a STRONGER
// assertion than the SVG version permitted: the whole scene at once rather than one element's transform.
// A screenshot still goes to the contact sheet for eyeballing the glow.
const jarvisAvatar = {
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

const jarvisPeek = {
    name: "jarvis-peek",
    surface: "cockpit",
    async arrange(h) {
        // petSaidAtom is session-scoped. Reloading gives this scenario a deterministic empty feed while
        // the persisted watermark still prevents old backend facts from speaking again.
        await h.ev("location.reload()");
        await h.ev("new Promise((r) => setTimeout(r, 2500))");
        const reset = await h.ev(`(() => {
            const store = globalThis.__wavePetStore;
            if (typeof store?.resetPeek !== 'function') return false;
            store.resetPeek();
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
                structure?.label === "Jarvis" &&
                structure?.header === true &&
                structure?.queue === true &&
                structure?.composer === true &&
                structure?.close === true &&
                structure?.panelFocused === true,
            JSON.stringify({ creatureFocused, structure })
        );

        await press("Tab", "Tab", 9);
        const firstTab = await h.ev(`(() => ({
            text: (document.activeElement?.innerText || '').trim(),
            inside: document.querySelector('[data-pet-peek]')?.contains(document.activeElement) ?? false,
        }))()`);
        await press("Tab", "Tab", 9, 8);
        const wrappedInside = await h.ev(
            `document.querySelector('[data-pet-peek]')?.contains(document.activeElement) ?? false`
        );
        rec(
            "2. Tab starts at Open full view and reverse traversal stays inside the dialog",
            firstTab.inside === true && firstTab.text === "Open full view" && wrappedInside === true,
            JSON.stringify({ firstTab, wrappedInside })
        );
        // Each string below is one the old three-card panel rendered to report that nothing was wrong:
        // two of its four tiles said "No reading" / "Nothing", the updates card cost 78px to say it was
        // empty, and the ask row stated its disabled condition three times. None may come back.
        const ABSENCE =
            /No updates yet|No reading|Usage unavailable|No action needed|No destination|No channel selected|Select a channel to ask Jarvis/;
        rec(
            "3. the resting panel renders no absence, and the composer is live wherever there is a destination",
            ctx.reset === true &&
                structure?.updatesDrawer === false &&
                ABSENCE.test(structure?.text ?? "") === false &&
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
                narrow.horizontalOverflow <= 0 &&
                narrow.headerStayed === true &&
                pickerOpened === true &&
                pickerVisibility?.visible === true,
            JSON.stringify({ narrow, pickerOpened, pickerVisibility })
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
            "5. Escape, close, and backdrop dismiss only the peek and return focus to the creature",
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
        rec("6. dismissing the global peek stays on the current surface", stayed, String(stayed));
        return steps;
    },
    async teardown(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 1600,
            height: 950,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await h.ev(`(() => {
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            return true;
        })()`);
        await h.goto("cockpit");
    },
};

// --- jarvis volunteer: the volunteered-knowledge delivery chain ---------------------------------
// The unit tests cover each hop in isolation; what they structurally cannot see is a bad hop BETWEEN
// atoms, which is the defect class this surface's findings keep landing in. So this drives the whole
// chain in the real app: push a knowledge utterance -> the creature speaks it -> the peek lists it with
// Open and Ask -> Open lands on the Jarvis surface.
//
// It injects the pet event rather than arranging a real utterance. A real one needs a headless CLI judge
// run (up to 90s) behind a 45-minute quiet window, which is the same live-model limit that keeps the
// cancel path and the thread-archive path unit-only (docs/jarvis-tab.md). The hook is dev-only, exposed
// by petstore.ts under import.meta.env.DEV.
const jarvisVolunteer = {
    name: "jarvis-volunteer",
    surface: "cockpit", // the creature lives in window chrome, so any surface will do; start neutral
    async arrange() {
        return { id: `loose-end:cdp-probe:${Date.now()}` };
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
                sources: [{ ref: "task:cdp-probe", title: "CDP probe", sourceType: "dossier" }],
            });
            return true;
        })()`);
        // the speak effect runs on the events atom, then the bubble mounts
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        steps.push({ step: "knowledge utterance pushed to the creature", ok: pushed === true, detail: String(pushed) });
        await h.shot("cdp-shots/jarvis-volunteer-bubble.png");

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

        // the acts live in the "Since you looked" drawer, which starts shut and shows only its newest line
        // while it is. Expanding it is part of reading the panel, not an optional detour — without this the
        // step could only ever find no controls, in every profile, for reasons that have nothing to do with
        // whether the acts exist.
        await h.ev(`(() => {
            const toggle = document.querySelector('[data-pet-updates] button[aria-expanded]');
            if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        const verbs = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            return {
                open: panel?.querySelector('[data-pet-act$=":open"]') != null,
                ask: panel?.querySelector('[data-pet-act$=":ask"]') != null,
            };
        })()`);
        steps.push({
            step: "peek row offers Open and Ask",
            ok: verbs?.open === true && verbs?.ask === true,
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

        return steps;
    },
    async teardown(h) {
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
        await h.goto("cockpit");
    },
};

// --- code: content search ----------------------------------------------------------------------
// Drives the real grep RPC, so it needs a backend built with GitGrepCommand (task build:backend).
// The query is a string this repository certainly contains; asserting "some rows" rather than an
// exact count keeps it from breaking on every edit.
const CODE_SEARCH_QUERY = "openInCode";

// Opens the project picker only when no project is loaded yet — the column tabs render only inside
// CodePanes, so their absence is the signal. Returns whether the picker was actually opened, because
// clicking a project row is only safe when it is.
const openProjectPicker = (h) =>
    h.ev(`(() => {
        if (document.querySelector('[data-code-column-tab]')) return false;
        const chip = document.querySelector('[data-code-project-picker]');
        if (!chip) return false;
        chip.click();
        return true;
    })()`);

// Scoped to the picker's own container, never the whole document: the app bar's global search
// button also carries a .font-mono child, so an unscoped query picks THAT and opens the command
// palette instead of selecting a project.
const chooseProjectRow = (h) =>
    h.ev(`(() => {
        const chip = document.querySelector('[data-code-project-picker]');
        const scope = chip && chip.parentElement;
        if (!scope) return false;
        const rows = [...scope.querySelectorAll('button')].filter((b) => b !== chip && b.querySelector('.font-mono'));
        if (!rows.length) return false;
        rows[0].click();
        return true;
    })()`);

const setSearchQuery = (h, text) =>
    h.ev(`(() => {
        const input = document.querySelector('input[placeholder="Search file contents"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
    })()`);

const setFinderQuery = (h, text) =>
    h.ev(`(() => {
        const input = document.querySelector('input[placeholder="Find a file by name — add :123 for a line"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
    })()`);

const codeSearch = {
    name: "code-search",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        steps.push({
            step: "Code surface is active",
            ok: (await h.activeSurfaceLabel()) === SURFACE_LABEL.code,
            detail: `active=${await h.activeSurfaceLabel()}`,
        });

        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            const picked = await chooseProjectRow(h);
            steps.push({ step: "select a project", ok: picked === true, detail: `picked=${picked}` });
            await sleep(1200); // the index is one git ls-files call
        }

        const switched = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="search"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        steps.push({ step: "switch the left column to Search", ok: switched === true, detail: `switched=${switched}` });

        const typed = await setSearchQuery(h, CODE_SEARCH_QUERY);
        steps.push({ step: "type a query and submit", ok: typed === true, detail: `typed=${typed}` });

        // poll rather than sleep a guessed interval: the RPC shells out to git. Take the LAST match so
        // the summary leaf wins over every ancestor div whose textContent also contains it.
        let summary = "";
        for (let i = 0; i < 20; i++) {
            summary = await h.ev(
                `(() => { const els=[...document.querySelectorAll('div')].filter((d)=>/match(es)? in \\d+ file/.test(d.textContent||'')); const el=els[els.length-1]; return el?(el.textContent||'').trim():''; })()`
            );
            if (summary) break;
            await sleep(500);
        }
        steps.push({
            step: `search "${CODE_SEARCH_QUERY}" reports a match summary`,
            ok: summary !== "",
            detail: `summary=${summary || "(none)"}`,
        });

        await h.shot("cdp-shots/code-search.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

const codeSidebar = {
    name: "code-sidebar",
    surface: "code",
    async arrange(h) {
        // unmount Code before seeding storage so the assertion starts from fresh component state.
        await h.goto("cockpit");
        const previous = await h.ev("localStorage.getItem('code.sidebar.prefs')");
        await h.ev(
            `localStorage.setItem('code.sidebar.prefs', ${JSON.stringify(
                JSON.stringify({ widths: { files: 280, search: 380, changed: 380 }, open: true })
            )})`
        );
        return { previous };
    },
    async assert(h, ctx) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            await chooseProjectRow(h);
            await sleep(1200);
        }
        ctx.previousMode = await h.ev(
            `document.querySelector('[data-code-column-tab][aria-pressed="true"]')?.getAttribute('data-code-column-tab') || null`
        );
        const files = await h.ev(`(() => {
            const button = document.querySelector('[data-code-column-tab="files"]');
            if (!button) return false;
            button.click();
            return true;
        })()`);
        await sleep(100);
        steps.push({ step: "start in Files mode", ok: files === true, detail: `selected=${files}` });
        const probe = () =>
            h.ev(`(() => {
                const sidebar = document.querySelector('[aria-label="Code sidebar"]');
                const grip = document.querySelector('[role="separator"][aria-label="Resize Code sidebar"]');
                return sidebar && grip ? {
                    width: Math.round(sidebar.getBoundingClientRect().width),
                    value: Number(grip.getAttribute('aria-valuenow')),
                    active: document.activeElement?.getAttribute('aria-label') || ''
                } : null;
            })()`);
        let initial = null;
        for (let i = 0; i < 10 && initial == null; i++) {
            initial = await probe();
            if (initial == null) await sleep(200);
        }
        steps.push({
            step: "Files starts at its remembered default width",
            ok: initial?.width === 280 && initial?.value === 280,
            detail: JSON.stringify(initial),
        });

        const search = await h.ev(`(() => {
            const tab = document.querySelector('[data-code-column-tab="search"]');
            if (!tab) return false;
            tab.click();
            return true;
        })()`);
        await sleep(200);
        const searchWidth = await probe();
        steps.push({
            step: "Search keeps its independent remembered width",
            ok: search === true && searchWidth?.width === 380,
            detail: JSON.stringify(searchWidth),
        });

        const gripFocused = await h.ev(`(() => {
            const grip = document.querySelector('[role="separator"][aria-label="Resize Code sidebar"]');
            if (!grip) return false;
            grip.focus();
            return document.activeElement === grip;
        })()`);
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight" });
        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "ArrowLeft",
            code: "ArrowLeft",
            modifiers: 8,
        });
        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "ArrowLeft",
            code: "ArrowLeft",
            modifiers: 8,
        });
        const keyboard = gripFocused === true;
        await sleep(100);
        const keyboardWidth = await probe();
        steps.push({
            step: "Focused separator adjusts with keyboard without losing focus",
            ok: keyboard === true && keyboardWidth?.value === 356 && keyboardWidth?.active === "Resize Code sidebar",
            detail: JSON.stringify(keyboardWidth),
        });

        const collapsed = await h.ev(`(() => {
            const button = document.querySelector('button[aria-label="Collapse Code sidebar"]');
            if (!button) return false;
            button.click();
            return true;
        })()`);
        await sleep(200);
        const collapsedWidth = await probe();
        const openerFocused = await h.ev(`document.activeElement?.getAttribute('aria-label') || ''`);
        steps.push({
            step: "Collapse leaves a 36px reachable opener",
            ok: collapsed === true && collapsedWidth?.width === 36 && /Expand Code sidebar/.test(openerFocused),
            detail: JSON.stringify({ collapsedWidth, openerFocused }),
        });

        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "f",
            code: "KeyF",
            modifiers: 10,
        });
        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "f",
            code: "KeyF",
            modifiers: 10,
        });
        await sleep(200);
        const searchShortcut = await h.ev(`(() => {
            const tab = document.querySelector('[data-code-column-tab="search"]');
            const sidebar = document.querySelector('[aria-label="Code sidebar"]');
            return tab && sidebar ? {
                selected: tab.getAttribute('aria-pressed') === 'true',
                width: Math.round(sidebar.getBoundingClientRect().width),
                active: document.activeElement?.getAttribute('aria-label') || ''
            } : null;
        })()`);
        steps.push({
            step: "Ctrl+Shift+F expands the collapsed sidebar and selects Search",
            ok: searchShortcut?.selected === true && searchShortcut?.width === 356,
            detail: JSON.stringify(searchShortcut),
        });

        const collapsedForTree = await h.ev(`(() => {
            const button = document.querySelector('button[aria-label="Collapse Code sidebar"]');
            if (!button) return false;
            button.click();
            return true;
        })()`);
        await sleep(200);
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "t", code: "KeyT", modifiers: 1 });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "t", code: "KeyT", modifiers: 1 });
        await sleep(200);
        const treeShortcut = await h.ev(`(() => {
            const tree = document.querySelector('[data-code-tree]');
            const active = document.activeElement;
            return {
                collapsed: Math.round(document.querySelector('[aria-label="Code sidebar"]')?.getBoundingClientRect().width || 0) === 36,
                expanded: !!tree && !!active && tree.contains(active),
                active: active?.getAttribute('aria-label') || ''
            };
        })()`);
        steps.push({
            step: "Alt+T expands the collapsed sidebar before focusing the tree",
            ok: collapsedForTree === true && treeShortcut?.expanded === true,
            detail: JSON.stringify(treeShortcut),
        });

        await h.ev(`document.querySelector('button[aria-label="Collapse Code sidebar"]')?.click()`);
        await sleep(200);
        await h.ev(`document.querySelector('button[aria-label="Expand Code sidebar"]')?.click()`);
        await sleep(200);
        const reopened = await probe();
        steps.push({
            step: "Opener restores the selected mode width and focus",
            ok: reopened?.width === 280 && reopened?.active === "Collapse Code sidebar",
            detail: JSON.stringify(reopened),
        });

        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 520,
            height: 950,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await sleep(300);
        const narrow = await probe();
        steps.push({
            step: "Narrow viewport temporarily compacts without changing the preference",
            ok: narrow?.width === 36 && /wider/.test(narrow?.active || ""),
            detail: JSON.stringify(narrow),
        });
        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 1600,
            height: 950,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await sleep(300);
        const restored = await probe();
        steps.push({
            step: "Widening restores the open preference and remembered width",
            ok: restored?.width === 280 && restored?.active === "Collapse Code sidebar",
            detail: JSON.stringify(restored),
        });
        await h.shot("cdp-shots/code-sidebar.png");
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(
            `(() => {
                const previousMode = ${JSON.stringify(ctx.previousMode ?? null)};
                if (previousMode === 'files' || previousMode === 'search' || previousMode === 'changed') {
                    document.querySelector(
                        '[data-code-column-tab="' + previousMode + '"]'
                    )?.click();
                }
                const previous = ${JSON.stringify(ctx.previous)};
                if (previous == null) localStorage.removeItem('code.sidebar.prefs');
                else localStorage.setItem('code.sidebar.prefs', previous);
            })()`
        );
        await h.goto("cockpit");
    },
};

const codeGitStatus = {
    name: "code-git-status",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        steps.push({
            step: "Code surface is active",
            ok: (await h.activeSurfaceLabel()) === SURFACE_LABEL.code,
            detail: `active=${await h.activeSurfaceLabel()}`,
        });

        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            const picked = await chooseProjectRow(h);
            steps.push({ step: "select a project", ok: picked === true, detail: `picked=${picked}` });
            await sleep(1200); // the index is one git ls-files call, status one git status call
        }

        const switched = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="changed"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        steps.push({
            step: "switch the left column to Changed",
            ok: switched === true,
            detail: `switched=${switched}`,
        });

        // poll rather than sleep a guessed interval: status shells out to git
        let rowPath = "";
        for (let i = 0; i < 20; i++) {
            rowPath = await h.ev(
                `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? r.getAttribute('data-code-changed-row') : ''; })()`
            );
            if (rowPath) break;
            await sleep(500);
        }
        steps.push({
            step: "the Changed column lists at least one changed file",
            ok: rowPath !== "",
            detail: `first=${rowPath || "(none)"}`,
        });

        const counts = await h.ev(
            `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? (r.textContent || '').trim() : ''; })()`
        );
        steps.push({
            step: "a changed row carries its +/- counts",
            ok: /\+\d+/.test(counts) && /-\d+/.test(counts),
            detail: `row="${counts}"`,
        });
        await h.shot("cdp-shots/code-changed.png");

        // scoped to the row container, never a document-wide button query
        const clicked = await h.ev(`(() => {
            const r = document.querySelector('[data-code-changed-row]');
            if (!r) return false;
            r.click();
            return true;
        })()`);
        steps.push({ step: "click the first changed row", ok: clicked === true, detail: `clicked=${clicked}` });
        await sleep(900); // one stat-then-read round trip

        const openPath = await h.ev(
            `(() => { const p = document.querySelector('[data-code-path]'); return p ? p.getAttribute('data-code-path') : ''; })()`
        );
        steps.push({
            step: "the editor opened on that path",
            ok: openPath === rowPath,
            detail: `open=${openPath} want=${rowPath}`,
        });

        const backToFiles = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="files"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        await sleep(400);
        const letters = await h.ev(`(() => document.querySelectorAll('[data-code-status]').length)()`);
        steps.push({
            step: "the tree paints a status letter on the revealed file",
            ok: backToFiles === true && letters > 0,
            detail: `letters=${letters}`,
        });
        await h.shot("cdp-shots/code-git-status.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

const codeDiff = {
    name: "code-diff",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            await chooseProjectRow(h);
            await sleep(1200);
        }

        // the Changed column guarantees the file we open actually differs from HEAD
        await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="changed"]');
            if (t) t.click();
            return true;
        })()`);
        let rowPath = "";
        for (let i = 0; i < 20; i++) {
            rowPath = await h.ev(
                `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? r.getAttribute('data-code-changed-row') : ''; })()`
            );
            if (rowPath) break;
            await sleep(500);
        }
        const opened = await h.ev(`(() => {
            const r = document.querySelector('[data-code-changed-row]');
            if (!r) return false;
            r.click();
            return true;
        })()`);
        steps.push({
            step: "open a file that differs from HEAD",
            ok: opened === true && rowPath !== "",
            detail: `path=${rowPath || "(none)"}`,
        });
        await sleep(900);

        const toDiff = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="diff"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(1500); // monaco is lazy, and the HEAD read is one git call
        const mounted = await h.ev(`(() => !!document.querySelector('.monaco-diff-editor'))()`);
        steps.push({
            step: "Diff mounts the Monaco diff editor",
            ok: toDiff === true && mounted === true,
            detail: `toggled=${toDiff} mounted=${mounted}`,
        });
        await h.shot("cdp-shots/code-diff.png");

        // `d` is gated on !editable, so focus has to leave Monaco first
        await h.ev(`(() => {
            const t = document.querySelector('[data-code-tree]');
            if (t) t.focus();
            return true;
        })()`);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true }))`);
        await sleep(800);
        const back = await h.ev(
            `(() => ({ diff: !!document.querySelector('.monaco-diff-editor'), plain: !!document.querySelector('.monaco-editor') }))()`
        );
        steps.push({
            step: "pressing d again returns to the single editor",
            ok: back.diff === false && back.plain === true,
            detail: `diff=${back.diff} plain=${back.plain}`,
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

// --- terminal palette follows the cockpit theme -------------------------------------------------
// Asserts against window.term (term.tsx assigns it) + the resolved custom properties, NOT pixels:
// reading the applied xterm theme is exact, where a screenshot sample is not. The shots are for a
// human to judge whether Claude Code's own diff colors read well, which no assertion can decide.
const terminalTheme = {
    name: "terminal-theme",
    surface: "agent",
    async arrange(h) {
        // step 4 reads window.term, which an HMR can leave pointing at a detached TermWrap — see freshBoot
        return { booted: await freshBoot(h) };
    },
    async assert(h, ctx) {
        const steps = [];
        steps.push({
            step: "0. fresh boot, so window.term is the mounted terminal",
            ok: ctx.booted === true,
            detail: `reloaded=${ctx.booted}`,
        });
        const readVar = (name) =>
            h.ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
        const readTheme = (field) => h.ev(`window.term?.terminal?.options?.theme?.${field} ?? null`);
        // Scoped to the theme grid: a document-wide button query picks the app bar's global search
        // button instead of the preset the name belongs to (see cdp-scenario-unscoped-button-query).
        const pickPreset = (name) =>
            h.ev(`(() => {
                const scope = document.querySelector('[data-theme-presets]') || document;
                const b = [...scope.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(name)});
                if (!b) return false;
                b.click();
                return true;
            })()`);

        await h.goto("agent");
        const bg = await readTheme("background");
        const cssBg = await readVar("--color-background");
        steps.push({
            step: "1. xterm background === --color-background (the black seam is gone)",
            ok: !!bg && bg.toLowerCase() === cssBg.toLowerCase(),
            detail: `xterm=${bg} css=${cssBg}`,
        });

        const blue = await readTheme("blue");
        const cssAccent = await readVar("--color-accent");
        steps.push({
            step: "2. xterm ANSI blue === --color-accent (palette derives from theme roles)",
            ok: !!blue && blue.toLowerCase() === cssAccent.toLowerCase(),
            detail: `blue=${blue} accent=${cssAccent}`,
        });

        steps.push({
            step: "3. xterm background is opaque (#rrggbb, never #00000000)",
            ok: typeof bg === "string" && /^#[0-9a-f]{6}$/i.test(bg),
            detail: `background=${bg}`,
        });
        await h.shot("cdp-shots/terminal-theme-midnight.png");

        // switch presets in Settings, return to the Agent surface, and confirm the TUI re-skinned
        await h.goto("settings");
        const picked = await pickPreset("Monokai");
        await h.goto("agent");
        const bg2 = await readTheme("background");
        steps.push({
            step: "4. switching preset re-skins the live TUI with no remount",
            ok: picked && !!bg2 && bg2.toLowerCase() !== bg.toLowerCase(),
            detail: `picked=${picked} before=${bg} after=${bg2}`,
        });
        await h.shot("cdp-shots/terminal-theme-monokai.png");
        return steps;
    },
    async teardown(h) {
        // restore the default preset so a later scenario is not judged against Monokai
        await h.goto("settings");
        await h.ev(`(() => {
            const scope = document.querySelector('[data-theme-presets]') || document;
            const b = [...scope.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Midnight');
            if (b) b.click();
            return true;
        })()`);
        await h.goto("cockpit");
    },
};

// --- cockpit chords reach through a focused TUI -------------------------------------------------
// The leak is the failure mode that matters, so every step below asserts CONSUMPTION as well as
// effect. How consumption is observed, and why it is not a terminal-buffer diff:
//
// The dispatcher listens on window CAPTURE and calls stopImmediatePropagation() for a key it claims
// (dispatcher.ts). A sibling window-capture listener registered afterwards therefore fires only for
// keys the cockpit did NOT claim — and a claimed key raises no event anywhere, so it cannot reach
// xterm's textarea handler and cannot reach the PTY. Every step carries a control press through the
// same probe, so "consumed" can never be a silent no-op.
//
// Two observables that look more direct are unusable here. A terminal-buffer diff only moves when a
// live shell echoes, and the dev app's terminals are frequently idle — the diff then reads "no leak"
// for every key, including one that leaked. A probe on the xterm textarea is worse: xterm's own
// handler is registered on that element first and stops immediate propagation, so an unclaimed key
// looks identical to a claimed one.
const CTRL = 2; // CDP Input.dispatchKeyEvent modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8

// Focus the terminal by clicking its body: terminal.focus() alone leaves document.activeElement on
// BODY, which would make every assertion below run in the wrong (non-editable) posture.
const focusTui = async (h) => {
    await h.goto("agent");
    const box = await h.ev(`(() => {
        const el = document.querySelector('.cockpit-focus-pane .xterm-screen') || document.querySelector('.cockpit-focus-pane');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await new Promise((r) => setTimeout(r, 500));
    return h.ev(
        `(() => { const a = document.activeElement; return !!(a && a.classList && a.classList.contains('xterm-helper-textarea')); })()`
    );
};

// A full page reload, for two reasons that both bite only after a dev-session hot reload:
//
//  1. Probe ordering. Capture-phase listeners on the same target run in REGISTRATION order, so the
//     consumption probe below is valid only when the dispatcher registered first. Boot registers it;
//     an HMR of a keybinding file re-registers it at the BACK of the queue, after the probe, and every
//     "consumed" step then reports a leak that is not real.
//  2. window.term freshness. term.tsx assigns window.term on mount. After an HMR the global can point
//     at a DETACHED TermWrap whose TermThemeUpdater is gone, so its options.theme never changes again
//     and "switching preset re-skins the TUI" fails against a terminal that is no longer on screen.
//
// Both failure modes are safe in direction (no false PASS) but waste a run, so pay the reload.
const freshBoot = async (h) => {
    await h.ev("location.reload()");
    for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const ready = await h.ev(`document.querySelectorAll('nav button').length > 0`).catch(() => false);
        if (ready) {
            await new Promise((r) => setTimeout(r, 1500)); // let boot settle before driving it
            return true;
        }
    }
    return false;
};

const installProbe = (h) =>
    h.ev(`(() => {
        window.__seen = [];
        window.__probeFn = (e) => window.__seen.push((e.ctrlKey ? "Ctrl+" : "") + e.key);
        window.addEventListener("keydown", window.__probeFn, true);
        return true;
    })()`);

// Returns the keys the probe saw: [] means the cockpit consumed the press.
const pressKey = async (h, { key, code, keyCode, modifiers = 0 }) => {
    await h.ev("window.__seen = []");
    for (const type of ["keyDown", "keyUp"]) {
        await h.cdp("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: keyCode });
    }
    await new Promise((r) => setTimeout(r, 450));
    return JSON.parse(await h.ev("JSON.stringify(window.__seen || [])"));
};
const whichKeyOpen = (h) => h.ev(`document.body.innerText.includes('Cockpit (home)')`);
const treeVisible = (h) => h.ev(`!!document.querySelector('[data-agent-tree]')`);

const tuiLeader = {
    name: "tui-leader",
    surface: "agent",
    async arrange(h) {
        const booted = await freshBoot(h);
        const focused = await focusTui(h);
        await installProbe(h);
        return { booted, focused };
    },
    async assert(h, ctx) {
        const steps = [];
        steps.push({
            step: "0. the terminal holds focus, so these run in the editable posture",
            ok: ctx.booted === true && ctx.focused === true,
            detail: `reloaded=${ctx.booted} xterm textarea focused=${ctx.focused}`,
        });

        // Control press. Without this, every "consumed" verdict below could be a dead probe.
        const seenX = await pressKey(h, { key: "x", code: "KeyX", keyCode: 88 });
        steps.push({
            step: "1. control: an unclaimed key is NOT consumed (the probe is live)",
            ok: seenX.length > 0,
            detail: `probe saw ${JSON.stringify(seenX)}`,
        });

        // The pre-existing posture must not regress: a bare letter still belongs to the agent.
        const seenG = await pressKey(h, { key: "g", code: "KeyG", keyCode: 71 });
        const wkBare = await whichKeyOpen(h);
        steps.push({
            step: "2. a bare g still reaches the agent and opens no leader",
            ok: seenG.length > 0 && wkBare === false,
            detail: `probe saw ${JSON.stringify(seenG)}, which-key=${wkBare}`,
        });

        const seenCtrlG = await pressKey(h, { key: "g", code: "KeyG", keyCode: 71, modifiers: CTRL });
        const wkChord = await whichKeyOpen(h);
        steps.push({
            step: "3. Ctrl+G opens the which-key bar and is consumed (no ^G to the PTY)",
            ok: seenCtrlG.length === 0 && wkChord === true,
            detail: `probe saw ${JSON.stringify(seenCtrlG)}, which-key=${wkChord}`,
        });

        // singles fallback: `]` is a navigate-guarded single, dormant in the TUI without a leader
        const surfBefore = await h.activeSurfaceLabel();
        const seenBracket = await pressKey(h, { key: "]", code: "BracketRight", keyCode: 221 });
        const surfAfter = await h.activeSurfaceLabel();
        steps.push({
            step: "4. under the leader, the singles fallback runs ']' and consumes it",
            ok: seenBracket.length === 0 && surfAfter !== surfBefore,
            detail: `${surfBefore} -> ${surfAfter}, probe saw ${JSON.stringify(seenBracket)}`,
        });

        // sequence continuation from inside the terminal
        await focusTui(h);
        await pressKey(h, { key: "g", code: "KeyG", keyCode: 71, modifiers: CTRL });
        const seenC = await pressKey(h, { key: "c", code: "KeyC", keyCode: 67 });
        const surfC = await h.activeSurfaceLabel();
        steps.push({
            step: "5. Ctrl+G then c teleports to Jarvis from inside the terminal",
            ok: seenC.length === 0 && surfC === SURFACE_LABEL.jarvis,
            detail: `active=${surfC}, probe saw ${JSON.stringify(seenC)}`,
        });

        // Escape means cancel while the which-key bar is showing — never navigate (spec decision 8)
        await focusTui(h);
        await pressKey(h, { key: "g", code: "KeyG", keyCode: 71, modifiers: CTRL });
        const wkOn = await whichKeyOpen(h);
        const escFrom = await h.activeSurfaceLabel();
        await pressKey(h, { key: "Escape", code: "Escape", keyCode: 27 });
        const wkOff = await whichKeyOpen(h);
        const escTo = await h.activeSurfaceLabel();
        steps.push({
            step: "6. Ctrl+G then Escape cancels the leader without navigating",
            ok: wkOn === true && wkOff === false && escTo === escFrom,
            detail: `which-key ${wkOn}->${wkOff}, surface ${escFrom}->${escTo}`,
        });

        await h.shot("cdp-shots/tui-leader.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

const tuiFullscreen = {
    name: "tui-fullscreen",
    surface: "agent",
    async arrange(h) {
        await freshBoot(h);
        const focused = await focusTui(h);
        await installProbe(h);
        return { focused };
    },
    async assert(h, ctx) {
        const steps = [];
        // fullscreen unmounts the agent tree (agentsurface.tsx); its absence is the observable
        const before = await treeVisible(h);
        const winBefore = await h.ev(
            `JSON.stringify({fullscreenEl: !!document.fullscreenElement, w: window.innerWidth, h: window.innerHeight})`
        );
        const seen = await pressKey(h, { key: "F11", code: "F11", keyCode: 122 });
        const after = await treeVisible(h);
        const winAfter = await h.ev(
            `JSON.stringify({fullscreenEl: !!document.fullscreenElement, w: window.innerWidth, h: window.innerHeight})`
        );
        steps.push({
            step: "1. F11 toggles terminal fullscreen and is consumed (no F11 to the PTY)",
            ok: ctx.focused === true && seen.length === 0 && after !== before,
            detail: `focused=${ctx.focused}, treeVisible ${before} -> ${after}, probe saw ${JSON.stringify(seen)}`,
        });
        // the specific worry about F11: that WebView2 answers it with its own fullscreen, the way an
        // unclaimed Ctrl+P once reached it and raised a print dialog (ccc90133)
        steps.push({
            step: "2. no WebView2 fullscreen default fired (viewport unchanged)",
            ok: winBefore === winAfter,
            detail: `${winBefore} -> ${winAfter}`,
        });
        await h.shot("cdp-shots/tui-fullscreen.png");
        await pressKey(h, { key: "F11", code: "F11", keyCode: 122 });
        const restored = await treeVisible(h);
        steps.push({
            step: "3. F11 again restores the split view",
            ok: restored === before,
            detail: `treeVisible=${restored}`,
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- harness picker: shared preference, composer blocking, one-off ask, legacy labels --------------
// Drives the Launch composer's harness picker and the shared preference atom. No worker is ever spawned:
// the goal stays a draft, and the one real Run this scenario creates is a legacy object injected via
// eventpublish (missing runtime), so the header/summary labels are exercised without a harness.
const harnessPicker = {
    name: "harness-picker",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-harness-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-harness", projectpath: cwd });
        // save + clear the shared preference so the scenario starts from "choose a harness"
        const cfg = await h.rpc("getfullconfig", null);
        const prev = cfg?.settings?.["harness:preferredruntime"] ?? "";
        if (prev !== "") {
            await h.rpc("setconfig", { "harness:preferredruntime": "" });
        }
        return { cwd, workspaceId, channelId: ch.oid, prev };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const picker = (operation) =>
            h.ev(`(() => {
                const p = [...document.querySelectorAll('[data-testid="harness-picker"]')]
                    .find((x) => x.getAttribute('data-harness-operation') === ${JSON.stringify(operation)});
                return p ? {
                    runtime: p.getAttribute('data-harness-runtime') || '',
                    label: (p.textContent || '').trim(),
                } : null;
            })()`);
        const submitDisabled = () =>
            h.ev(`(() => {
                const b = document.querySelector('[data-testid="composer-action"]');
                return b ? b.disabled : null;
            })()`);

        await h.goto("jarvis");
        // open the Launch composer: select the channel in the Subjects column
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('[data-jarvis-subject-kind]')]
                .find((x) => (x.textContent || '').includes('verify-harness'));
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(900);

        const empty = await picker("run-worker");
        rec(
            "1. Launch composer shows 'Choose harness' with the preference cleared",
            empty != null && empty.runtime === "" && empty.label.includes("Choose harness"),
            JSON.stringify(empty)
        );
        const disabledEmpty = await submitDisabled();
        rec("2. Run action disabled without a harness", disabledEmpty === true, `disabled=${disabledEmpty}`);

        // footer order: picker (footerLeft) before attachment (footerRight) before the action button
        const order = await h.ev(`(() => {
            const shell = document.querySelector('[data-testid="composer-action"]')?.closest('.flex.items-center.gap-2\\\\.5');
            if (!shell) return null;
            const tags = [...shell.children].map((c) =>
                c.getAttribute('data-testid') || c.textContent.trim().slice(0, 24));
            return tags;
        })()`);
        rec(
            "3. footer order: picker, behavior, attachment, action",
            Array.isArray(order) &&
                order[0].includes("harness-picker") &&
                order.some((t) => t.includes("composer-attachment")),
            JSON.stringify(order)
        );

        // open the picker, assert installed/disabled rows, then select OpenCode
        await h.ev(`(() => {
            const b = document.querySelector('[data-testid="harness-picker"][data-harness-operation="run-worker"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(300);
        const rows = await h.ev(`(() => {
            const opts = [...document.querySelectorAll('[data-testid^="harness-option-"]')].map((o) => ({
                runtime: o.getAttribute('data-testid').replace('harness-option-', ''),
                disabled: o.disabled,
            }));
            return opts;
        })()`);
        rec(
            "4. picker lists catalog rows incl. pi, uninstalled disabled",
            Array.isArray(rows) &&
                rows.length >= 3 &&
                rows.some((r) => r.disabled) &&
                rows.some((r) => r.runtime === "pi"),
            JSON.stringify(rows)
        );

        // every catalog row renders its brand mark as a LOCAL bundled asset (same-origin in dev), and
        // the OpenCode and Pi marks must actually decode (naturalWidth > 0), not be dead srcs.
        const marks = await h.ev(`(() => {
            const imgs = [...document.querySelectorAll('[data-testid^="harness-option-"] img')];
            const sameOrigin = (src) => { try { return new URL(src).origin === location.origin; } catch { return false; } };
            return {
                count: imgs.length,
                opencode: imgs.some((i) => i.src.includes("opencode") && i.naturalWidth > 0),
                pi: imgs.some((i) => i.src.includes("pi.svg") && i.naturalWidth > 0),
                remote: imgs.filter((i) => !sameOrigin(i.src)).length,
            };
        })()`);
        rec(
            "5. picker rows render local loaded runtime marks for OpenCode and Pi",
            marks.count >= 2 && marks.opencode && marks.pi && marks.remote === 0,
            JSON.stringify(marks)
        );
        const picked = await h.ev(`(() => {
            const o = document.querySelector('[data-testid="harness-option-opencode"]');
            if (!o) return false;
            o.click();
            return true;
        })()`);
        await settle(600); // wait for SetConfigCommand to persist
        const afterOpen = await picker("run-worker");
        rec(
            "6. selecting OpenCode persists it as the shared preference",
            picked && afterOpen != null && afterOpen.runtime === "opencode",
            JSON.stringify(afterOpen)
        );

        // bare ask uses the preferred runtime; an explicit @ask override is one-off
        const ta = () =>
            h.ev(`(() => {
                const t = document.querySelector('[data-jarvis-composer] textarea');
                if (!t) return false;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                setter.call(t, ${JSON.stringify("inspect the auth path")});
                t.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`);
        await ta();
        await settle(200);
        const footerText = await h.ev(`(() => {
            const shell = document.querySelector('[data-testid="composer-action"]')?.closest('.flex.items-center.gap-2\\\\.5');
            return shell ? shell.textContent.trim() : '';
        })()`);
        rec(
            "7. bare goal footer names the preferred harness",
            footerText.includes("OpenCode"),
            `footer=${footerText.slice(0, 80)}`
        );
        const oneOff = await h.ev(`(() => {
            const t = document.querySelector('[data-jarvis-composer] textarea');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(t, ${JSON.stringify("@ask codex inspect")});
            t.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await settle(200);
        const footerOneOff = await h.ev(`(() => {
            const shell = document.querySelector('[data-testid="composer-action"]')?.closest('.flex.items-center.gap-2\\\\.5');
            return shell ? shell.textContent.trim() : '';
        })()`);
        rec(
            "8. explicit @ask shows Codex · one-off, preference unchanged",
            oneOff &&
                footerOneOff.includes("one-off") &&
                footerOneOff.includes("OpenCode") &&
                !footerOneOff.includes("preferred codex"),
            `footer=${footerOneOff.slice(0, 100)}`
        );

        // Pi selection is conditional on installation: the row always exists (step 4), but selecting it
        // only when pi is on PATH. Restore OpenCode afterward so the remaining steps keep their
        // expected preference.
        const piRow = await h.ev(`(() => {
            const o = document.querySelector('[data-testid="harness-option-pi"]');
            return o ? { disabled: o.disabled } : null;
        })()`);
        let piPicked = null;
        if (piRow != null && !piRow.disabled) {
            await h.ev(`(() => {
                const o = document.querySelector('[data-testid="harness-option-pi"]');
                o.click();
                return true;
            })()`);
            await settle(600); // wait for SetConfigCommand to persist
            piPicked = await picker("run-worker");
            const restored = await h.ev(`(() => {
                const o = document.querySelector('[data-testid="harness-option-opencode"]');
                if (!o) return false;
                o.click();
                return true;
            })()`);
            await settle(600);
            rec(
                "9. selecting Pi persists it as the shared preference when installed",
                piPicked != null && piPicked.runtime === "pi" && restored,
                JSON.stringify({ picked: piPicked, restored })
            );
        } else {
            rec(
                "9. selecting Pi persists it as the shared preference when installed",
                piRow != null,
                "pi uninstalled — row asserted only"
            );
        }

        // blocked submission preserves draft + attachment: attach a file, submit, then assert both remain
        await h.ev(`(() => {
            const t = document.querySelector('[data-jarvis-composer] textarea');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(t, ${JSON.stringify("this must not dispatch")});
            t.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        const draftBefore = await h.ev(`document.querySelector('[data-jarvis-composer] textarea')?.value || ''`);
        await h.ev(`(() => {
            const a = document.querySelector('[data-testid="composer-attachment"] input');
            if (!a) return false;
            a.disabled = false;
            return true;
        })()`);
        await h.ev(`(() => {
            const b = document.querySelector('[data-testid="composer-action"]');
            b.click();
            return true;
        })()`);
        await settle(300);
        const draftAfter = await h.ev(`document.querySelector('[data-jarvis-composer] textarea')?.value || ''`);
        rec(
            "10. a blocked dispatch preserves the draft",
            draftBefore.includes("this must not dispatch") && draftAfter === draftBefore,
            `before=${draftBefore.length} after=${draftAfter.length}`
        );

        // legacy label: inject a Run object with no runtime via eventpublish, then assert the header label
        const legacyId = "00000000-0000-0000-0000-0000000000ff";
        await h.rpc("eventpublish", {
            event: "waveobj:update",
            scopes: [`run:${legacyId}`],
            data: {
                updatetype: "update",
                otype: "run",
                oid: legacyId,
                obj: {
                    otype: "run",
                    oid: legacyId,
                    version: 1,
                    meta: {},
                    id: legacyId,
                    goal: "legacy run",
                    workspaceid: ctx.workspaceId,
                    projectpath: ctx.cwd,
                    status: "done",
                    phases: [],
                    createdts: Date.now(),
                },
            },
        });
        const legacy = await h.ev(`(() => {
            const el = document.querySelector('[data-testid="run-runtime"]');
            return el ? { label: el.textContent.trim(), legacy: el.getAttribute('data-run-legacy') } : null;
        })()`);
        rec(
            "11. a missing-runtime Run renders Claude · legacy",
            legacy != null && legacy.label.includes("Claude · legacy") && legacy.legacy === "true",
            JSON.stringify(legacy)
        );

        return steps;
    },
    async teardown(h, ctx) {
        // restore the prior preference and drop the fixture channel
        if (ctx.prev !== "") {
            try {
                await h.rpc("setconfig", { "harness:preferredruntime": ctx.prev });
            } catch {
                // best-effort cleanup
            }
        } else {
            try {
                await h.rpc("setconfig", { "harness:preferredruntime": "" });
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
        await h.goto("cockpit");
    },
};

const codeMarkdown = {
    name: "code-markdown",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        steps.push({
            step: "Code surface is active",
            ok: (await h.activeSurfaceLabel()) === SURFACE_LABEL.code,
            detail: `active=${await h.activeSurfaceLabel()}`,
        });

        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            const picked = await chooseProjectRow(h);
            steps.push({ step: "select a project", ok: picked === true, detail: `picked=${picked}` });
            await sleep(1200); // the index is one git ls-files call
        }

        // Ctrl+P opens the file finder (the command palette moved to Ctrl+Shift+P); Enter opens the
        // top-ranked match
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
        );
        await sleep(300);
        const typed = await setFinderQuery(h, "README.md");
        steps.push({
            step: "open the finder with Ctrl+P and open README.md",
            ok: typed === true,
            detail: `typed=${typed}`,
        });
        await sleep(800); // one stat-then-read round trip

        const heading = await h.ev(`(() => {
            const h = document.querySelector('.markdown .heading');
            return h ? (h.textContent || '').trim() : null;
        })()`);
        steps.push({
            step: "markdown file renders as a document (a heading is present)",
            ok: heading != null && heading.length > 0,
            detail: `heading=${heading}`,
        });
        await h.shot("cdp-shots/code-markdown-preview.png");

        await h.ev(`document.querySelector('[data-code-column-tab="files"]')?.click()`);
        await sleep(100);
        const filesSelected = await h.ev(
            `document.querySelector('[data-code-column-tab="files"]')?.getAttribute('aria-pressed') === 'true'`
        );
        await h.ev(`(() => {
            window.__codeMarkdownNodes = [
                document.querySelector('.markdown .heading'),
                document.querySelector('.markdown .paragraph'),
            ];
            document.querySelector('[data-code-column-tab="changed"]')?.click();
        })()`);
        await sleep(100);
        const stableRender = await h.ev(`(() => {
            const before = window.__codeMarkdownNodes;
            delete window.__codeMarkdownNodes;
            return {
                changedSelected: document.querySelector('[data-code-column-tab="changed"]')?.getAttribute('aria-pressed') === 'true',
                nodesPreserved: Array.isArray(before)
                    && before[0] != null
                    && before[1] != null
                    && before[0] === document.querySelector('.markdown .heading')
                    && before[1] === document.querySelector('.markdown .paragraph'),
            };
        })()`);
        steps.push({
            step: "unrelated Code pane updates preserve the rendered document nodes",
            ok:
                filesSelected === true &&
                stableRender?.changedSelected === true &&
                stableRender?.nodesPreserved === true,
            detail: JSON.stringify({ filesSelected, ...stableRender }),
        });

        const toSource = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="source"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(600);
        const editor = await h.ev(`(() => !!document.querySelector('.monaco-editor'))()`);
        steps.push({
            step: "toggle to Source mounts the Monaco editor",
            ok: toSource === true && editor === true,
            detail: `toggled=${toSource} editor=${editor}`,
        });

        const backToPreview = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="preview"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(400);
        const previewAgain = await h.ev(`(() => !!document.querySelector('.markdown .heading'))()`);
        steps.push({
            step: "toggle back to Preview re-renders the document",
            ok: backToPreview === true && previewAgain === true,
            detail: `toggled=${backToPreview} preview=${previewAgain}`,
        });

        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- dag lifecycle: engine + graph surface ----------------------------------------------------
// Drives the real DagSubmit/DagAction/DagMerge RPCs through an orchestrator-mode run, then opens
// the graph surface and asserts the ReactFlow canvas renders the submitted nodes. Blast radius is
// contained like runs-lifecycle: temp-dir project, worker blocks killed in teardown, channel deleted.
const dagLifecycle = {
    name: "dag-lifecycle",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-dag-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-dag", projectpath: cwd });
        return { cwd, workspaceId, channelId: ch.oid };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const getRun = async (runId) => {
            const res = await h.rpc("getchannels", null);
            const cc = (res.channels || []).find((x) => x.oid === ctx.channelId) || {};
            return (cc.runs || []).find((x) => x.id === runId);
        };
        const getChannelRunCount = async () => {
            const res = await h.rpc("getchannels", null);
            const channel = (res.channels || []).find((x) => x.oid === ctx.channelId) || {};
            return (channel.runs || []).length;
        };

        const clickRetry = (findJs, tries = 8) =>
            h.ev(`(async () => {
                for (let i = 0; i < ${tries}; i++) {
                    const b = ${findJs};
                    if (b) { b.click(); return true; }
                    await new Promise((r) => setTimeout(r, 500));
                }
                return false;
            })()`);

        // The draft-first DAG composer no longer exists: 4296d92d removed the draft modal and the
        // `kind: "draft"` state it was driven through, leaving the live modal as the only DAG UI. So a
        // DAG is created here the way the lead creates one — an orchestrator run held in planning by
        // DeferStart, then an explicit DagSubmit — and the DOM half below asserts only what survived.
        const beforePlanning = await getChannelRunCount();
        const parentGoal = "verify dag: do nothing, make no file changes, stop immediately";
        const dagTitle = "verify dag";
        const dagParallelism = 2;
        const dagTasks = [
            { id: "t-0", label: "noop", description: "do nothing, stop immediately", deps: [], gate: false, state: "" },
            {
                id: "t-1",
                label: "review",
                description: "review only, make no changes",
                deps: ["t-0"],
                gate: true,
                state: "",
            },
            {
                id: "t-2",
                label: "noop 2",
                description: "do nothing, stop immediately",
                deps: ["t-1"],
                gate: false,
                state: "",
            },
        ];
        const createdParent = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid: ctx.workspaceId,
            goal: parentGoal,
            runtime: "claude",
            tier: "capable",
            mode: "orchestrator",
            deferstart: true,
            // pinned, not left to the profile's default: every assertion below is about a plan-gated
            // dag (park, approve, dispatch), and an inherited `false` would skip the gate entirely.
            plangate: true,
        });
        const runId = createdParent.run.id;
        const afterPlanning = await getChannelRunCount();
        rec(
            "1. DeferStart -> one orchestrator Run held in planning, no phase worker spawned",
            createdParent.run.mode === "orchestrator" &&
                createdParent.run.status === "planning" &&
                afterPlanning === beforePlanning + 1 &&
                (createdParent.run.phases || []).every((p) => !workerOf(p)),
            JSON.stringify({
                beforePlanning,
                afterPlanning,
                mode: createdParent.run.mode,
                status: createdParent.run.status,
            })
        );

        await h.rpc("dagsubmit", {
            channelid: ctx.channelId,
            runid: runId,
            title: dagTitle,
            parallelism: dagParallelism,
            tasks: dagTasks,
        });

        // DagStatus returns { group, digest } since 5a863daa — the group is the snapshot this asserts.
        const g = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
        rec(
            "2. DagSubmit -> group with 3 tasks parked at the plan gate, nothing dispatched",
            g.tasks.length === 3 && g.status === "awaiting-plan" && g.tasks.every((t) => t.state === "pending"),
            JSON.stringify({ id: g.id, status: g.status, tasks: g.tasks.map((t) => [t.id, t.state]) })
        );
        const rAfter = await getRun(runId);
        rec(
            "3. run.dagoref links the group",
            rAfter && rAfter.dagoref === g.id,
            JSON.stringify({ dagoref: rAfter && rAfter.dagoref })
        );

        const beforeRetryCount = await getChannelRunCount();
        const retry = await h.rpc("dagsubmit", {
            channelid: ctx.channelId,
            runid: runId,
            title: dagTitle,
            parallelism: dagParallelism,
            tasks: dagTasks,
        });
        const afterRetryCount = await getChannelRunCount();
        rec(
            "identical DagSubmit retry returns the same DAG without creating Runs",
            retry.id === g.id && retry.tasks.length === g.tasks.length && afterRetryCount === beforeRetryCount,
            JSON.stringify({ first: g.id, retry: retry.id, beforeRetryCount, afterRetryCount })
        );

        // approving the plan is what spawns the first worker — until then the dag holds every task
        // pending, which is what step 2 just asserted.
        await h.rpc("dagaction", { channelid: ctx.channelId, runid: runId, taskid: "", action: "approve-plan" });
        let st = null;
        for (let i = 0; i < 20; i++) {
            await h.ev("new Promise((r) => setTimeout(r, 700))");
            st = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
            if (st.tasks[0].state !== "pending") break;
        }
        rec(
            "4. approve-plan -> t-0 scheduled (running) or already finished, t-1/t-2 pending",
            st != null && (st.tasks[0].state === "running" || st.tasks[0].state === "done"),
            JSON.stringify(st == null ? null : st.tasks.map((t) => ({ id: t.id, state: t.state })))
        );

        // graph surface: the run header has an Open DAG button. The Brief's Sessions region is how a
        // LIVE run is reached now — its row carries the run oref and opens the sheet on that run — so
        // there is no channel row to click first. Reload to pick up the RPC-created channel (the Brief
        // reads a boot-primed snapshot the same way the subjects column did), and open the region's
        // overflow first: Sessions caps at ACTIVE_CAP and this DAG adds a parent plus its children.
        await h.ev("location.reload()");
        await h.ev("new Promise((r) => setTimeout(r, 4500))");
        await h.goto("jarvis");
        await clickRetry(
            `[...document.querySelectorAll('[data-jarvis-brief-more="more"]')].find((b) => b.closest('[data-jarvis-brief-region="sessions"]'))`,
            2
        );
        const runClicked = await clickRetry(
            `[...document.querySelectorAll('[data-jarvis-brief-row="session"]')]
                .find((x) => x.tagName === 'BUTTON' && (x.textContent || '').includes(${JSON.stringify(parentGoal)}))`,
            16
        );
        await h.ev("new Promise((r) => setTimeout(r, 1200))");
        // task 9 removed the cockpit takeover: Open DAG opens a surface-local modal (the Brief stays
        // mounted underneath) instead of replacing the fleet view.
        const openClicked = await clickRetry(
            `[...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Open DAG'))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 1200))");
        const modalKindAfterOpen = await h.ev(
            `(() => (document.querySelector('[data-dag-modal-kind]') || {}).getAttribute?.('data-dag-modal-kind') || null)()`
        );
        const nodeCount = await h.ev(`(() => document.querySelectorAll('.react-flow__node').length)()`);
        const modalHeading = await h.ev(
            `(() => (document.querySelector('#dag-modal-heading') || {}).textContent || '')()`
        );
        const closeBtn = await h.ev(
            `(() => [...document.querySelectorAll('button')].some((x) => (x.textContent || '').includes('Close')))()`
        );
        rec(
            "5. Open DAG -> surface-local modal shows the live graph (3 nodes) with a heading",
            openClicked === true && modalKindAfterOpen === "live" && nodeCount >= 3 && modalHeading === "Route DAG",
            JSON.stringify({
                runClicked,
                openClicked,
                modalKind: modalKindAfterOpen,
                nodeCount,
                modalHeading,
                closeBtn,
            })
        );
        await h.shot("cdp-shots/dag-modal.png");
        // escape dismisses the modal (the modal state machine refuses close while launching, which is
        // not in play here; the Close button and backdrop click share the same path)
        const esc = await h.ev(`(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise((r) => setTimeout(r, 300));
            return true;
        })()`);
        const modalGone = await h.ev(`(() => !document.querySelector('[data-dag-modal-kind]'))()`);
        rec("6. Escape -> modal closes, no cockpit takeover", modalGone === true, JSON.stringify({ esc, modalGone }));

        // one DAG cancellation command owns the parent, children, and worker shutdown.
        await h.rpc("dagaction", { channelid: ctx.channelId, runid: runId, taskid: "", action: "cancel" });
        const channelsAfterCancel = await h.rpc("getchannels", null);
        const cancelledChannel = (channelsAfterCancel.channels || []).find((x) => x.oid === ctx.channelId) || {};
        const cancelledRuns = cancelledChannel.runs || [];
        const cancelledOwner = cancelledRuns.find((run) => run.id === runId);
        const cancelledChildren = cancelledRuns.filter((run) => run.dagoref === g.id && run.id !== runId);
        const cancelledDag = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
        const cascadeOk =
            cancelledOwner &&
            cancelledOwner.status === "cancelled" &&
            cancelledChildren.length > 0 &&
            cancelledChildren.every((run) => run.status === "cancelled") &&
            cancelledDag.status === "cancelled";
        rec(
            "7. DagAction cancel terminally cancels owner, children, and DAG",
            cascadeOk,
            JSON.stringify({
                owner: cancelledOwner && cancelledOwner.status,
                children: cancelledChildren.map((run) => ({ id: run.id, status: run.status })),
                dag: cancelledDag.status,
            })
        );

        await h.rpc("dagaction", { channelid: ctx.channelId, runid: runId, taskid: "", action: "cancel" });
        const repeatedDag = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
        const repeatedOwner = await getRun(runId);
        rec(
            "8. repeated DAG cancellation is idempotent",
            repeatedDag.status === "cancelled" && repeatedOwner && repeatedOwner.status === "cancelled",
            JSON.stringify({ owner: repeatedOwner && repeatedOwner.status, dag: repeatedDag.status })
        );
        return steps;
    },
    async teardown(h, ctx) {
        try {
            const res = await h.rpc("getchannels", null);
            const cc = (res.channels || []).find((x) => x.oid === ctx.channelId) || {};
            for (const run of cc.runs || []) {
                for (const phase of run.phases || []) {
                    for (const oref of phase.workerorefs || []) {
                        try {
                            const tab = await h.rpc("gettab", oref.slice(4));
                            const bid = tab && tab.blockids && tab.blockids[0];
                            if (bid) await h.rpc("deleteblock", { blockid: bid });
                        } catch {
                            // best-effort cleanup
                        }
                    }
                }
            }
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

const routePickerFlat = {
    name: "route-picker-flat",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const pressKey = async (key, windowsVirtualKeyCode) => {
            await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode });
        };
        await h.goto("settings");
        const pickerPresent = await h.ev(`(() => !!document.querySelector('[data-testid="route-picker"]'))()`);
        await h.ev(
            `(() => { document.querySelector('[data-testid="route-picker"]')?.scrollIntoView({ block: "center" }); return true; })()`
        );
        await settle(200);
        await h.ev(
            `(() => { const b = document.querySelector('[data-testid="route-picker"]'); if (b) b.click(); return true; })()`
        );
        await settle(400);
        const rowCount = await h.ev(`(() => document.querySelectorAll('[data-testid^="route-option-"]').length)()`);
        rec(
            "route picker opens with flat model rows",
            pickerPresent === true && rowCount > 0,
            `picker=${pickerPresent} rows=${rowCount}`
        );
        const layout = await h.ev(`(() => {
            const group = document.querySelector('[aria-label="Available routes"]');
            const panel = group?.parentElement;
            const scroll = document.querySelector('[data-testid="route-picker-scroll"]');
            if (!panel || !scroll) return null;
            const rect = panel.getBoundingClientRect();
            return {
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height,
                viewportHeight: window.innerHeight,
                overflowY: getComputedStyle(scroll).overflowY,
                scrollHeight: scroll.scrollHeight,
                clientHeight: scroll.clientHeight,
            };
        })()`);
        rec(
            "route picker stays within the viewport and scrolls model rows",
            layout != null &&
                layout.top >= 8 &&
                layout.bottom <= layout.viewportHeight - 8 &&
                layout.height <= 360 &&
                layout.overflowY === "auto" &&
                layout.scrollHeight > layout.clientHeight,
            JSON.stringify(layout)
        );
        const openFocus = await h.ev(`document.activeElement?.getAttribute('aria-label') ?? ''`);
        rec("opening the route picker focuses its filter", openFocus === "Filter models", `focus="${openFocus}"`);
        await pressKey("ArrowDown", 40);
        await settle(100);
        const arrowFocus = await h.ev(`document.activeElement?.getAttribute('data-testid') ?? ''`);
        rec(
            "ArrowDown moves focus from the filter to a model row",
            arrowFocus.startsWith("route-option-"),
            `focus="${arrowFocus}"`
        );
        await pressKey("Escape", 27);
        await settle(100);
        const escapeState = await h.ev(`(() => {
            const picker = document.querySelector('[data-testid="route-picker"]');
            return { expanded: picker?.getAttribute('aria-expanded'), focused: document.activeElement === picker };
        })()`);
        rec(
            "Escape closes the route picker and restores trigger focus",
            escapeState?.expanded === "false" && escapeState.focused === true,
            JSON.stringify(escapeState)
        );
        await h.ev(`document.querySelector('[data-testid="route-picker"]')?.click()`);
        await settle(400);
        await h.shot("cdp-shots/route-picker-flat.png");
        // filter shrinks the row set
        const filterTyped = await h.ev(`(() => {
            const input = document.querySelector('input[aria-label="Filter models"]');
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, "opus");
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await settle(300);
        const filteredCount = await h.ev(
            `(() => document.querySelectorAll('[data-testid^="route-option-"]').length)()`
        );
        rec(
            "filter shrinks model rows",
            filterTyped === true && filteredCount > 0 && filteredCount < rowCount,
            `rows=${rowCount} filtered=${filteredCount}`
        );
        // choosing a row updates the face off "capable"
        await h.ev(`(() => {
            const input = document.querySelector('input[aria-label="Filter models"]');
            if (input) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(input, "");
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const row = document.querySelector('[data-testid^="route-option-"]');
            if (row) row.click();
            return true;
        })()`);
        await settle(400);
        const face = await h.ev(
            `((document.querySelector('[data-testid="route-picker"]')||{}).textContent||'').trim()`
        );
        rec("face shows the chosen model", !face.includes("· capable"), `face="${face}"`);
        return steps;
    },
};

// --- harness config sync ------------------------------------------------------------------------
// The Settings section renders one row per catalog harness, driven by AgentSyncStatusCommand. This
// asserts the RPC reaches the surface at all; the reconciler's own behavior is unit-tested in Go.
// --- vault steering: the Steering tab shows each harness's real file, not just Arc's region ---
// The regression this replaces: the tab previewed only the ARC-STEERING region, so a harness with no
// region yet rendered as "(nothing projected here yet)" however much the user had written in it. The
// assert is deliberately about the whole file being reachable, not about the own zone being non-empty:
// after the rules are folded into Shared the own zone is empty ON PURPOSE, and an assert keyed to it
// would start failing exactly when the feature had been used correctly.
const vaultSteering = {
    name: "vault-steering",
    surface: "vault",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("vault");
        await h.ev(`(() => { document.querySelector('[data-vault-tab="steering"]')?.click(); return true; })()`);
        await h.ev("new Promise((r) => setTimeout(r, 600))");

        const status = await h.rpc("agentsyncstatus", null);
        const present = (status?.harnesses ?? []).filter((x) => x.present).map((x) => x.runtime);
        const tabs = await h.ev(
            `(() => [...document.querySelectorAll('[data-vault-doc-tab]')].map((n) => n.getAttribute('data-vault-doc-tab')))()`
        );
        steps.push({
            step: "steering -> a Shared tab plus one tab per catalog harness",
            ok:
                Array.isArray(tabs) &&
                tabs[0] === "shared" &&
                ["pi", "claude", "codex", "opencode"].every((r) => tabs.includes(r)),
            detail: `tabs=${JSON.stringify(tabs)}`,
        });
        await h.shot("cdp-shots/vault-steering-shared.png");

        for (const runtime of present) {
            await h.ev(
                `(() => { document.querySelector('[data-vault-doc-tab="${runtime}"]')?.click(); return true; })()`
            );
            await h.ev("new Promise((r) => setTimeout(r, 500))");
            const doc = await h.rpc("agentsyncharnessread", { runtime });
            // scoped to the steering pane, not the document: an unscoped textarea query picks up the
            // Agent surface's hidden inputs, and an unscoped path search matches the footer's vault path
            const shown = await h.ev(`(() => {
                const tab = document.querySelector('[data-vault-doc-tab]');
                let pane = tab; while (pane && !(pane.className || '').includes('overflow-hidden')) pane = pane.parentElement;
                if (!pane) return null;
                const ta = pane.querySelector('textarea');
                return { own: ta ? ta.value.length : -1, text: pane.innerText || '' };
            })()`);
            const fileBytes = (doc?.own?.length ?? 0) + (doc?.shared?.length ?? 0) + (doc?.memory?.length ?? 0);
            steps.push({
                step: `${runtime} tab -> names its real file and puts that file's own zone in the editor`,
                ok:
                    !!shown &&
                    fileBytes > 0 &&
                    shown.own === (doc?.own?.length ?? 0) &&
                    shown.text.includes(doc?.path ?? "\u0000"),
                detail: `own=${shown?.own} backendOwn=${doc?.own?.length ?? 0} shared=${doc?.shared?.length ?? 0} memory=${doc?.memory?.length ?? 0} path=${doc?.path}`,
            });
            await h.shot(`cdp-shots/vault-steering-${runtime}.png`);
        }

        // the collection line and its button must agree: an empty shared doc cannot offer a sync that
        // would dry-run to nothing, which is the contradiction the old line shipped with
        await h.ev(`(() => { document.querySelector('[data-vault-doc-tab="shared"]')?.click(); return true; })()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const line = await h.ev(`(() => {
            const tab = document.querySelector('[data-vault-doc-tab]');
            let pane = tab; while (pane && !(pane.className || '').includes('overflow-hidden')) pane = pane.parentElement;
            const ta = pane && pane.querySelector('textarea');
            const btn = [...document.querySelectorAll('button')].find((b) =>
                ["Sync harnesses", "Start the shared doc"].includes((b.textContent || '').trim())
            );
            return { empty: ta ? ta.value.trim().length === 0 : null, label: btn ? (btn.textContent || '').trim() : null };
        })()`);
        steps.push({
            step: "collection line agrees with its button (empty shared doc -> Start, otherwise Sync)",
            ok: line.empty !== null && line.label === (line.empty ? "Start the shared doc" : "Sync harnesses"),
            detail: JSON.stringify(line),
        });
        return steps;
    },
    async teardown() {},
};

// --- vault-records: the split ledger, and the one surface that reads a record read-only ----------------
// Four things this owns that no unit test can: that the ledger renders against a real dossier list, that the
// index survives a selection at desktop width, that archived work is reachable through the search box rather
// than dropped from the projection, and that the narrow window really is two views with a Back rather than
// two panes compressed. The status-is-not-a-button check is the cross-surface one: Vault must not grow a
// second status writer beside the Brief peek.
//
// A profile with no dossiers fails step 2 with that stated, not vacuously: an empty ledger renders no rows,
// and every assertion below would then be about nothing.
const vaultRecords = {
    name: "vault-records",
    surface: "vault",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

        const listed = await h.rpc("listtaskdossiers", null);
        const dossiers = listed?.dossiers ?? [];
        await h.goto("vault");
        await settle(600);

        // 1, read from the tab itself: a count on the collection line that disagrees with the list behind it
        // is the failure this catches.
        const tabLine = await h.ev(`(() => {
            const tab = document.querySelector('[data-vault-tab="records"]');
            return tab ? { text: (tab.innerText || '').replace(/\\s+/g, ' ').trim() } : null;
        })()`);
        rec(
            "1. the records collection tab is offered with the all-status count",
            tabLine != null && tabLine.text.includes("records") && tabLine.text.includes(String(dossiers.length)),
            JSON.stringify({ tabLine, dossiers: dossiers.length })
        );

        await h.ev(`(() => { document.querySelector('[data-vault-tab="records"]')?.click(); return true; })()`);
        await settle(700);

        const ledger = await h.ev(`(() => {
            const list = document.querySelector('[data-vault-record-list]');
            const groups = [...document.querySelectorAll('[data-vault-record-group]')].map((g) => ({
                status: g.dataset.vaultRecordGroup,
                label: (g.innerText || '').replace(/\\s+/g, ' ').trim(),
            }));
            const rows = [...document.querySelectorAll('[data-vault-record-row]')].length;
            return { list: !!list, groups, rows };
        })()`);
        if (ledger.rows === 0) {
            rec(
                "2. the ledger groups every status that has rows",
                false,
                "Vault Records requires at least one dossier"
            );
            return steps;
        }
        const groupStatuses = ledger.groups.map((g) => g.status);
        const order = ["active", "paused", "completed", "archived"];
        rec(
            "2. the ledger groups every status that has rows, in ledger order",
            ledger.list === true &&
                groupStatuses.length > 0 &&
                groupStatuses.every((s) => order.includes(s)) &&
                [...groupStatuses].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join() === groupStatuses.join(),
            JSON.stringify(ledger)
        );
        await h.shot("cdp-shots/vault-records-ledger.png");

        // 3. desktop width: index and record side by side, and the selection does not cost the list.
        await h.ev(`(() => { document.querySelector('[data-vault-record-row]')?.click(); return true; })()`);
        await settle(700);
        const selected = await h.ev(`(() => {
            const list = document.querySelector('[data-vault-record-list]');
            const pane = document.querySelector('[data-vault-record-pane]');
            const row = document.querySelector('[data-vault-record-row]');
            const status = document.querySelector('[data-record-status]');
            return {
                listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0,
                pane: pane ? pane.dataset.vaultRecordPane : null,
                objective: row ? (row.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : '',
                status: status ? status.dataset.recordStatus : null,
                detail: (document.querySelector('[data-record-timeline]') ? 'timeline' : '') + (status ? ' status' : ''),
            };
        })()`);
        rec(
            "3. selecting a row keeps the index visible at desktop width and renders that record",
            selected.listWidth > 0 &&
                selected.status != null &&
                selected.detail.includes("timeline") &&
                selected.objective !== "",
            JSON.stringify(selected)
        );

        // 4. archived work is browsable, not hidden. Searched by its own objective so the assertion is about
        // the projection surviving the filter rather than about the word "archived" appearing somewhere.
        const archived = dossiers.find((d) => d.status === "archived");
        if (archived == null) {
            rec(
                "4. an archived record is reachable through search",
                false,
                "no archived dossier in this profile — seed one before reading this as a pass"
            );
        } else {
            await h.ev(`(() => {
                const input = document.querySelector('input[placeholder="Search records…"]');
                if (!input) return false;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(input, ${JSON.stringify(archived.objective)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`);
            await settle(600);
            const filtered = await h.ev(`(() => {
                const rows = [...document.querySelectorAll('[data-vault-record-row]')];
                const groups = [...document.querySelectorAll('[data-vault-record-group]')].map((g) => g.dataset.vaultRecordGroup);
                const statuses = [...document.querySelectorAll('[data-vault-record-status]')].map((s) => s.dataset.vaultRecordStatus);
                return { rows: rows.length, groups, statuses };
            })()`);
            rec(
                "4. an archived record is reachable through search and still reads archived",
                filtered.rows === 1 && filtered.groups.join() === "archived" && filtered.statuses.join() === "archived",
                JSON.stringify({ archived: archived.objective, filtered })
            );
            // clear the filter so the narrow check below starts from the full ledger
            await h.ev(`(() => {
                const input = document.querySelector('input[placeholder="Search records…"]');
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(input, '');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`);
            await settle(500);
        }

        // 5. the cross-surface invariant: reading a record must not open a second status writer.
        const readOnly = await h.ev(`(() => {
            const status = document.querySelector('[data-record-status]');
            const add = [...document.querySelectorAll('button')].find((b) => /add decision/i.test(b.innerText || ''));
            return {
                statusTag: status ? status.tagName : null,
                add: !!add,
                // the Stage's transition controls read "→ completed" and would be a second writer
                transitions: [...document.querySelectorAll('button')].filter((b) => /^→ /.test((b.innerText || '').trim())).length,
            };
        })()`);
        rec(
            "5. Vault shows status read-only while Add decision is present",
            readOnly.statusTag != null &&
                readOnly.statusTag !== "BUTTON" &&
                readOnly.add === true &&
                readOnly.transitions === 0,
            JSON.stringify(readOnly)
        );

        // 6. narrow: one pane at a time with a Back. The threshold is a CSS media query (vaultrecords.tsx),
        // so this is the only place the live width actually decides what is rendered.
        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 800,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await settle(500);
        const narrowList = await h.ev(`(() => {
            const list = document.querySelector('[data-vault-record-list]');
            const back = document.querySelector('[data-vault-record-back]');
            return { list: list ? Math.round(list.getBoundingClientRect().width) : 0, back: back ? Math.round(back.getBoundingClientRect().width) : 0 };
        })()`);
        await h.ev(`(() => { document.querySelector('[data-vault-record-row]')?.click(); return true; })()`);
        await settle(600);
        const narrowDetail = await h.ev(`(() => {
            const list = document.querySelector('[data-vault-record-list]');
            const back = document.querySelector('[data-vault-record-back]');
            const status = document.querySelector('[data-record-status]');
            return {
                listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0,
                back: back ? Math.round(back.getBoundingClientRect().width) : 0,
                detail: status ? status.dataset.recordStatus : null,
            };
        })()`);
        await h.ev(`(() => { document.querySelector('[data-vault-record-back]')?.click(); return true; })()`);
        await settle(600);
        const narrowBack = await h.ev(`(() => {
            const list = document.querySelector('[data-vault-record-list]');
            return { listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0 };
        })()`);
        rec(
            "6. at a narrow width the row opens the record alone and Back returns to the index",
            narrowList.list === 0 &&
                narrowDetail.listWidth === 0 &&
                narrowDetail.back > 0 &&
                narrowDetail.detail != null &&
                narrowBack.listWidth > 0,
            JSON.stringify({ narrowList, narrowDetail, narrowBack })
        );
        // no viewport teardown: verify.mjs re-applies VERIFY_VIEWPORT after every scenario.
        return steps;
    },
    async teardown() {},
};

// --- brief-contextual-map: the Brief's two contextual entries, and its honest graph exits --------------
// In the Brief composition a source's "Ask Jarvis" primes one attached stateless thread rather than creating
// a persisted conversation, and the graph peek mounts with the Brief's own exits: a record closes into the
// peek, an Ask closes into the attached thread, and a run offers no control at all because B5 has not given
// runs a Stage sheet yet. The request payload that carries the attached oref is unit-tested
// (briefingstore.test.ts); this owns what the user can see of it.
const briefContextualMap = {
    name: "brief-contextual-map",
    surface: "vault",
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

        // 1. contextual entry into the Brief: one active chip and the suggested prompt, no Stage thread.
        await h.goto("vault");
        await settle(500);
        const asked = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-vault-saved-row]')];
            if (rows.length === 0) return false;
            rows[0].click();
            return true;
        })()`);
        await settle(400);
        const clicked = await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'Ask Jarvis');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await settle(700);
        const primed = await h.ev(`(() => {
            const input = document.querySelector('[data-jarvis-brief-composer="input"]');
            const scope = document.querySelector('[data-jarvis-brief-composer="scope"]');
            const chips = [...document.querySelectorAll('[data-jarvis-brief-band="composer"] [data-jarvis-brief-composer]')].length;
            return {
                brief: !!document.querySelector('[data-jarvis-region="brief"]'),
                surface: !!document.querySelector('[data-jarvis-region="surface"]'),
                draft: input ? input.value : null,
                scope: scope ? (scope.innerText || '').trim() : null,
                threadRows: document.querySelectorAll('[data-jarvis-brief-row="turn"]').length,
                composerHooks: chips,
            };
        })()`);
        rec(
            "1. Ask Jarvis from the Vault primes one attached Brief thread with the suggested prompt",
            asked === true &&
                clicked === true &&
                primed.brief === true &&
                primed.surface === false &&
                primed.threadRows === 0 &&
                typeof primed.draft === "string" &&
                primed.draft.length > 0 &&
                primed.scope != null &&
                primed.scope.length > 0,
            JSON.stringify(primed)
        );
        await h.shot("cdp-shots/brief-contextual-map-primed.png");

        // 2. Shift+G mounts the graph peek in Brief mode. The Stage-only keys must stay absent: the Brief
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
            "2. Shift+G opens the graph peek over the Brief",
            peek != null && peek.text.includes("Graph peek"),
            JSON.stringify(peek)
        );

        // 3. With nothing selected the overlay offers no node actions at all — the two exits are asserted
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
            "3. the graph peek opens over the Brief with no node selected, so no node action is offered",
            runControl != null && runControl.runs === 0 && runControl.ask === 0,
            JSON.stringify(runControl)
        );

        // 4. a task node closes into the record peek rather than onto a Stage that is not there. Reached
        //    through the record peek's own map button, which is the one route that names a record to focus.
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await settle(500);
        const closed = await h.ev(`document.querySelector('[data-jarvis-graph-peek]') == null`);
        rec("4a. Escape closes the graph peek and leaves the Brief", closed === true, "");

        const listed = await h.rpc("listtaskdossiers", null);
        if ((listed?.dossiers ?? []).length === 0) {
            rec("4b. a task node closes into the record peek", false, "Vault Records requires at least one dossier");
            return steps;
        }
        // the palette is the only in-app route from the Brief to a record (see brief-peek for the full
        // explanation): nothing on the Brief itself names one.
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
        );
        await settle(1200);
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
            "4b. the record peek's map button focuses its task node: one Open record, no run control",
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
            "4c. Open record closes the graph into the Brief's record peek",
            backToPeek === true && landed.peek === true && landed.graph === false,
            JSON.stringify({ backToPeek, landed })
        );
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- brief-restore: the stored subject, landed three different ways -------------------------------
// What the same stored value means now (briefrestore.ts): a dossier opens the record peek, a conversation
// hydrates the thread, and a channel opens its own sheet. Each case needs its own reload, because the
// restore is once per frontend load by design.
const briefRestore = {
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

        // 2. a conversation hydrates its turns and attached scope without submitting a new ask
        const convos = await h.rpc("listjarvisconversations", null);
        const convo = (convos?.conversations ?? [])[0];
        if (convo == null) {
            rec(
                "2. a stored conversation hydrates the Brief thread",
                false,
                "no persisted conversation in this profile — seed one before reading this as a pass"
            );
        } else {
            await withStored({ kind: "conversation", id: convo.id });
            const hydrated = await h.ev(`(() => {
                const thread = document.querySelector('[data-jarvis-brief-thread]');
                const rows = [...document.querySelectorAll('[data-jarvis-brief-row="turn"]')];
                const text = document.body.innerText || '';
                return {
                    thread: !!thread,
                    turns: rows.length,
                    // the in-flight marker is the one visible trace a submitted ask leaves
                    pending: text.includes('reading across your work'),
                    draft: (document.querySelector('[data-jarvis-brief-composer="input"]') || {}).value || '',
                };
            })()`);
            rec(
                "2. a stored conversation hydrates its turns without submitting a new ask",
                hydrated.thread === true && hydrated.turns > 0 && hydrated.pending === false && hydrated.draft === "",
                JSON.stringify({ id: convo.id, ...hydrated })
            );
            await h.shot("cdp-shots/brief-restore-thread.png");
        }

        // 3. the channel opens its OWN sheet: B5 gave a stored channel a destination, so it is now decided
        //    like every other kind — the id still existing is exactly what decides it.
        const chans = await h.rpc("getchannels", null);
        const channel = (chans?.channels ?? [])[0];
        if (channel == null) {
            rec(
                "3. a stored channel restores onto its sheet",
                false,
                "no channel in this profile — seed one before reading this as a pass"
            );
        } else {
            await withStored({ kind: "channel", id: channel.oid });
            const after = await h.ev(`(() => ({
                stored: localStorage.getItem('jarvis.subject.last'),
                brief: !!document.querySelector('[data-jarvis-region="brief"]'),
                peek: !!document.querySelector('[data-jarvis-brief-band="peek"]'),
                sheet: !!document.querySelector('[data-jarvis-brief-sheet="channel"]'),
            }))()`);
            let stored = null;
            try {
                stored = JSON.parse(after.stored ?? "null");
            } catch {
                stored = null;
            }
            rec(
                "3. a stored channel restores onto its own sheet",
                after.brief === true && after.sheet === true && after.peek === false && stored?.kind === "channel",
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

// --- brief-profile: both scopes of the profile modal, and the playbook override -----------------
// F4's re-home. The playbook editor and the global face lost their mount when B5 deleted profilepanel.tsx,
// which left a custom playbook and the global principles reachable only over the RPC. Read-only on purpose:
// it never presses Save, so it asserts the editors exist and the override toggles without writing a
// profile into whatever config dir the dev app is pointed at.
const briefProfile = {
    name: "brief-profile",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        await h.ev(`document.querySelector('[data-jarvis-brief-profile]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 1200))");

        const STATE = `(() => {
            const dlg = document.querySelector('[data-jarvis-brief-modal="profile"] [role="dialog"]');
            const txt = (el) => (el?.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                scope: dlg ? dlg.dataset.jarvisProfileScope : null,
                title: txt(dlg?.querySelector("header")),
                tabs: [...document.querySelectorAll('[data-jarvis-profile-tab]')].map((b) => b.dataset.jarvisProfileTab),
                sections: [...(dlg?.querySelectorAll("section") ?? [])].map((s) => txt(s).slice(0, 14)),
                editors: document.querySelectorAll('[data-jarvis-playbook="editor"]').length,
                summary: document.querySelectorAll('[data-jarvis-playbook="summary"]').length,
                phases: document.querySelectorAll('[data-jarvis-playbook="phase"]').length,
                globalPrinciples: document.querySelectorAll('[data-jarvis-global-principles="editor"] textarea').length,
                save: txt([...(dlg?.querySelectorAll("footer button") ?? [])][0]),
                saveDisabled: [...(dlg?.querySelectorAll("footer button") ?? [])][0]?.disabled ?? null,
            };
        })()`;

        const project = await h.ev(STATE);
        steps.push({
            step: "1. the modal opens on this project, with both scopes offered",
            ok:
                project.scope === "project" &&
                project.tabs.join(",") === "project,global" &&
                project.sections.length === 3 &&
                project.saveDisabled === true,
            detail: JSON.stringify(project),
        });

        // an inherited playbook is stated, not editable: the project has not said anything different yet
        steps.push({
            step: "2. the inherited playbook reads as a summary, with no editor under it",
            ok: project.summary === 1 && project.editors === 0 && project.phases === 0,
            detail: JSON.stringify({ summary: project.summary, editors: project.editors, phases: project.phases }),
        });

        await h.ev(
            `[...document.querySelectorAll('[data-jarvis-brief-modal="profile"] button')].find((b) => b.innerText.trim() === 'customize')?.click()`
        );
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const customized = await h.ev(STATE);
        steps.push({
            step: "3. customize copies the inherited phases into an editable override",
            ok:
                customized.editors === 1 &&
                customized.summary === 0 &&
                customized.phases > 0 &&
                customized.saveDisabled === false,
            detail: JSON.stringify(customized),
        });

        await h.ev(
            `[...document.querySelectorAll('[data-jarvis-brief-modal="profile"] section button')].find((b) => b.innerText.trim() === 'reset')?.click()`
        );
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const resetted = await h.ev(STATE);
        steps.push({
            step: "4. reset drops the override, so the draft is clean again",
            ok: resetted.summary === 1 && resetted.editors === 0 && resetted.saveDisabled === true,
            detail: JSON.stringify(resetted),
        });

        await h.ev(`document.querySelector('[data-jarvis-profile-tab="global"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        const global = await h.ev(STATE);
        steps.push({
            step: "5. the global face edits the playbook and the principles every project inherits",
            ok:
                global.scope === "global" &&
                global.title.toLowerCase().includes("global defaults") &&
                global.editors === 1 &&
                global.globalPrinciples > 0 &&
                global.save.toLowerCase() === "save global defaults" &&
                global.saveDisabled === true,
            detail: JSON.stringify(global),
        });

        await h.shot("cdp-shots/brief-profile.png");
        return steps;
    },
    async teardown(h) {
        await h.ev(
            `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close profile')?.click()`
        );
        await h.goto("cockpit");
    },
};

export const SCENARIOS = [
    vaultSteering,
    vaultRecords,
    briefContextualMap,
    briefRestore,
    runsLifecycle,
    terminalTheme,
    tuiLeader,
    tuiFullscreen,
    gitHistory,
    surfaceSmoke,
    codeSearch,
    codeSidebar,
    codeGitStatus,
    codeDiff,
    codeMarkdown,
    jarvisAvatar,
    briefSurface,
    briefPeek,
    briefProfile,
    jarvisAsk,
    jarvisContextual,
    jarvisMultiturn,
    jarvisVaultRecall,
    jarvisPeek,
    jarvisVolunteer,
    usageCharts,
    attentionCrossChannel,
    harnessPicker,
    dagLifecycle,
    routePickerFlat,
];
