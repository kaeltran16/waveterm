// Brief peek scenarios: the brief's peeks, ctrl-click, item views, contextual map, record band.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    PEEKS_ESC,
    TREE_RAIL_LEAD_ID,
    arrangeFixtureRun,
    failRpc,
    floorDetail,
    floorOk,
    flatText,
    floorStep,
    holdRpc,
    lookEval,
    paintEval,
    polishWaitFor,
    releaseRpc,
    setInputExpr,
    teardownFixtureRun,
} from "./scenarios-shared.mjs";

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
        // the log leaves through PaneReveal's exit (durExit), so poll for its absence rather than sleep past it
        await polishWaitFor(h, `!document.querySelector('${LOG}')`, 2000);
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
        // the form leaves through PaneReveal's exit, so it stays attached for the fade: poll for its absence
        const escAt = Date.now();
        const formLeft = await polishWaitFor(h, `!document.querySelector('${LOG} [data-jarvis-decision-form]')`, 2000);
        const formLeftMs = formLeft ? Date.now() - escAt : null;
        const afterEsc = await h.ev(`(() => {
            const form = document.querySelector('${LOG} [data-jarvis-decision-form]');
            const wrap = form?.parentElement;
            return {
                form: form != null,
                add: document.querySelector('${LOG} [data-jarvis-decision-add]') != null,
                peek: document.querySelector('${BAND}') != null,
                // when the form is stuck, its exit wrapper's inline style tells a stalled exit from one never begun
                wrapStyle: wrap ? wrap.getAttribute('style') : null,
            };
        })()`);
        steps.push({
            step: "13. Escape in the Add decision form closes the form and leaves the peek open",
            ok: typed === true && afterEsc.form === false && afterEsc.add === true && afterEsc.peek === true,
            detail: JSON.stringify({ typed, formLeftMs, afterEsc }),
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

// --- brief-contextual-map: the Brief's honest graph exits ---------------------------------------------
// The graph peek mounts with the Brief's own exits: a record closes into the peek, and a run offers no
// control at all because B5 has not given runs a Stage sheet yet. It used to open by priming an attached
// thread from a memory note's "Ask Jarvis"; that entry point went with the Vault surface, and the exits
// below never depended on it. The surviving contextual entry is a run.
// Steps 4-10 (the graph peek's bloom states, deduped edges, Find and the linked-only canvas) run on fixtures written
// straight into the vault: a record and a decision that each wikilink the other, a record no link reaches, and a run
// attached to the first record. The run's goal slugs to the record's id, so its capture collides and stays out.
// Labels stay inside the canvas's 40-character title cut, the only part Find matches and the edge rows show.
const GRAPH_MAP_RECORD = "verify-graph-map-linked-record";
const GRAPH_MAP_GOAL = "verify graph map linked record";
const GRAPH_MAP_DECISION = "verify-graph-map-decision";
const GRAPH_MAP_DECISION_SUMMARY = "Graph-map decision, linked both ways";
const GRAPH_MAP_ISOLATED = "verify-graph-map-isolated";
const GRAPH_MAP_ISOLATED_QUERY = "isolated graph-map record";

async function seedGraphMapVault(h) {
    const root = await vaultRoot(h);
    const stamp = Date.now() - 30 * DAY_MS;
    const record = (objective, body) =>
        [
            "---",
            "status: active",
            'ticket: ""',
            `objective: ${JSON.stringify(objective)}`,
            "acceptance: []",
            "confidence: med",
            `created: ${stamp}`,
            `updated: ${stamp}`,
            "---",
            // the machine blocks a captured record has: acceptdossieredge writes into refs
            ...["state", "refs", "blockers"].flatMap((name) => [`<!-- jarvis:begin ${name} -->`, `<!-- jarvis:end ${name} -->`]),
            "",
            "## Notes",
            "",
            body,
            "",
        ].join("\n");
    const tasks = join(root, "tasks", "active");
    const decisions = join(root, "decisions");
    mkdirSync(tasks, { recursive: true });
    mkdirSync(decisions, { recursive: true });
    const files = [
        [
            join(tasks, `${GRAPH_MAP_RECORD}.md`),
            record("Verify graph-map: a record linked both ways to its decision.", `See [[${GRAPH_MAP_DECISION}]].`),
        ],
        [
            join(tasks, `${GRAPH_MAP_ISOLATED}.md`),
            record("Isolated graph-map record, no links", ""),
        ],
        [
            join(decisions, `${GRAPH_MAP_DECISION}.md`),
            [
                "---",
                `id: ${GRAPH_MAP_DECISION}`,
                `created: ${stamp}`,
                `summary: ${JSON.stringify(GRAPH_MAP_DECISION_SUMMARY)}`,
                "actor: human",
                "provenance: human-submit",
                "status: active",
                "---",
                "",
                `Written back to [[${GRAPH_MAP_RECORD}]], so the pair links both ways.`,
                "",
            ].join("\n"),
        ],
    ];
    for (const [file, text] of files) writeFileSync(file, text);
    return files.map(([file]) => file);
}

// what the canvas draws, from the same derive the peek hands it: the merged graph cut by visibleGraph
const GRAPH_DRAWN = `
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const st = await mod("app/view/jarvis/jarvisgraphstore.ts");
    const d = await mod("app/view/jarvis/jarvisgraphderive.ts");
    const merged = d.mergeGraph(globalStore.get(st.graphBaseAtom) ?? { nodes: [], links: [] }, globalStore.get(st.graphBloomAtom));
    const selected = globalStore.get(st.graphSelectedIdAtom);
    const drawn = d.visibleGraph(merged, selected).nodes;
    return { selected, total: merged.nodes.length, drawn: drawn.map((n) => n.id), kinds: d.presentKinds(drawn) };
`;

export const briefContextualMap = {
    name: "brief-contextual-map",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-graph-map-")) };
        try {
            ctx.files = await seedGraphMapVault(h);
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-graph-map", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: GRAPH_MAP_GOAL,
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            await h.rpc("acceptdossieredge", { dossierid: GRAPH_MAP_RECORD, runoref: `run:${ctx.runId}` });
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
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

        await graphMapSteps(h, ctx, rec, settle);
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`brief-contextual-map teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("release the bloom RPC", () => releaseRpc(h, "ResolveDossierEdgesCommand"));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("close the graph peek", () =>
            lookEval(h, `const s = await mod("app/view/jarvis/jarvisstore.ts"); s.closeGraphPeek();`)
        );
        if (ctx?.runId) await step("cancel the run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId }));
        if (ctx?.channelId) await step("delete the channel", () => h.rpc("deletechannel", { channelid: ctx.channelId }));
        for (const f of ctx?.files ?? []) await step(`remove ${f}`, () => rmSync(f, { force: true }));
        if (ctx?.cwd) await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await h.goto("cockpit");
    },
};

// Steps 4-10: the graph peek opened on a record with a run. The bloom is held, then refused, then let through, so
// each Edges state is seen; then the deduped decision edge, an edge row's click, Find onto a record the canvas does
// not draw, Shift+G's close and reopen, and the legend at 1000x700.
async function graphMapSteps(h, ctx, rec, settle) {
    if (ctx?.arrangeError) {
        rec("4. the graph-map fixtures were seeded", false, ctx.arrangeError);
        return;
    }
    const PEEK = `document.querySelector('[data-jarvis-graph-peek]')`;
    const EDGES = `${PEEK}?.querySelector('[data-jarvis-graph-edges]')`;
    const pressShiftG = () =>
        h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', shiftKey: true, bubbles: true }))`);
    const pressEscape = () =>
        h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`);
    const readEdges = () =>
        h.ev(`(() => {
            const el = ${EDGES};
            if (!el) return null;
            return {
                state: el.querySelector('[data-jarvis-graph-edges-state]')?.dataset.jarvisGraphEdgesState ?? null,
                retry: el.querySelector('[data-jarvis-graph-retry]') != null,
                rows: [...el.querySelectorAll('[data-jarvis-graph-edge]')].map((b) => ({
                    id: b.dataset.jarvisGraphEdge,
                    text: (b.textContent || '').replace(/\\s+/g, ' ').trim(),
                })),
                text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
            };
        })()`);
    // through the record peek's map button, the route a user takes; the record's bloom is dropped first, so an
    // earlier step that bloomed it cannot answer from cache
    const openFromRecord = async () => {
        await lookEval(h, `const st = await mod("app/view/jarvis/jarvisgraphstore.ts"); st.invalidateBloom(${JSON.stringify(GRAPH_MAP_RECORD)});`);
        await h.ev(`window.__openAddress?.(${JSON.stringify("task:" + GRAPH_MAP_RECORD)})`);
        const mapReady = await polishWaitFor(h, `document.querySelector('[data-jarvis-peek-open-graph]') != null`, 6000);
        await h.ev(`document.querySelector('[data-jarvis-peek-open-graph]')?.click()`);
        const opened = await polishWaitFor(h, `${EDGES} != null`, 6000);
        return mapReady && opened;
    };
    const closePeek = async () => {
        await pressEscape();
        await polishWaitFor(h, `${PEEK} == null`, 3000);
    };

    // 4. held: the bloom is in flight, so Edges says so rather than claiming the record has none
    await holdRpc(h, "ResolveDossierEdgesCommand");
    const heldOpen = await openFromRecord();
    await settle(400);
    const held = await readEdges();
    await h.shot("cdp-shots/brief-graph-edges-loading.png");
    rec(
        "4a. a record's bloom in flight reads Loading edges…, never No edge reaches this node",
        heldOpen === true && held?.state === "loading" && /Loading edges…/.test(held.text) && !/No edge reaches/.test(held.text),
        JSON.stringify({ heldOpen, held })
    );
    await closePeek();

    // refused: the failure is shown with a Retry, and a Retry once the RPC answers lands the run rows
    await releaseRpc(h, "ResolveDossierEdgesCommand");
    await failRpc(h, "ResolveDossierEdgesCommand", "verify: bloom refused");
    const failedOpen = await openFromRecord();
    await polishWaitFor(h, `${EDGES}?.querySelector('[data-jarvis-graph-retry]') != null`, 4000);
    const failed = await readEdges();
    await h.shot("cdp-shots/brief-graph-edges-failed.png");
    await releaseRpc(h, "ResolveDossierEdgesCommand");
    await h.ev(`${EDGES}?.querySelector('[data-jarvis-graph-retry]')?.click()`);
    const runOref = `run:${ctx.runId}`;
    await polishWaitFor(h, `${EDGES}?.querySelector('[data-jarvis-graph-edge=${JSON.stringify(runOref)}]') != null`, 20000);
    const retried = await readEdges();
    rec(
        "4b. a refused bloom reads Couldn't load edges with Retry; Retry lands the record's run row",
        failedOpen === true &&
            failed?.state === "failed" &&
            failed.retry === true &&
            /Couldn.t load edges/.test(failed.text) &&
            retried?.state == null &&
            retried.rows.some((r) => r.id === runOref),
        JSON.stringify({ failed, retried })
    );

    // 5. the decision wikilinks the record and the record wikilinks it back: one row, named by its summary
    const decisionRows = (retried?.rows ?? []).filter((r) => r.id === GRAPH_MAP_DECISION);
    rec(
        "5. a decision linked both ways lists one edge row, labelled by its summary",
        decisionRows.length === 1 && decisionRows[0].text.includes(GRAPH_MAP_DECISION_SUMMARY),
        JSON.stringify({ decisionRows })
    );

    // 6. an edge row is a way to the node at its other end
    await h.ev(`${EDGES}?.querySelector('[data-jarvis-graph-edge=${JSON.stringify(GRAPH_MAP_DECISION)}]')?.click()`);
    const selectedDecision = await polishWaitFor(
        h,
        `${PEEK}?.querySelector('[data-jarvis-graph-selected=${JSON.stringify(GRAPH_MAP_DECISION)}]') != null`,
        3000
    );
    await h.shot("cdp-shots/brief-graph-edge-select.png");
    rec("6. clicking an edge row selects the node at its other end", selectedDecision === true, "");

    // 7. F4: the canvas draws what is linked plus the selection, and the header says how many it leaves out
    const before = await lookEval(h, GRAPH_DRAWN);
    const count = await h.ev(flatText(`${PEEK}?.querySelector('[data-jarvis-graph-count]')`));
    const m = /^(\d+) of (\d+) nodes$/.exec(count ?? "");
    rec(
        "7. the header reads <shown> of <total> nodes, and a record no link reaches is not drawn",
        m != null &&
            Number(m[1]) === before.drawn.length &&
            Number(m[2]) === before.total &&
            before.drawn.length < before.total &&
            !before.drawn.includes(GRAPH_MAP_ISOLATED),
        JSON.stringify({ count, drawn: before.drawn.length, total: before.total })
    );

    // 8. Find onto that record: the pick shows the selected node, keeps the query one control away, and draws it
    const FIND = `${PEEK}?.querySelector('input[aria-label="Find a node"]')`;
    await h.ev(setInputExpr(FIND, GRAPH_MAP_ISOLATED_QUERY));
    await polishWaitFor(h, `${PEEK}?.querySelector('[data-jarvis-graph-match=${JSON.stringify(GRAPH_MAP_ISOLATED)}]') != null`, 3000);
    const matchCount = await h.ev(`${PEEK}?.querySelectorAll('[data-jarvis-graph-match]').length ?? 0`);
    await h.ev(`${PEEK}?.querySelector('[data-jarvis-graph-match=${JSON.stringify(GRAPH_MAP_ISOLATED)}]')?.click()`);
    await settle(500);
    const pickedView = await h.ev(`(() => ({
        selected: ${PEEK}?.querySelector('[data-jarvis-graph-selected]')?.dataset.jarvisGraphSelected ?? null,
        list: ${PEEK}?.querySelector('[data-jarvis-graph-matches]') != null,
        back: (${PEEK}?.querySelector('[data-jarvis-graph-back]')?.textContent || '').trim(),
        query: ${FIND}?.value ?? null,
    }))()`);
    const after = await lookEval(h, GRAPH_DRAWN);
    await h.shot("cdp-shots/brief-graph-find-pick.png");
    rec(
        "8. picking a Find match shows the selected node with Back to N matches, and draws it on the canvas",
        pickedView.selected === GRAPH_MAP_ISOLATED &&
            pickedView.list === false &&
            pickedView.back === `← Back to ${matchCount} match${matchCount === 1 ? "" : "es"}` &&
            pickedView.query === GRAPH_MAP_ISOLATED_QUERY &&
            after.drawn.includes(GRAPH_MAP_ISOLATED),
        JSON.stringify({ matchCount, pickedView, drawnIsolated: after.drawn.includes(GRAPH_MAP_ISOLATED) })
    );

    // 9. Shift+G closes the peek and forgets the record it was opened on, so the next Shift+G opens on nothing
    await h.ev(`document.activeElement?.blur()`);
    await pressShiftG();
    const closedByKey = await polishWaitFor(h, `${PEEK} == null`, 3000);
    await pressShiftG();
    await polishWaitFor(h, `${PEEK} != null`, 3000);
    await settle(600);
    const reopened = await lookEval(
        h,
        `const { globalStore } = await mod("app/store/jotaiStore.ts");
        const s = await mod("app/view/jarvis/jarvisstore.ts");
        const st = await mod("app/view/jarvis/jarvisgraphstore.ts");
        return {
            record: globalStore.get(s.briefGraphRecordAtom),
            selected: globalStore.get(st.graphSelectedIdAtom),
            panel: document.querySelector('[data-jarvis-graph-peek] [data-jarvis-graph-selected]') != null,
        };`
    );
    rec(
        "9. Shift+G closes the peek, and Shift+G again opens it with no record selected",
        closedByKey === true && reopened.record == null && reopened.selected == null && reopened.panel === false,
        JSON.stringify({ closedByKey, reopened })
    );
    await closePeek();

    // 10. at 1000x700, focused on the record: the legend names only the kinds the canvas draws
    await h.cdp("Emulation.setDeviceMetricsOverride", BRIEF_PEEK_NARROW);
    try {
        await settle(400);
        await openFromRecord();
        // read once the bloom has landed, so the drawn set and the legend describe the same graph
        await polishWaitFor(h, `${EDGES}?.querySelector('[data-jarvis-graph-edge=${JSON.stringify(runOref)}]') != null`, 20000);
        await settle(600);
        const drawn = await lookEval(h, GRAPH_DRAWN);
        const legend = await h.ev(
            `[...(${PEEK}?.querySelectorAll('[data-jarvis-graph-legend] [data-kind]') ?? [])].map((e) => e.dataset.kind)`
        );
        await h.shot("cdp-shots/brief-graph-legend-narrow.png");
        rec(
            "10. at 1000x700 the legend lists only the kinds drawn",
            Array.isArray(legend) && legend.length > 0 && JSON.stringify(legend) === JSON.stringify(drawn.kinds),
            JSON.stringify({ legend, kinds: drawn.kinds })
        );
        await closePeek();
    } finally {
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    }
}

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
// the heads share more than the server's 40-rune label cut, so only a label keeping their ends tells them apart
const RECORD_BAND_TWINS = [
    { id: "verify-record-band-twin-a", head: "Verify the record band tells apart two records on one ticket: twin A." },
    { id: "verify-record-band-twin-b", head: "Verify the record band tells apart two records on one ticket: twin B." },
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
        writeRecordBandRecord(dir, t.id, RECORD_BAND_TICKET, `${t.head}\n${RECORD_BAND_FILLER.trim()}`, stamp)
    );
}

// steps 12-15 (F3, F5, F6): two records in one project and window, each confirmed onto its own lead run, and a
// third lead run there that neither refs. Every run in the project is a structural guess of each record anchored
// on it; a run claimed by one record is no guess of the other. Each run's goal is its record's id as words, so
// its capture collides with the record written first and the arrange attaches it explicitly; the third run takes
// pair A's goal, so its capture collides too and it stays unclaimed. Objectives run long, so the chips truncate.
const RECORD_BAND_PAIR = [
    {
        key: "a",
        id: "verify-record-band-pair-a",
        ticket: "VERIFY-2202",
        head: "Verify record-band pair A owns the first of three runs in one project, and its sibling's run is no guess of it.",
    },
    {
        key: "b",
        id: "verify-record-band-pair-b",
        ticket: "VERIFY-2203",
        head: "Verify record-band pair B owns the second of three runs in one project, and its sibling's run is no guess of it.",
    },
];
const recordBandPairGoal = (key) => `verify record-band pair ${key}`;

async function seedRecordBandPair(h) {
    const dir = join(await vaultRoot(h), "tasks", "active");
    mkdirSync(dir, { recursive: true });
    const stamp = Date.now() - 30 * DAY_MS;
    return RECORD_BAND_PAIR.map((p) =>
        writeRecordBandRecord(dir, p.id, p.ticket, `${p.head} ${RECORD_BAND_FILLER.trim()}`, stamp)
    );
}

// keys a (pair A's), b (pair B's) and u (neither's), each on its own channel in the pair's one project
async function arrangeRecordBandPair(h, pair) {
    pair.files = await seedRecordBandPair(h);
    const wslist = await h.rpc("workspacelist", null);
    for (const key of ["a", "b", "u"]) {
        const ch = await h.rpc("createchannel", { name: `verify-record-band-pair-${key}`, projectpath: pair.cwd });
        pair.channels.push(ch.oid);
        const created = await h.rpc("createrun", {
            channelid: ch.oid,
            workspaceid: wslist[0].workspacedata.oid,
            goal: recordBandPairGoal(key === "u" ? "a" : key),
            runtime: "claude",
            mode: "quick",
            deferstart: true,
        });
        pair.runs[key] = created.run.id;
    }
    for (const p of RECORD_BAND_PAIR) {
        await h.rpc("acceptdossieredge", { dossierid: p.id, runoref: `run:${pair.runs[p.key]}` });
    }
}

async function teardownRecordBandPair(h, pair) {
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`record-band-detach-restore teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    // detached first, so the accept log claims no run of a record the next pass writes again under this id
    for (const p of RECORD_BAND_PAIR) {
        if (pair.runs[p.key]) {
            await step(`detach pair ${p.key}`, () =>
                h.rpc("detachdossieredge", { dossierid: p.id, runoref: `run:${pair.runs[p.key]}` })
            );
        }
    }
    for (const [i, channelId] of pair.channels.entries()) {
        const runId = pair.runs[["a", "b", "u"][i]];
        if (runId) await step(`cancel pair run ${runId}`, () => h.rpc("cancelrun", { channelid: channelId, runid: runId }));
        await step(`delete pair channel ${channelId}`, () => h.rpc("deletechannel", { channelid: channelId }));
    }
    await step("remove the pair's temp dir", () => rmSync(pair.cwd, { recursive: true, force: true }));
    for (const file of pair.files ?? []) {
        await step(`remove ${file}`, () => rmSync(file, { force: true }));
    }
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
            // its own catch: a failed pair fails steps 12-15, not the band steps before them
            ctx.pair = { cwd: mkdtempSync(join(tmpdir(), "verify-record-band-pair-")), channels: [], runs: {} };
            try {
                await arrangeRecordBandPair(h, ctx.pair);
            } catch (e) {
                ctx.pair.error = String(e?.message ?? e);
            }
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
            const rows = chips().map((c) => {
                const text = c.querySelector("[data-jarvis-edge-text]");
                const head = text?.firstElementChild;
                const end = head?.nextElementSibling;
                // the twins differ only in their last runes: those must be drawn inside the label, however narrow
                const last = (() => {
                    const node = end?.querySelector("[dir=ltr]")?.firstChild;
                    if (!node) return null;
                    const r = document.createRange();
                    r.setStart(node, Math.max(0, node.length - 2));
                    r.setEnd(node, node.length);
                    return r.getBoundingClientRect();
                })();
                const t = text?.getBoundingClientRect();
                return {
                    id: c.getAttribute("title"),
                    label: (text?.textContent || "").trim(),
                    headCut: !!head && head.scrollWidth > head.clientWidth,
                    end: end?.textContent ?? null,
                    endShown: !!last && !!t && last.width > 0 && last.left >= t.left - 0.5 && last.right <= t.right + 0.5,
                    ticket: c.querySelector("[data-jarvis-edge-ticket]")?.textContent?.trim() ?? null,
                    edge: c.querySelector("[data-jarvis-edge-label]")?.textContent?.trim() ?? null,
                };
            });
            const distinct = (k) => new Set(rows.map((r) => r[k])).size === rows.length;
            return { ok, rows, distinct: distinct("label"), endsDistinct: distinct("end") };
        })()`);
        rec(
            "8. expanded, two records on one ticket whose objectives share a long prefix keep the label ends that tell them apart in view, and each carries the ticket chip",
            twinRows.ok === true &&
                twinRows.distinct === true &&
                twinRows.endsDistinct === true &&
                twinRows.rows.every((r) => r.endShown) &&
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

        // 12-15: the 11-05 Brief live pass on the pair (arrange). pairBand opens a run's sheet, waits for its band to
        // name one of `first`, expands it until every record in `want` has a row, and measures each expanded row: its
        // chip, and the "open this record" link that must stay on one line inside the row.
        const pair = ctx.pair ?? { runs: {} };
        const [pairA, pairB] = RECORD_BAND_PAIR;
        // two evaluates, as each holds one 25s wait under the 30s cap
        const pairBand = async (runId, first, want) => {
            const head = await h.ev(`(async () => {
                ${RECORD_BAND_LIB}
                const opened = await window.__openAddress(${JSON.stringify(`run:${runId ?? ""}`)});
                const first = ${JSON.stringify(first)};
                const shown = await until(() =>
                    first.includes(${RECORD_BAND}?.querySelector("[data-jarvis-band-toggle] [data-jarvis-edge-chip]")?.getAttribute("title"))
                );
                return { opened: opened?.ok ?? null, shown };
            })()`);
            const body = await h.ev(`(async () => {
                ${RECORD_BAND_LIB}
                const toggle = () => ${RECORD_BAND}?.querySelector("[data-jarvis-band-toggle]");
                const want = ${JSON.stringify(want)};
                if (toggle()?.getAttribute("aria-expanded") !== "true") toggle()?.click();
                const chips = () => [...(${RECORD_BAND}?.querySelectorAll("[data-jarvis-edge-chip]") ?? [])].filter((c) => !toggle()?.contains(c));
                const ids = () => chips().map((c) => c.getAttribute("title"));
                const expanded = await until(() => want.every((id) => ids().includes(id)));
                await new Promise((r) => setTimeout(r, 400));
                const rows = chips().map((c) => {
                    const row = c.closest("button")?.parentElement;
                    const link = [...(row?.querySelectorAll("span") ?? [])].find((s) => (s.textContent || "").trim() === "open this record");
                    return {
                        id: c.getAttribute("title"),
                        edge: c.querySelector("[data-jarvis-edge-label]")?.textContent?.trim() ?? null,
                        linkLines: link?.getClientRects().length ?? 0,
                        rowScroll: row?.scrollWidth ?? 0,
                        rowClient: row?.clientWidth ?? 0,
                    };
                });
                return { expanded, rows };
            })()`);
            return { ...head, ...body };
        };
        const linksOneLine = (band) =>
            band.rows.length > 0 && band.rows.every((r) => r.linkLines === 1 && r.rowScroll <= r.rowClient);
        const PAIR_STEPS = {
            f5: "12. F5: at 1600x950 a run confirmed onto record A shows A confirmed and no guessed row for record B",
            f6wide: "13. F6: at 1600x950 every expanded band row's open this record link is one line inside its row",
            f6narrow: "14. F6: at 1000x700 every expanded band row's open this record link is one line inside its row",
            f3: "15. F3: at 1600x950 record A's peek lists its own run and the run no record claims under Runs on this record, and not record B's run",
        };
        // without the pair every wait below would run out its 25s for nothing
        if (pair.error != null || pair.runs.u == null) {
            for (const step of Object.values(PAIR_STEPS)) rec(step, false, pair.error ?? "the arrange made no pair");
            return steps;
        }

        const f5 = await pairBand(pair.runs.a, [pairA.id], [pairA.id]);
        await h.shot("cdp-shots/record-band-12-claimed-run.png");
        rec(
            PAIR_STEPS.f5,
            f5.opened === true &&
                f5.expanded === true &&
                f5.rows.some((r) => r.id === pairA.id && r.edge === "confirmed") &&
                !f5.rows.some((r) => r.id === pairB.id),
            JSON.stringify(f5)
        );

        // the unclaimed run is a guess of both records, so its band has two rows to measure
        const pairIds = RECORD_BAND_PAIR.map((p) => p.id);
        const f6wide = await pairBand(pair.runs.u, pairIds, pairIds);
        await h.shot("cdp-shots/record-band-13-links-wide.png");
        rec(
            PAIR_STEPS.f6wide,
            f6wide.expanded === true && f6wide.rows.length >= pairIds.length && linksOneLine(f6wide),
            JSON.stringify(f6wide)
        );
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
        await new Promise((r) => setTimeout(r, 500));
        const f6narrow = await pairBand(pair.runs.u, pairIds, pairIds);
        await h.shot("cdp-shots/record-band-14-links-narrow.png");
        rec(
            PAIR_STEPS.f6narrow,
            f6narrow.expanded === true && f6narrow.rows.length >= pairIds.length && linksOneLine(f6narrow),
            JSON.stringify(f6narrow)
        );
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);

        const f3 = await h.ev(`(async () => {
            ${RECORD_BAND_LIB}
            ${PEEKS_ESC};
            await new Promise((r) => setTimeout(r, 400));
            await window.__openAddress(${JSON.stringify(`task:${pairA.id}`)});
            const peek = '[data-jarvis-brief-band="peek"]';
            const runIds = () => [...document.querySelectorAll(peek + " [data-jarvis-peek-run]")].map((r) => r.getAttribute("data-jarvis-peek-run"));
            const want = ${JSON.stringify([pair.runs.a, pair.runs.u])};
            const listed = await until(() => want.every((id) => runIds().includes(id)));
            return {
                listed,
                record: document.querySelector(peek + " [data-jarvis-peek-record]")?.getAttribute("data-jarvis-peek-record") ?? null,
                runs: runIds(),
            };
        })()`);
        await h.shot("cdp-shots/record-band-15-record-runs.png");
        rec(
            PAIR_STEPS.f3,
            f3.listed === true &&
                f3.record === pairA.id &&
                f3.runs.includes(pair.runs.a) &&
                f3.runs.includes(pair.runs.u) &&
                !f3.runs.includes(pair.runs.b),
            JSON.stringify({ ...f3, a: pair.runs.a, b: pair.runs.b, u: pair.runs.u })
        );
        await h.ev(PEEKS_ESC);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        if (ctx.pair != null) await teardownRecordBandPair(h, ctx.pair);
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
