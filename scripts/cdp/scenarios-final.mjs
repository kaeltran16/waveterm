// Final stage scenarios: Final's screenshots, rerun and stage.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pinDefaultView, restoreDefaultView } from "./agent-page-fixtures.mjs";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    FST_CHECK,
    FST_DETAIL,
    FST_FINAL_FAILURES,
    FST_FINAL_KEPT,
    FST_FINAL_SCENARIO,
    FST_FINAL_TAIL,
    FST_UNVERIFIED,
    FST_VERIFY_KEPT,
    RAIL_VISIBLE_KEY,
    RUN_SHEET_POLISH_TASKS,
    TREE_RAIL_FIXTURE,
    TREE_RAIL_LEAD_ID,
    arrangeFixtureRun,
    arrangeSheetDagRun,
    channelRuns,
    fstRound3Dir,
    fstShow,
    fstWriteRun,
    polishNap,
    polishWaitFor,
    seedDag,
    seedFinalShots,
    teardownFixtureRun,
    treeRailRoster,
    waitForDispatch,
    waveService,
} from "./scenarios-shared.mjs";
import {
    RV_WIDE,
    rvOpenDag,
    rvCloseDag,
    DAG_PEEK_FINAL_SEL,
    dagPeekCard,
    dagPeekOpen,
    FS_VIEWER,
    fstHolds,
    fstSame,
    fstGitInit,
} from "./scenarios-runs.mjs";

// the root engine trees live under, as pkg/orchestrate/worktreeroot.go resolves it from os.UserCacheDir
function arcWorktreeRoot() {
    const cache =
        process.platform === "win32"
            ? process.env.LOCALAPPDATA
            : process.platform === "darwin"
              ? join(homedir(), "Library", "Caches")
              : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(cache, "arc-wt");
}

// --- final-shots: the Final check row, dock button and viewer (.superpowers/design/final-shots) ------------
// A deferred run's dag is rewritten through object.UpdateObject with a Final command, a failed round 1 kept in
// pastfinals and an unverified round 2, both carrying the Viewer board's manifest. Their out dirs are temp dirs of
// PNGs captured from the app itself, with round 1's jarvis-peek-narrow left off disk. The dag is then re-seeded for
// the States board's rows. Nothing touches its tasks or status, so it is never finalizing and the engine never
// starts a final stage on it; the chained plan dispatches t-1, which teardown's run cancel stops.
const FINAL_SHOTS_MISSING = "jarvis-peek-narrow";
// the fix round's row counts one shot more than round 1 had (States board: 16 shots)
const FINAL_SHOTS_EXTRA = { "surface-smoke": ["surface-agent"] };
const FINAL_SHOTS_PLAIN = ["checkout-empty", "checkout-filled", "receipt"];
// the fixture PNGs, by the surface each is captured on. Never through h.shot, which records evidence shots
const FINAL_SHOTS_CAPTURES = {
    cockpit: ["surface-smoke", "surface-cockpit"],
    jarvis: [
        "surface-jarvis",
        "brief-peek",
        "peek-ctrl-click",
        "jarvis-peek",
        "jarvis-peek-narrow",
        "jarvis-peek-busy",
        "jarvis-peek-empty",
        "resource-linking",
    ],
    usage: ["surface-usage", "checkout-filled"],
    files: ["surface-files", "receipt"],
    settings: ["surface-settings", "checkout-empty"],
    code: ["surface-code"],
    setup: ["surface-setup"],
    agent: ["surface-agent"],
};
// crops, so the shots differ in size the way real ones do; the rest are the whole viewport
const FINAL_SHOTS_CLIPS = {
    "brief-peek": { x: 800, y: 0, width: 800, height: 950 },
    "peek-ctrl-click": { x: 520, y: 150, width: 560, height: 640 },
    "jarvis-peek-narrow": { x: 1160, y: 530, width: 440, height: 420 },
    "jarvis-peek-busy": { x: 0, y: 0, width: 1200, height: 760 },
    receipt: { x: 400, y: 100, width: 800, height: 600 },
};
const FS_P = "pass";
const FS_F = "fail";
const FS_S = "skip";
// the Viewer board's five scenarios; round 2 passed the two jarvis-peek steps the fix round fixed
const FINAL_SHOTS_BOARD = [
    {
        name: "surface-smoke",
        shots: ["surface-smoke", "surface-cockpit", "surface-jarvis", "surface-usage", "surface-files", "surface-settings", "surface-code", "surface-setup"],
        steps: [
            [FS_P, 'goto cockpit -> active nav "Cockpit", content non-empty', "active=Cockpit contentLen=1643"],
            [FS_P, 'goto jarvis -> active nav "Jarvis", content non-empty', "active=Jarvis contentLen=1378"],
            [FS_P, 'goto usage -> active nav "Usage", content non-empty', "active=Usage contentLen=1909"],
            [FS_P, 'goto files -> active nav "Diff", content non-empty', "active=Diff contentLen=1349"],
            [FS_P, 'goto settings -> active nav "Settings", content non-empty', "active=Settings contentLen=2036"],
            [FS_P, 'goto code -> active nav "Code", content non-empty', "active=Code contentLen=1377"],
            [FS_P, 'goto setup -> active nav "Setup", content non-empty', "active=Setup contentLen=2123"],
            [FS_P, "wsh notify -> the avatar says it once, with no toast, and the bubble leaves", "bubble=true toast=false gone=true"],
            [FS_S, "steer input visible on a pi session card", "no pi session focused in this run - focus one before reading this as a pass (the manual round-trip covers it)"],
        ],
    },
    {
        name: "brief-peek",
        shots: ["brief-peek"],
        steps: [
            [FS_P, "1. the Brief is showing and no peek is open yet"],
            [FS_P, "2. a record row in the palette opens the peek, with its updated stamp and status toggle"],
            [FS_P, "2b. the peek names the record's fleet or says it has none"],
            [FS_P, "3. the peek's attributed run opens the run's sheet, resolved rather than pending"],
            [FS_P, "4. the status picker offers only legal transitions, and the current status is a label"],
            [FS_P, "5. Escape closes the peek and leaves the Brief behind it"],
        ],
    },
    {
        name: "peek-ctrl-click",
        shots: ["peek-ctrl-click"],
        steps: [
            [FS_P, "1. the Brief shows a peekable run row"],
            [FS_P, "2. Ctrl+click opens a ready run item view in the 560px popup"],
            [FS_P, "3. the host surface, subject, sheet flag and scroll are unchanged while the peek is up"],
            [FS_P, "4. Escape closes the popup and the host's state still matches"],
        ],
    },
    {
        name: "jarvis-peek",
        shots: ["jarvis-peek", "jarvis-peek-narrow", "jarvis-peek-busy", "jarvis-peek-empty"],
        steps: [
            [FS_P, "1. keyboard open renders a labelled dialog of header/queue/composer and focuses its container"],
            [FS_P, "2. Tab starts at Full view and reverse traversal stays inside the dialog"],
            [FS_P, "3. the quiet card states queue absence once, and the composer is live wherever there is a destination"],
            [FS_F, "4. the narrow panel stays bounded with a pinned header, no horizontal overflow, and an unclipped harness picker"],
            [FS_F, "5. attention expands the card and keyboard navigation moves the cursor then focuses the composer"],
            [FS_P, "6. Escape, close, and backdrop dismiss only the peek and return focus to the creature"],
            [FS_P, "7. dismissing the global peek stays on the current surface"],
        ],
    },
    {
        name: "resource-linking",
        shots: ["resource-linking"],
        steps: [
            [FS_P, "1. the DEV hook that opens an address is installed on the Brief"],
            [FS_P, "2. a record address opens the record's peek"],
            [FS_S, "3. a decision address opens its record's peek"],
            [FS_P, "4. a memory address opens nothing and leaves the surface where it was"],
            [FS_P, "5. an address nothing can open shows the toast and leaves the surface where it was"],
        ],
    },
];

function finalShotsManifest(round, extra = {}) {
    return FINAL_SHOTS_BOARD.map((sc) => ({
        name: sc.name,
        files: [...sc.shots, ...(extra[sc.name] ?? [])].map((f) => `cdp-shots/${f}.png`),
        steps: sc.steps.map(([state, step, detail]) => ({
            step,
            state: round === 2 && state === FS_F ? FS_P : state,
            ...(detail ? { detail } : {}),
        })),
    }));
}

async function captureFinalShotsFixture(h) {
    const pngs = {};
    for (const [surface, names] of Object.entries(FINAL_SHOTS_CAPTURES)) {
        await h.goto(surface);
        for (const name of names) {
            const clip = FINAL_SHOTS_CLIPS[name];
            const { data } = await h.cdp("Page.captureScreenshot", {
                format: "png",
                ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
            });
            pngs[name] = Buffer.from(data, "base64");
        }
    }
    return pngs;
}

// the out dirs the engine would have made: <out>/<round>/cdp-shots/*.png, and the plain listing's PNGs at its top
function writeFinalShotsFixture(out, pngs) {
    for (const round of [1, 2]) {
        mkdirSync(join(out, String(round), "cdp-shots"), { recursive: true });
        for (const sc of finalShotsManifest(round, FINAL_SHOTS_EXTRA)) {
            for (const file of sc.files) {
                const name = file.slice("cdp-shots/".length, -".png".length);
                if (round === 1 && name === FINAL_SHOTS_MISSING) continue;
                writeFileSync(join(out, String(round), file), pngs[name]);
            }
        }
    }
    mkdirSync(join(out, "plain"), { recursive: true });
    for (const name of FINAL_SHOTS_PLAIN) writeFileSync(join(out, "plain", `${name}.png`), pngs[name]);
    mkdirSync(join(out, "empty"), { recursive: true });
}

// the stages of every seed, by the board row each one draws
function finalShotsStages(out) {
    const dir = (sub) => `${out.replace(/\\/g, "/")}/${sub}`;
    const round1 = (extra) => ({
        state: "failed",
        round: 1,
        outdir: dir(1),
        shots: finalShotsManifest(1, extra),
        shotsmanifest: true,
    });
    return {
        main: {
            final: { state: "unverified", round: 2, outdir: dir(2), shots: finalShotsManifest(2), shotsmanifest: true },
            pastfinals: [round1()],
        },
        fixing: { final: { state: "", round: 2 }, pastfinals: [round1(FINAL_SHOTS_EXTRA)] },
        passed: {
            final: { state: "passed", round: 1, outdir: dir(2), shots: finalShotsManifest(2), shotsmanifest: true },
            pastfinals: [],
        },
        empty: { final: { state: "unverified", round: 1, outdir: dir("empty"), shotsmanifest: false }, pastfinals: [] },
        plain: {
            final: {
                state: "passed",
                round: 1,
                outdir: dir("plain"),
                shots: FINAL_SHOTS_PLAIN.map((name) => ({ name, files: [`${name}.png`] })),
                shotsmanifest: false,
            },
            pastfinals: [],
        },
    };
}

const FS_ROW = `document.querySelector("[data-run-sheet] [data-run-sheet-final-shots]")`;
const FS_DOCK = `document.querySelector("[data-run-sheet] [data-run-sheet-final-shots-dock]")`;
// the viewer is portaled to body, so it is read on its own, not inside the run sheet
const FS_READ = `(() => {
    const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
    const row = ${FS_ROW};
    const header = row?.querySelector(":scope > button[aria-expanded]");
    const dock = ${FS_DOCK};
    const v = ${FS_VIEWER};
    let viewer = null;
    if (v) {
        const film = [...v.querySelectorAll('button[aria-pressed][aria-label$=".png"]')];
        const zoom = [...v.querySelectorAll("button[aria-pressed]")].find((b) => /^(Fit|Actual size)$/.test(flat(b)));
        const steps = v.querySelector("button[aria-expanded]");
        const drawer = v.querySelector('aside[aria-label="Steps"]');
        const img = v.querySelector("img[alt]:not([alt=''])");
        viewer = {
            text: flat(v.firstElementChild),
            rounds: [...v.querySelectorAll('[role="group"][aria-label="Round"] button')].map((b) => ({
                text: flat(b),
                on: b.getAttribute("aria-pressed") === "true",
            })),
            tabs: [...v.querySelectorAll('[role="tab"]')].map((t) => ({
                text: flat(t),
                on: t.getAttribute("aria-selected") === "true",
                hollow: t.querySelector("span.border-muted") != null,
            })),
            film: film.map((b) => ({ name: b.getAttribute("aria-label"), on: b.getAttribute("aria-pressed") === "true" })),
            path: film[0]?.parentElement?.querySelector(":scope > span")?.textContent ?? null,
            zoom: zoom ? { text: flat(zoom), on: zoom.getAttribute("aria-pressed") === "true" } : null,
            steps: steps ? { text: flat(steps), expanded: steps.getAttribute("aria-expanded") } : null,
            drawer: drawer ? { fails: [...drawer.querySelectorAll("span")].filter((s) => s.textContent === "FAIL").length } : null,
            img: img ? { loaded: img.complete && img.naturalWidth > 0, alt: img.alt } : null,
            missing: flat(v.querySelector("[data-final-shots-missing]")) || null,
        };
    }
    const link = row ? [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open the viewer") : null;
    return {
        sheet: document.querySelector("[data-run-sheet]") != null,
        row: header ? { expanded: header.getAttribute("aria-expanded"), text: flat(header) } : null,
        thumbs: row
            ? [...row.querySelectorAll('button[aria-label^="Open "]')].map((b) => ({
                  name: b.getAttribute("aria-label").slice("Open ".length),
                  img: b.querySelector("img") != null,
              }))
            : [],
        caption: link ? flat(link.parentElement) : null,
        dock: dock
            ? {
                  text: flat(dock),
                  disabled: dock.disabled,
                  accent: dock.classList.contains("border-accent"),
                  focused: document.activeElement === dock,
              }
            : null,
        viewer,
    };
})()`;
// what the Jarvis surface under the viewer has selected: its list cursor and the run its sheet shows
const FS_JARVIS = `(() => ({
    cursor: document.querySelector("[data-jarvis-brief-cursor]")?.textContent.trim().slice(0, 80) ?? null,
    sheet: (document.querySelector("[data-jarvis-brief-sheet] > header")?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 160),
}))()`;
const FS_KEYS = {
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowRight: "ArrowRight",
    z: "KeyZ",
    s: "KeyS",
    Escape: "Escape",
};
const FS_WAIT_MS = 8000;

// polls the run sheet and viewer until ok holds or the wait runs out, and returns the last read either way
async function finalShotsUntil(h, ok, ms = FS_WAIT_MS) {
    for (let waited = 0; ; waited += 250) {
        const s = await h.ev(FS_READ).catch(() => null);
        if ((s != null && ok(s)) || waited >= ms) return s;
        await polishNap(250);
    }
}

const finalShotsClick = (h, expr) =>
    h.ev(`(() => {
        const el = ${expr};
        if (!el) return false;
        // a real click focuses its button, and the viewer hands focus back to whatever held it
        el.focus();
        el.click();
        return true;
    })()`);

// a DOM key event at the focused element: CDP's Input.dispatchKeyEvent often never reaches the WebView, and the
// keybinding dispatcher and the run sheet's Escape both listen on window, which this reaches the same way
const finalShotsKey = (h, key) =>
    h.ev(`(() => {
        const target = document.activeElement ?? document.body;
        const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(FS_KEYS[key])}, bubbles: true, cancelable: true };
        const down = new KeyboardEvent("keydown", init);
        target.dispatchEvent(down);
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return down.defaultPrevented;
    })()`);

const FS_BOARD_ORDER = ["surface-smoke", "brief-peek", "peek-ctrl-click", "jarvis-peek", "resource-linking"];

export const finalShotsScenario = {
    name: "final-shots",
    surface: "jarvis",
    async arrange(h) {
        const out = mkdtempSync(join(tmpdir(), "verify-final-shots-out-"));
        let pngs;
        try {
            // before the run exists: arrangeSheetDagRun ends on the Brief with the sheet open
            pngs = await captureFinalShotsFixture(h);
            writeFinalShotsFixture(out, pngs);
        } catch (e) {
            return { out, arrangeError: String(e?.message ?? e) };
        }
        const ctx = await arrangeSheetDagRun(h, "final-shots", RUN_SHEET_POLISH_TASKS);
        ctx.out = out;
        ctx.stages = finalShotsStages(out);
        if (ctx.arrangeError != null) return ctx;
        try {
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
            if (!ctx.dagId) throw new Error("the run has no dag");
            await seedFinalShots(h, ctx, ctx.stages.main);
            ctx.rowShown = (await finalShotsUntil(h, (s) => s.row != null, 15_000))?.row != null;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened on a dag seeded with two finished rounds",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.rowShown === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, dagId: ctx.dagId, opened: ctx.opened })
        );
        if (ctx.arrangeError != null) return steps;

        let s = await finalShotsUntil(h, (x) => x.row?.text.includes("15 shots") && x.dock != null);
        rec(
            "1. the row is collapsed with unverified · 5 scenarios and 15 shots · 2 rounds; the dock reads Screenshots · 15",
            s?.row?.expanded === "false" &&
                s.row.text.includes("unverified · 5 scenarios") &&
                s.row.text.includes("15 shots · 2 rounds") &&
                s.dock?.text === "Screenshots · 15" &&
                !s.dock.disabled &&
                !s.dock.accent,
            JSON.stringify({ row: s?.row, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-1-row-closed.png", { step: shotStep(steps, "1") });

        await finalShotsClick(h, `${FS_ROW}?.querySelector(":scope > button[aria-expanded]")`);
        s = await finalShotsUntil(h, (x) => x.row?.expanded === "true" && x.thumbs.length > 0 && x.thumbs.every((t) => t.img));
        rec(
            "2. the opened row shows one thumbnail per scenario and the round-1 caption",
            s?.row?.expanded === "true" &&
                JSON.stringify(s.thumbs.map((t) => t.name)) === JSON.stringify(FS_BOARD_ORDER) &&
                s.thumbs.every((t) => t.img) &&
                (s.caption ?? "").includes("Round 1 failed on jarvis-peek steps 4 and 5."),
            JSON.stringify({ thumbs: s?.thumbs, caption: s?.caption })
        );
        await h.shot("cdp-shots/final-shots-2-row-open.png", { step: shotStep(steps, "2") });
        // the States rows below are drawn collapsed
        await finalShotsClick(h, `${FS_ROW}?.querySelector(":scope > button[aria-expanded]")`);

        await finalShotsClick(h, FS_DOCK);
        s = await finalShotsUntil(h, (x) => x.viewer?.img?.loaded === true && x.viewer.film.length > 0);
        let v = s?.viewer;
        rec(
            "3. the dock opens the viewer on round 2: tabs, shot, filmstrip and path, the drawer closed on a passing scenario",
            v != null &&
                v.rounds.length === 2 &&
                v.rounds.find((r) => r.on)?.text === "Round 2 unverified" &&
                v.tabs.length === 5 &&
                v.tabs[0].on &&
                v.tabs[0].text.startsWith("surface-smoke") &&
                v.img?.loaded === true &&
                v.film.length === 8 &&
                v.film[0].on &&
                (v.path ?? "").endsWith("/2/cdp-shots/surface-smoke.png") &&
                v.steps?.expanded === "false" &&
                v.drawer == null,
            JSON.stringify(v)
        );
        await h.shot("cdp-shots/final-shots-3-viewer.png", { step: shotStep(steps, "3") });

        await finalShotsClick(
            h,
            `[...(${FS_VIEWER}?.querySelectorAll('[role="group"][aria-label="Round"] button') ?? [])].find((b) => b.innerText.trim().startsWith("Round 1"))`
        );
        s = await finalShotsUntil(
            h,
            (x) => x.viewer?.tabs[0]?.text.startsWith("jarvis-peek") && x.viewer.drawer != null && x.viewer.img?.loaded === true
        );
        v = s?.viewer;
        rec(
            "4. round 1 puts jarvis-peek first with the drawer open on its two failing steps",
            v != null &&
                v.rounds.find((r) => r.on)?.text === "Round 1 failed" &&
                v.tabs[0].on &&
                v.tabs[0].text.startsWith("jarvis-peek") &&
                v.steps?.expanded === "true" &&
                v.drawer?.fails === 2,
            JSON.stringify({ rounds: v?.rounds, tab: v?.tabs[0], steps: v?.steps, drawer: v?.drawer })
        );
        await h.shot("cdp-shots/final-shots-4-round-1.png", { step: shotStep(steps, "4") });

        // ArrowUp/Down are the Jarvis list's keys too, and with the sheet open they would open the next run
        const before = await h.ev(FS_JARVIS);
        const keys = {};
        await finalShotsKey(h, "ArrowDown");
        keys.down = (await finalShotsUntil(h, (x) => x.viewer?.tabs[1]?.on === true, 2000))?.viewer?.tabs.findIndex((t) => t.on);
        await finalShotsKey(h, "ArrowUp");
        keys.up = (await finalShotsUntil(h, (x) => x.viewer?.tabs[0]?.on === true, 2000))?.viewer?.tabs.findIndex((t) => t.on);
        await finalShotsKey(h, "z");
        keys.zoom = (await finalShotsUntil(h, (x) => x.viewer?.zoom?.on === true, 2000))?.viewer?.zoom;
        await finalShotsKey(h, "s");
        s = await finalShotsUntil(h, (x) => x.viewer?.steps?.expanded === "false" && x.viewer.drawer == null, 2000);
        keys.steps = { steps: s?.viewer?.steps, drawer: s?.viewer?.drawer };
        await h.shot("cdp-shots/final-shots-5-keys.png", { step: shotStep(steps, "5") });
        await finalShotsKey(h, "z");
        keys.fit = (await finalShotsUntil(h, (x) => x.viewer?.zoom?.on === false, 2000))?.viewer?.zoom;
        await finalShotsKey(h, "ArrowRight");
        s = await finalShotsUntil(h, (x) => x.viewer?.film[1]?.on === true, 2000);
        keys.right = s?.viewer?.film.findIndex((f) => f.on);
        const after = await h.ev(FS_JARVIS);
        rec(
            "5. ArrowRight moves the filmstrip, z toggles Actual size, s toggles the drawer, and the Jarvis selection stays put",
            keys.down === 1 &&
                keys.up === 0 &&
                keys.zoom?.text === "Actual size" &&
                keys.steps.steps?.expanded === "false" &&
                keys.steps.drawer == null &&
                keys.fit?.text === "Fit" &&
                keys.right === 1 &&
                JSON.stringify(after) === JSON.stringify(before),
            JSON.stringify({ keys, before, after })
        );

        s = await finalShotsUntil(h, (x) => x.viewer?.missing != null);
        rec(
            "6. the file left off disk shows No longer on disk with its path",
            (s?.viewer?.missing ?? "").includes("No longer on disk") &&
                s.viewer.missing.includes(`/1/cdp-shots/${FINAL_SHOTS_MISSING}.png`),
            JSON.stringify({ missing: s?.viewer?.missing })
        );
        await h.shot("cdp-shots/final-shots-6-missing.png", { step: shotStep(steps, "6") });
        await finalShotsClick(h, `${FS_VIEWER}?.querySelector('button[aria-label="Close"]')`);
        await finalShotsUntil(h, (x) => x.viewer == null, 3000);

        await seedFinalShots(h, ctx, ctx.stages.fixing);
        s = await finalShotsUntil(h, (x) => x.row?.text.includes("16 shots") === true);
        rec(
            "7. failed during the fix round: failed · jarvis-peek 2 steps, 16 shots · round 1, an accent dock",
            s?.row?.text.includes("failed · jarvis-peek 2 steps") &&
                s.row.text.includes("16 shots · round 1") &&
                s.dock?.text === "Screenshots · 16" &&
                s.dock.accent &&
                !s.dock.disabled,
            JSON.stringify({ row: s?.row, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-7-fixing.png", { step: shotStep(steps, "7") });

        await seedFinalShots(h, ctx, ctx.stages.passed);
        s = await finalShotsUntil(h, (x) => x.row?.text.includes("passed · 5 scenarios") === true);
        rec(
            "8a. passed: passed · 5 scenarios, 15 shots, a plain dock",
            s?.row?.text.includes("passed · 5 scenarios") &&
                s.row.text.endsWith("15 shots") &&
                s.dock?.text === "Screenshots · 15" &&
                !s.dock.accent &&
                !s.dock.disabled,
            JSON.stringify({ row: s?.row, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-8a-passed.png", { step: shotStep(steps, "8a") });

        await seedFinalShots(h, ctx, ctx.stages.empty);
        s = await finalShotsUntil(h, (x) => x.row?.text.includes("no screenshots") === true);
        rec(
            "8b. unverified with no shots: unverified · no screenshots, the dock disabled at 0",
            s?.row?.text.includes("unverified · no screenshots") && s.dock?.text === "Screenshots · 0" && s.dock.disabled === true,
            JSON.stringify({ row: s?.row, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-8b-empty.png", { step: shotStep(steps, "8b") });

        await seedFinalShots(h, ctx, ctx.stages.plain);
        s = await finalShotsUntil(h, (x) => x.row?.text.includes("passed · 3 screenshots") === true);
        const plainRow = { row: s?.row, dock: s?.dock };
        await finalShotsClick(h, FS_DOCK);
        s = await finalShotsUntil(h, (x) => x.viewer?.img?.loaded === true);
        v = s?.viewer;
        rec(
            "8c. a plain PNG listing: passed · 3 screenshots, hollow-dot entries in the viewer, no Steps button",
            plainRow.row?.text.includes("passed · 3 screenshots") &&
                plainRow.row.text.includes("3 shots") &&
                plainRow.dock?.text === "Screenshots · 3" &&
                v != null &&
                JSON.stringify(v.tabs.map((t) => t.text)) === JSON.stringify(FINAL_SHOTS_PLAIN.map((n) => `${n}.png`)) &&
                v.tabs.every((t) => t.hollow) &&
                v.steps == null &&
                v.drawer == null &&
                v.rounds.length === 0 &&
                v.text.includes("Round 1 passed"),
            JSON.stringify({ ...plainRow, viewer: v })
        );
        await h.shot("cdp-shots/final-shots-8c-plain.png", { step: shotStep(steps, "8c") });

        await finalShotsKey(h, "Escape");
        await finalShotsUntil(h, (x) => x.viewer == null, 3000);
        // the run sheet's own Escape would close it a beat later, so the check waits past that
        await polishNap(600);
        s = await h.ev(FS_READ);
        rec(
            "9. Esc closes the viewer, leaves the run sheet open and hands focus back to the dock button",
            s?.viewer == null && s.sheet === true && s.dock?.focused === true,
            JSON.stringify({ viewer: s?.viewer != null, sheet: s?.sheet, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-9-closed.png", { step: shotStep(steps, "9") });

        await finalShotsPastRounds(h, ctx, rec, steps);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch((e) => {
            console.error(`final-shots teardown: clear the viewport override failed: ${e?.message ?? e}`);
        });
        if (ctx.cwd) await teardownFixtureRun(h, ctx, "final-shots");
        rmSync(ctx.out, { recursive: true, force: true });
    },
};

// the step a shot shows, for h.shot's tag (the Final tab names a screenshot by it): a shot named for its step's id
// (final-stage-b5-failed-pane is B5's, final-shots-8a-passed is 8a's) is that step's once it is recorded, else, taken
// before it, the step recorded next
function shotStep(steps, id) {
    const head = `${id.charAt(0).toUpperCase()}${id.slice(1)}. `;
    const at = steps.findLastIndex((st) => st.step.startsWith(head));
    return at >= 0 ? at : steps.length;
}

// round 2 failed at Verify, so its Final command never ran and it kept no screenshots; the engine writes the detail so
const FS_VERIFY_FAILED = "Verify `node scripts/verify.mjs ./pkg/waveobj` failed (exit 1):\nFAIL\tpkg/waveobj\t0.4s";
const FS_ROUND2_EMPTY = "Round 2 ended at Verify, before the Final command ran.";
const FS_PAST = (round) => `${dagPeekCard(DAG_PEEK_FINAL_SEL)}?.querySelector('[data-final-past-round="${round}"]')`;
const fsRoundButton = (prefix) =>
    `[...(${FS_VIEWER}?.querySelectorAll('[role="group"][aria-label="Round"] button') ?? [])].find((b) => b.innerText.trim().startsWith(${JSON.stringify(prefix)}))`;

// F22 at 1600x950: an earlier round's line in the DAG's Final peek, and a round that ended before it took any shots
async function finalShotsPastRounds(h, ctx, rec, steps) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    let seeded = "ok";
    try {
        // round 1 as the main seed kept it, with its failure detail so its line opens
        const round1 = { ...ctx.stages.main.pastfinals[0], detail: FST_DETAIL };
        await seedFinalShots(h, ctx, { final: { state: "failed", round: 2, detail: FS_VERIFY_FAILED }, pastfinals: [round1] });
    } catch (e) {
        seeded = String(e?.message ?? e);
    }
    const opened = await rvOpenDag(h, ctx.runId);
    const peek = await dagPeekOpen(h, DAG_PEEK_FINAL_SEL, "final");
    await polishWaitFor(h, `!!${FS_PAST(1)}?.querySelector("[data-final-past-round-shots]")`, 5000);
    await h.ev(`${FS_PAST(1)}?.click()`);
    const detailShown = await polishWaitFor(h, `!!${FS_PAST(1)}?.parentElement?.querySelector("[data-final-past-round-detail]")`, 3000);
    const detail = await h.ev(`(${FS_PAST(1)}?.parentElement?.querySelector("[data-final-past-round-detail]")?.textContent ?? "").trim()`);
    await h.shot("cdp-shots/final-shots-10-past-round.png", { step: shotStep(steps, "10") });
    await h.ev(`${FS_PAST(1)}?.querySelector("[data-final-past-round-shots]")?.click()`);
    let s = await finalShotsUntil(h, (x) => x.viewer?.rounds.some((r) => r.on) === true);
    const onRound = s?.viewer?.rounds.find((r) => r.on)?.text ?? null;
    rec(
        "10. F22: in the DAG's Final peek, round 1's line opens its failure detail, and its screenshots link opens the viewer on round 1",
        seeded === "ok" &&
            opened &&
            peek &&
            detailShown &&
            detail.startsWith(FST_DETAIL.split("\n")[0]) &&
            (onRound ?? "").startsWith("Round 1"),
        JSON.stringify({ seeded, opened, peek, detailShown, detail: detail.slice(0, 120), onRound, rounds: s?.viewer?.rounds })
    );

    await finalShotsClick(h, fsRoundButton("Round 2"));
    await polishWaitFor(h, `!!${FS_VIEWER}?.querySelector("[data-final-shots-empty]")`, 3000);
    const empty = await h.ev(`(${FS_VIEWER}?.querySelector("[data-final-shots-empty]")?.textContent ?? "").trim()`);
    s = await h.ev(FS_READ);
    await h.shot("cdp-shots/final-shots-11-round-2-empty.png", { step: shotStep(steps, "11") });
    rec(
        "11. F22: the viewer on round 2, which failed at Verify, says where the round ended",
        (s?.viewer?.rounds.find((r) => r.on)?.text ?? "").startsWith("Round 2") && empty === FS_ROUND2_EMPTY,
        JSON.stringify({ empty, rounds: s?.viewer?.rounds })
    );
    await finalShotsClick(h, `${FS_VIEWER}?.querySelector('button[aria-label="Close"]')`);
    await finalShotsUntil(h, (x) => x.viewer == null, 3000);
    await rvCloseDag(h);
}

// --- final-rerun: a failed final stage runs again from the run sheet ------------------------------------------
// The dag is seeded with a failed round 1 while t-1 is still at work, so the engine leaves the stage alone. The
// rerun resets it to round 1 not started, which the same busy dag then keeps.

const FR_BTN = `document.querySelector("[data-run-sheet] [data-final-rerun]")`;
const finalRerunSeed = {
    state: "failed",
    round: 1,
    detail: "Check `docker info` failed (exit 1):\ndocker is not running",
};
const finalRerunPrint = (dag) => JSON.stringify([dag?.final?.state ?? null, dag?.final?.round ?? null]);

export const finalRerunScenario = {
    name: "final-rerun",
    surface: "jarvis",
    async arrange(h) {
        const ctx = await arrangeSheetDagRun(h, "final-rerun", RUN_SHEET_POLISH_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
            if (!ctx.dagId) throw new Error("the run has no dag");
            await seedDag(h, ctx, (dag) => ({ ...dag, final: finalRerunSeed }), finalRerunPrint);
            ctx.shown = await polishWaitFor(h, `${FR_BTN} != null`, 15_000);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened on a dag seeded with a failed final stage",
            ctx.arrangeError == null && ctx.opened?.ok === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, dagId: ctx.dagId, opened: ctx.opened })
        );
        if (ctx.arrangeError != null) return steps;
        const label = await h.ev(`${FR_BTN}?.textContent.trim() ?? null`);
        rec("1. the dock offers Rerun final stage", ctx.shown === true && label === "Rerun final stage", JSON.stringify({ label }));
        await h.shot("cdp-shots/final-rerun-1-offered.png");

        await h.ev(`${FR_BTN}?.click()`);
        const gone = await polishWaitFor(h, `${FR_BTN} == null`, 15_000);
        const dag = await waveService(h, "object", "GetObject", [`dag:${ctx.dagId}`]);
        rec(
            "2. the click reruns the stage: round 1 not started, and the button is gone",
            gone && dag?.final?.state === "" && dag?.final?.round === 1 && (dag?.final?.detail ?? "") === "",
            JSON.stringify({ gone, final: dag?.final })
        );
        const error = await h.ev(`document.querySelector("[data-run-sheet] .text-error")?.textContent ?? null`);
        rec("3. the engine refused nothing", error == null, JSON.stringify({ error }));
        await h.shot("cdp-shots/final-rerun-2-rerun.png");
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx.cwd) await teardownFixtureRun(h, ctx, "final-rerun");
    },
};

// --- final-stage: the final stage's tree row, pane, rail block and DAG node ---------------------------------
// Two parts on one run (docs/reference/cdp-run-fixtures.md, "A run with a final stage"). Part B comes first: the
// States board's rows, seeded on a dag the engine leaves alone because t-1 is still at work, with each round's
// final-step events published to the page. Part A is last, since it ends the run: every task is seeded done and
// merged, so the engine itself starts round 1, runs Tree and then a Verify that outlasts the scenario, and the
// stage is ended from its pane. The fixture's temp dir is a git repository, which the stage's tree needs.
const FST_VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const FST_LEAD = "final-stage lead";
// the tree names a lead by its run's plan title, which dagsubmit sets below (D12)
const FST_TITLE = "verify final-stage";
const FST_VERIFIER = "final-stage verifier";
const FST_VERIFIER_ID = "fx-final-verifier";
// t-1 fans out to two sinks, so the final node takes two edges; at parallelism 1 only t-1 dispatches
const FST_TASKS = [
    { id: "t-1", label: "noop", description: "do nothing, stop immediately", deps: [], state: "" },
    { id: "t-2", label: "noop 2", description: "do nothing, stop immediately", deps: ["t-1"], state: "" },
    { id: "t-3", label: "noop 3", description: "do nothing, stop immediately", deps: ["t-1"], state: "" },
];
const FST_SINK_EDGES = ["t-2>final", "t-3>final"];
// Part A's commands run. Verify writes three lines and then one every 3s for 15 minutes: the engine publishes the
// tail from the command's own writes, the first one at once and then at most every 10s
const FST_MARK = "final-stage verify";
const FST_LIVE_VERIFY = `printf '${FST_MARK} 1\\n${FST_MARK} 2\\n${FST_MARK} 3\\n'; for i in $(seq 1 300); do sleep 3; echo "${FST_MARK} still running $i"; done`;
const FST_LIVE_FINAL = "true";
const FST_KEPT_MARK = "final-stage kept check output";
const FST_KEPT_EMPTY = "the step printed nothing";
const FST_REASON =
    "the Verify loop of the final-stage scenario never ends on its own, so the scenario ends the stage here and records why";
const FST_VERIFIER_MS = 180_000;
// the pane's step rows show the time alone; the rail and the DAG peek card the state and its time
const FST_STEP_TIME = ["22s", "41s", "7m 11s", "3m 08s", "3m 00s"];
const FST_STEP_TEXT = FST_STEP_TIME.map((t) => `passed ${t}`);
const FST_TOTAL = "14m 22s";
const FST_WAIT_MS = 8000;
// a watchdog tick starts the stage (every 30s), then the Tree step and Verify's second publish
const FST_ENGINE_WAIT_MS = 90_000;

// round 1's line under the pane's steps, as pastOf reads it: the round and its outcome
const FST_PANE_PAST = [{ round: "1", text: "failed at Final" }];
const FST_SUB_SECOND_MS = 211;
const FST_SUB_SECOND_TIME = "<1s";
const FST_ENDED_BANNER = "Session ended · read-only transcript";

// shared's fstPublishSteps is not exported: one passed final-step event, the way the page appends the engine's
async function fstPublishStepMs(h, ctx, step, ms) {
    const event = {
        id: `fst-2-${step}-sub-second`,
        runid: ctx.runId,
        channelid: ctx.channelId,
        ts: Date.now(),
        kind: "final-step",
        detail: JSON.stringify({ round: 2, step, ms, ok: true }),
    };
    await h.rpc("eventpublish", {
        event: "run:event",
        scopes: [`run:${ctx.runId}`],
        data: { channelid: ctx.channelId, runid: ctx.runId, event },
    });
}
// a task-less memory-held for one of the stage's commands, as the memory gate writes it on the dag owner's run
const FST_MEMORY_TEXT = "waiting for memory · 2.1 GB free, 3.5 GB needed";
async function fstPublishMemoryHeld(h, ctx, role) {
    const GIB = 1024 ** 3;
    const event = {
        id: `fst-memory-held-${role}`,
        runid: ctx.runId,
        channelid: ctx.channelId,
        ts: Date.now(),
        kind: "memory-held",
        detail: JSON.stringify({ taskid: "", role, free: Math.round(2.1 * GIB), need: Math.round(3.5 * GIB) }),
    };
    await h.rpc("eventpublish", {
        event: "run:event",
        scopes: [`run:${ctx.runId}`],
        data: { channelid: ctx.channelId, runid: ctx.runId, event },
    });
}
// a fast-track stage's end review, seeded on the dag's Check and Verify: reviewing beside a running Verify, or the
// stage failed by its findings alone. fasttrack stays unset, so the engine leaves the seeded end review alone
const FST_ER_FINDING = "t-2's test asserts nothing the task changed";
async function fstShowEndReview(h, ctx, state) {
    const now = Date.now();
    const final =
        state === "reviewing"
            ? {
                  state: "checking",
                  round: 1,
                  step: "verify",
                  stepts: now - 60_000,
                  startedts: now - 120_000,
                  endreview: { state, startedts: now - 100_000 },
              }
            : { state: "failed", round: 1, detail: `[End review] ${FST_ER_FINDING}`, endreview: { state, text: FST_ER_FINDING } };
    const print = (dag) =>
        JSON.stringify([dag?.final?.state ?? "", dag?.final?.endreview?.state ?? "", dag?.finalcmd ?? "", dag?.fasttrack === true]);
    const nudge = await seedDag(
        h,
        ctx,
        (dag) => {
            const { final: _final, pastfinals: _past, finalcmd: _cmd, fasttrack: _fast, ...rest } = dag;
            return { ...rest, final };
        },
        print
    );
    return { nudge };
}
const fstStates = (steps) => (steps ?? []).map((s) => s.state);
const fstRepeat = (state, n) => Array(n).fill(state);
const fstFlat = (text) => text.replace(/\s+/g, " ").trim();
const fstButton = (rootExpr, text) =>
    `[...(${rootExpr}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;

// page-side readers shared by the two reads below; every element comes through the selectors the plan fixes
const FST_LIB = `
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const stepsOf = (root) =>
        [...(root?.querySelectorAll("[data-final-step]") ?? [])].map((s) => ({
            key: s.getAttribute("data-final-step"),
            state: s.getAttribute("data-final-step-state"),
            text: flat(s.querySelector("span.whitespace-nowrap")),
            command: s.querySelector("span[title]")?.getAttribute("title") ?? null,
        }));
    const pastOf = (root) =>
        [...(root?.querySelectorAll("[data-final-past-round]") ?? [])].map((p) => ({
            round: p.getAttribute("data-final-past-round"),
            text: flat(p.querySelector("span.font-mono")),
        }));
    const outputOf = (root) => root?.querySelector("[data-final-output]")?.textContent ?? null;
    const shotsOf = (root) => flat(root?.querySelector("[data-final-shots-link]")) || null;
    // the pane's step rows: the head's mark, ink, facts and open state, and the body an opened row draws
    const cardOf = (el) =>
        el
            ? {
                  runner: flat(el.querySelector("[data-card-head] .font-mono")),
                  counts: flat(el.querySelector("[data-test-counts]")),
                  failures: [...el.querySelectorAll("[data-test-failure]")].map((f) => ({
                      name: flat(f.querySelector("[data-test-name]")),
                      where: flat(f.querySelector("[data-test-where]")),
                      message: flat(f.querySelector("[data-test-message]")),
                  })),
                  view: el.querySelector("[data-card-view]")?.getAttribute("data-card-view") ?? null,
                  raw: flat(el.querySelector('[data-card-view="raw"]')),
              }
            : null;
    const paneStepsOf = (root) =>
        [...(root?.querySelectorAll("[data-final-step]") ?? [])].map((s) => {
            const head = s.querySelector("[data-final-step-head]");
            const body = s.querySelector("[data-final-step-body]");
            return {
                key: s.getAttribute("data-final-step"),
                state: s.getAttribute("data-final-step-state"),
                // the mark slot cross-fades, so the glyph read is the one its current kind draws, not one leaving
                mark: (() => {
                    const kind = head?.querySelector("[data-final-step-mark]")?.getAttribute("data-final-step-mark");
                    return head?.querySelector('[data-crossfade="' + kind + '"] [role="img"]')?.getAttribute("aria-label") ?? null;
                })(),
                quiet: head?.classList.contains("text-ink-mid") ?? false,
                button: head?.tagName === "BUTTON",
                expanded: head?.getAttribute("aria-expanded") ?? null,
                command: head?.querySelector("[data-final-step-command]")?.getAttribute("title") ?? null,
                fact: flat(head?.querySelector("[data-final-step-fact]")),
                factTone: head?.querySelector("[data-final-step-fact]")?.classList.contains("text-warning") ? "warning" : "muted",
                exit: flat(head?.querySelector("[data-final-step-exit]")) || null,
                body: body
                    ? {
                          text: flat(body),
                          command: flat(body.querySelector("[data-bash-command]")) || null,
                          output: body.querySelector("[data-bash-output]")?.textContent ?? null,
                          panel: body.querySelector("[data-tool-panel]") != null,
                          error: flat(body.querySelector("[data-tool-error]")) || null,
                          card: cardOf(body.querySelector('[data-tool-card="test"]')),
                      }
                    : null,
            };
        });
`;
const FST_TREE = `document.querySelector("[data-agent-tree]")`;
const FST_RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const FST_ROW = `${FST_TREE}?.querySelector("[data-final-row]")`;
const FST_PANE = `document.querySelector("[data-final-pane]")`;
// the pane's Final row and the view its open body swaps in
const FST_FINAL_BODY = `(() => {
    const row = ${FST_PANE}?.querySelector('[data-final-step="final"]');
    const swap = row?.querySelector("[data-final-step-body] [data-view-swap]");
    return {
        state: row?.getAttribute("data-final-step-state") ?? null,
        expanded: row?.querySelector("[data-final-step-head]")?.getAttribute("aria-expanded") ?? null,
        swap: swap?.getAttribute("data-view-swap") ?? null,
        opacity: swap ? getComputedStyle(swap).opacity : null,
        output: swap?.querySelector("[data-bash-output]")?.textContent ?? null,
        card: swap?.querySelector('[data-tool-card="test"]') != null,
    };
})()`;
// records each view the Final row's body swaps in, with the opacity it mounts at
const FST_WATCH_SWAPS = `(() => {
    window.__fstSwapObs?.disconnect();
    window.__fstSwaps = [];
    window.__fstSwapObs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
            for (const el of [n, ...n.querySelectorAll("[data-view-swap]")]) {
                if (el.matches("[data-view-swap]") && el.closest('[data-final-step-body="final"]')) {
                    window.__fstSwaps.push({ key: el.getAttribute("data-view-swap"), opacity: getComputedStyle(el).opacity });
                }
            }
        }
    });
    window.__fstSwapObs.observe(document.body, { childList: true, subtree: true });
    return true;
})()`;
const FST_READ_SWAPS = `(() => { window.__fstSwapObs?.disconnect(); return window.__fstSwaps ?? []; })()`;
const FST_MODAL = `document.querySelector("[data-dag-modal-kind]")`;
const FST_NODE = `${FST_MODAL}?.querySelector('[data-dag-node="final"]')`;
const FST_DAG_PEEK = `${FST_MODAL}?.querySelector("[data-dag-final-peek]")`;
const FST_SHEET = `document.querySelector("[data-run-sheet]")`;
const FST_FOLD = `[...(${FST_TREE}?.querySelectorAll("div.cursor-pointer") ?? [])].find((d) => /^\\d+ (done|reviews?)/.test(d.textContent.trim()))`;
const FST_LEAD_ROW = `(() => {
    const name = [...(${FST_TREE}?.querySelectorAll("div") ?? [])].find(
        (d) => d.children.length === 0 && d.textContent.trim() === ${JSON.stringify(FST_TITLE)}
    );
    return name ? name.closest(".cursor-pointer") : null;
})()`;
// the Agent surface: the tree's row and slot, the stage's pane, the workspace pane and its Final tab (the stage's own
// row has no rail), and in the details rail the lead's block or a live verifier's stage section
const FST_AGENT = `(() => {
    ${FST_LIB}
    const tree = ${FST_TREE};
    const rail = ${FST_RAIL};
    const pane = ${FST_PANE};
    const stage = rail?.querySelector("[data-final-rail]");
    const slot = tree?.querySelector("[data-final-slot]");
    const status = [...(rail?.querySelectorAll("span.font-semibold") ?? [])].find((s) => flat(s) === "Verifying");
    const fold = ${FST_FOLD};
    return {
        rows: [...(tree?.querySelectorAll("[data-final-row]") ?? [])].map((r) => ({
            tone: r.getAttribute("data-final-tone"),
            title: flat(r.querySelector(".truncate")),
            sub: flat(r.querySelector(".font-mono")),
            selected: r.classList.contains("bg-accentbg"),
        })),
        slot: slot?.getAttribute("data-final-slot") ?? null,
        strip: slot?.parentElement?.getAttribute("aria-label") ?? null,
        fold: fold ? flat(fold) : null,
        pane: pane
            ? (() => {
                  const detail = pane.querySelector("[data-final-detail]");
                  const box = pane.querySelector("[data-final-steps]");
                  return {
                      text: flat(pane),
                      steps: paneStepsOf(pane),
                      // the running command's live tail, inside its opened row
                      output: pane.querySelector("[data-final-step-body] [data-bash-output]")?.textContent ?? null,
                      // the failure detail drawn above the step box, as a red error block
                      detail: detail?.querySelector("[data-tool-error]") ? flat(detail) : null,
                      detailAbove:
                          detail != null &&
                          box != null &&
                          (detail.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
                      errors: pane.querySelectorAll("[data-tool-error]").length,
                      end: pane.querySelector("[data-final-end]") != null,
                      form: pane.querySelector("[data-run-sheet-end-final]") != null,
                      past: pastOf(pane),
                      shots: shotsOf(pane),
                  };
              })()
            : null,
        railSteps: rail?.querySelectorAll("[data-final-step]").length ?? 0,
        rail: rail != null,
        workspace: document.querySelector('aside[aria-label="Workspace"]')?.dataset.workspacePane ?? null,
        finalTab: document.querySelector("[data-workspace-final]") != null,
        stage: stage ? { text: flat(stage), steps: stepsOf(stage), past: pastOf(stage), shots: shotsOf(stage) } : null,
        status: status ? flat(status.parentElement) : null,
        viewer: document.querySelector("[data-final-shots-viewer]") != null,
    };
})()`;
// the DAG modal: the final node, the edges into it, the stage line, and the node's peek card
const FST_DAG = `(() => {
    ${FST_LIB}
    const modal = ${FST_MODAL};
    if (!modal) return null;
    const card = ${FST_NODE};
    const peek = ${FST_DAG_PEEK};
    const route = [...modal.querySelectorAll("span")].find((s) => s.textContent.trim().startsWith("Run route ·"));
    return {
        cards: [...modal.querySelectorAll("[data-dag-node]")].map((c) => c.getAttribute("data-dag-node")),
        edges: [...modal.querySelectorAll(".react-flow__edge")].map((e) => e.getAttribute("data-id") ?? "").sort(),
        stageLine: route ? flat(route.parentElement) : null,
        node: card
            ? {
                  pressed: card.getAttribute("aria-pressed"),
                  meta: flat(card.querySelector(":scope > span:not([role])")),
                  under: flat(card.parentElement?.querySelector(":scope > span")),
                  strip: stepsOf(card).map((s) => s.state),
              }
            : null,
        peek: peek
            ? {
                  text: flat(peek),
                  steps: stepsOf(peek),
                  output: outputOf(peek),
                  end: peek.querySelector("[data-final-end]") != null,
                  past: pastOf(peek),
                  shots: shotsOf(peek),
                  open: [...peek.querySelectorAll("button")].some((b) => /open in agent/i.test(b.textContent)),
              }
            : null,
        viewer: document.querySelector("[data-final-shots-viewer]") != null,
    };
})()`;

// reads expr until ok holds or the wait runs out, and returns the last read either way. nudge runs every 2s:
// an event published before the run's history loaded is replaced by that load, so it is published again
async function fstUntil(h, expr, ok, { ms = FST_WAIT_MS, nudge } = {}) {
    for (let i = 0; ; i++) {
        const s = await h.ev(expr).catch(() => null);
        if (fstHolds(() => ok(s)) || i * 250 >= ms) return s;
        if (nudge && i % 8 === 7) await nudge();
        await polishNap(250);
    }
}

async function fstAgent(h, ok, opts) {
    if ((await h.activeSurfaceLabel()) !== SURFACE_LABEL.agent) await h.goto("agent");
    return fstUntil(h, FST_AGENT, ok, opts);
}

// the run's graph with the final node selected: the modal belongs to the run's sheet on the Jarvis surface
async function fstDag(h, ctx, ok, opts) {
    if (!(await h.ev(`${FST_MODAL} != null`))) {
        await h.goto("jarvis");
        await polishWaitFor(h, `typeof window.__openAddress === "function"`, 5000);
        await h.ev(`window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)})`);
        const openDag = fstButton(FST_SHEET, "Open DAG");
        await polishWaitFor(h, `!!${openDag}`, 10_000);
        await finalShotsClick(h, openDag);
    }
    await polishWaitFor(h, `!!${FST_NODE}`, 10_000);
    await h.ev(`(() => {
        const card = ${FST_NODE};
        if (card && card.getAttribute("aria-pressed") !== "true") card.click();
    })()`);
    return fstUntil(h, FST_DAG, (d) => d.node.pressed === "true" && d.peek != null && ok(d), opts);
}
// what Part A's seed must keep: the engine owns the dag's status and its final from the first tick on
const fstLivePrint = (dag) =>
    JSON.stringify([dag?.verify ?? "", dag?.finalcmd ?? "", (dag?.tasks ?? []).map((t) => [t.state, t.merged === true])]);

// The roster is read once at boot: the lead alone, or with the tab of the verifier's session. Reloads onto it,
// which also drops every event published to the page, and focuses the lead, whose rail reads the run's events.
async function fstBoot(h, ctx, withVerifier) {
    const roster = treeRailRoster(ctx.runId, Date.now(), FST_LEAD).filter((a) => a.id === TREE_RAIL_LEAD_ID);
    if (withVerifier) {
        roster.push({
            id: FST_VERIFIER_ID,
            name: FST_VERIFIER,
            project: "waveterm",
            task: "judge the merged result",
            state: "working",
            agent: "claude",
            model: "opus",
            activeMs: 60_000,
            runId: ctx.verifierRunId,
            blockId: "fx-blk-final-verifier",
        });
    }
    writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(roster, null, 2));
    await h.ev("location.reload()");
    await polishWaitFor(h, `!!document.querySelector("nav button")`, 30_000);
    await h.cdp("Emulation.setDeviceMetricsOverride", FST_VIEWPORT);
    await h.goto("agent");
    return fstFocusLead(h);
}

async function fstFocusLead(h) {
    if (!(await polishWaitFor(h, `!!${FST_LEAD_ROW}`, 15_000))) return false;
    await finalShotsClick(h, FST_LEAD_ROW);
    return polishWaitFor(h, `[...(${FST_RAIL}?.querySelectorAll("h3") ?? [])].some((el) => el.textContent.trim() === "Run")`, 15_000);
}

// Part A's seed: every task done and merged with no child run to derive a state from, a Final command so no
// verifier is tended while the commands run, and no final at all, so the next tick starts round 1 itself.
// Waits for what that tick does: the Tree step, then Verify with its three opening lines published.
async function fstStartLive(h, ctx) {
    await seedDag(
        h,
        ctx,
        (dag) => {
            const { final: _final, pastfinals: _past, check: _check, setup: _setup, ...rest } = dag;
            return {
                ...rest,
                status: "finalizing",
                verify: FST_LIVE_VERIFY,
                finalcmd: FST_LIVE_FINAL,
                tasks: dag.tasks.map(({ runid: _run, reviewrunid: _review, ...t }) => ({ ...t, state: "done", merged: true })),
            };
        },
        fstLivePrint
    );
    const start = Date.now();
    let group = null;
    while (Date.now() - start < FST_ENGINE_WAIT_MS) {
        group = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
        if (group?.final?.step === "verify" && (group.final.output ?? "").includes(`${FST_MARK} 3`)) break;
        await polishNap(500);
    }
    const f = group?.final;
    return {
        status: group?.status,
        state: f?.state,
        step: f?.step,
        tree: f?.tree ?? "",
        verifierrunid: f?.verifierrunid ?? "",
        output: f?.output ?? "",
        waitedMs: Date.now() - start,
    };
}

async function arrangeFinalStage(h, ctx) {
    await h.cdp("Emulation.setDeviceMetricsOverride", FST_VIEWPORT);
    // before the run exists, as final-shots does: the captures walk every surface
    writeFinalShotsFixture(ctx.out, await captureFinalShotsFixture(h));
    ctx.shotsRound1 = finalShotsStages(ctx.out).fixing.pastfinals[0];
    fstGitInit(ctx.cwd);
    await arrangeFixtureRun(h, ctx, "final-stage", FST_LEAD);
    await h.rpc("dagsubmit", {
        channelid: ctx.channelId,
        runid: ctx.runId,
        title: FST_TITLE,
        parallelism: 1,
        tasks: FST_TASKS,
    });
    // a seed written while t-1 is still being dispatched would be overwritten by that tick
    await waitForDispatch(h, ctx, "t-1");
    ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
    if (!ctx.dagId) throw new Error("the run has no dag");
    // the verifier's session is seeded, never spawned: a deferred quick run that carries the stage's role
    const wslist = await h.rpc("workspacelist", null);
    const created = await h.rpc("createrun", {
        channelid: ctx.channelId,
        workspaceid: wslist[0].workspacedata.oid,
        goal: "verify final-stage: the verifier's seeded run",
        runtime: "claude",
        mode: "quick",
        deferstart: true,
    });
    ctx.verifierRunId = created.run.id;
    ctx.verifierStart = Date.now() - 20 * 60_000;
    const verifierRun = await fstWriteRun(h, ctx.verifierRunId, (run) => ({ ...run, stagerole: "verifier", dagoref: ctx.dagId }));
    ctx.verifierSeeded = verifierRun?.stagerole === "verifier" && verifierRun.dagoref === ctx.dagId && !verifierRun.completedts;
    await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
    // the rail under test shows in the Terminal view; in Rendered, a fresh store's default, the workspace pane takes its place
    await pinDefaultView(h, "terminal");
    ctx.waiting = await fstShow(h, ctx, "waiting");
    ctx.leadFocused = await fstBoot(h, ctx, false);
}

export const finalStageScenario = {
    name: "final-stage",
    surface: "agent",
    async arrange(h) {
        const ctx = {
            out: mkdtempSync(join(tmpdir(), "verify-final-stage-out-")),
            cwd: mkdtempSync(join(tmpdir(), "verify-final-stage-")),
            prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`),
        };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await arrangeFinalStage(h, ctx);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: fstHolds(ok), detail: JSON.stringify(detail) });
        const shot = (name) => h.shot(`cdp-shots/final-stage-${name}.png`, { step: shotStep(steps, name.split("-")[0]) });
        const clickRow = () => finalShotsClick(h, FST_ROW);
        const closeViewer = async () => {
            await finalShotsClick(h, `document.querySelector("[data-final-shots-viewer]")?.querySelector('button[aria-label="Close"]')`);
            await polishWaitFor(h, `document.querySelector("[data-final-shots-viewer]") == null`, 3000);
        };
        rec(
            "0. a git project's run with a dispatched t-1, a seeded verifier run, and the lead focused with its rail open",
            () => ctx.arrangeError == null && ctx.dispatched && ctx.verifierSeeded && ctx.leadFocused,
            ctx.arrangeError ?? {
                runId: ctx.runId,
                dagId: ctx.dagId,
                verifierRunId: ctx.verifierRunId,
                dispatched: ctx.dispatched,
                dispatchMs: ctx.dispatchMs,
                verifierSeeded: ctx.verifierSeeded,
                leadFocused: ctx.leadFocused,
            }
        );
        if (ctx.arrangeError != null) return steps;
        const wtRoot = arcWorktreeRoot();
        rec(
            "0b. the run's landing tree is under the user cache dir's arc-wt root, named by its run id's first 8 chars (or the whole id), not in the temp dir",
            () =>
                !!ctx.landPath &&
                existsSync(ctx.landPath) &&
                [ctx.runId.slice(0, 8), ctx.runId].includes(relative(wtRoot, ctx.landPath)),
            { landPath: ctx.landPath, root: wtRoot, cwd: ctx.cwd }
        );

        // --- Part B: the States rows, on a dag whose final the engine leaves alone ---
        let a = await fstAgent(h, (s) => s.rows.length === 0 && s.railSteps === 0);
        // t-1's worker still ticks the dag, so every wait on a seeded row takes its nudge (fstShow); a seed lost
        // here leaves no commands, and the strip draws the Verifier alone
        let d = await fstDag(
            h,
            ctx,
            (s) => s.node.meta === "waits on every task" && fstSame(s.node.strip, fstRepeat("waiting", 5)),
            ctx.waiting
        );
        rec(
            "B1. tasks still running: no tree row and no slot; the last node reads waits on every task over five waiting segments",
            () =>
                a.rows.length === 0 &&
                a.slot == null &&
                d.cards[d.cards.length - 1] === "final" &&
                d.node.meta === "waits on every task" &&
                d.node.under === "on the merged result" &&
                fstSame(d.node.strip, fstRepeat("waiting", 5)),
            { rows: a?.rows, slot: a?.slot, cards: d?.cards, node: d?.node }
        );
        await shot("b1-waiting-dag");

        let wait = await fstShow(h, ctx, "tree");
        a = await fstAgent(h, (s) => s.rows.length === 1 && s.rows[0].sub.startsWith("Tree"), wait);
        await clickRow();
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].selected && s.pane != null && s.finalTab);
        await shot("b2-tree-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta.startsWith("round 1 · Tree"), wait);
        rec(
            "B2. preparing the tree: Tree · <time> · step 1 of 5, the step list with Tree running, no output box, and End final stage; the row has the workspace pane with its Final tab, no details rail",
            () =>
                a.rows.length === 1 &&
                a.rows[0].title === "Final verification" &&
                /^Tree · \d+s · step 1 of 5$/.test(a.rows[0].sub) &&
                a.rows[0].tone === "run" &&
                a.slot === "run" &&
                fstSame(fstStates(a.pane.steps), ["running", ...fstRepeat("waiting", 4)]) &&
                a.pane.output == null &&
                a.pane.end &&
                !a.rail &&
                a.workspace === "open" &&
                a.finalTab &&
                /^round 1 · Tree · \d+s$/.test(d.node.meta) &&
                fstSame(d.node.strip, ["running", ...fstRepeat("waiting", 4)]) &&
                d.peek.output == null &&
                d.peek.steps[0].command === "prepares the tree the stage runs in" &&
                d.peek.steps[1].command === FST_CHECK,
            { row: a?.rows, slot: a?.slot, pane: a?.pane, rail: a?.rail, workspace: a?.workspace, finalTab: a?.finalTab, node: d?.node, peek: d?.peek?.steps }
        );
        await shot("b2-tree-dag");

        wait = await fstShow(h, ctx, "alongside");
        a = await fstAgent(h, (s) => s.rows[0].sub.startsWith("Check") && s.pane.steps[0].fact === FST_STEP_TIME[0], wait);
        await shot("b3-alongside-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 1 · Check · verifier", wait);
        rec(
            "B3. verifier alongside (no Final command): four steps, the Verifier running beside Check, Tree's time from its event",
            () =>
                /^Check · \d+s · verifier alongside$/.test(a.rows[0].sub) &&
                a.rows[0].tone === "run" &&
                fstSame(fstStates(a.pane.steps), ["passed", "running", "waiting", "running"]) &&
                fstSame(a.pane.steps.map((s) => s.key), ["tree", "check", "verify", "verifier"]) &&
                a.pane.steps[0].fact === FST_STEP_TIME[0] &&
                d.node.meta === "round 1 · Check · verifier" &&
                fstSame(d.node.strip, ["passed", "running", "waiting", "running"]),
            { row: a?.rows, pane: a?.pane?.steps, node: d?.node }
        );
        await shot("b3-alongside-dag");

        // the running Check waits at the memory gate: its step reads the hold where its command or state reads
        const publishHold = () => fstPublishMemoryHeld(h, ctx, "Check");
        const holdNudge = async () => {
            await wait.nudge();
            await publishHold();
        };
        await publishHold();
        const memoryOf = (root) =>
            `(${root})?.querySelector('[data-final-step="check"] [data-final-step-memory]')?.textContent.trim() ?? null`;
        const heldPeek = await fstUntil(h, memoryOf(FST_DAG_PEEK), (t) => t === FST_MEMORY_TEXT, { nudge: holdNudge });
        await shot("b3b-memory-dag");
        if ((await h.activeSurfaceLabel()) !== SURFACE_LABEL.agent) await h.goto("agent");
        const heldPane = await fstUntil(h, memoryOf(FST_PANE), (t) => t === FST_MEMORY_TEXT, { nudge: holdNudge });
        // in the pane's row the hold takes the command's place, in warning
        const heldLook = await h.ev(`(() => {
            const row = ${FST_PANE}?.querySelector('[data-final-step="check"]');
            return {
                warning: row?.querySelector("[data-final-step-memory]")?.classList.contains("text-warning") ?? false,
                command: row?.querySelector("[data-final-step-command]") != null,
            };
        })()`);
        await shot("b3b-memory-pane");
        rec(
            "B3b. a running Check held at the memory gate reads waiting for memory · 2.1 GB free, 3.5 GB needed on its step in the DAG peek card and the pane; in the pane's row it reads in warning where the command reads",
            () =>
                heldPeek === FST_MEMORY_TEXT &&
                heldPane === FST_MEMORY_TEXT &&
                heldLook.warning &&
                !heldLook.command,
            { heldPeek, heldPane, heldLook }
        );

        wait = await fstShowEndReview(h, ctx, "reviewing");
        const endReviewIs = (s, state) => s.pane?.steps.some((p) => p.key === "review" && p.state === state);
        a = await fstAgent(h, (s) => endReviewIs(s, "running") && s.rows[0]?.sub.endsWith("end review alongside"), wait);
        await shot("b3c-end-review-alongside");
        rec(
            "B3c. the end review beside a running Verify: the pane lists End review running before the Verifier, and the row's activity names the end review alongside",
            () =>
                fstSame(a.pane.steps.map((s) => s.key), ["tree", "check", "verify", "review", "verifier"]) &&
                fstSame(fstStates(a.pane.steps), ["passed", "passed", "running", "running", "waiting"]) &&
                a.pane.text.includes("End review") &&
                /^Verify · \S.* · end review alongside$/.test(a.rows[0].sub),
            { row: a?.rows, pane: a?.pane?.steps }
        );

        wait = await fstShowEndReview(h, ctx, "failed");
        a = await fstAgent(h, (s) => endReviewIs(s, "failed") && s.rows[0]?.tone === "fail", wait);
        await shot("b3d-end-review-failed");
        rec(
            "B3d. a stage whose detail is only the end review's: End review failed, its chip alone saying so, the Verifier and the commands not failed and none in warning, the findings as the red block above the step box",
            () =>
                a.rows[0].sub === "failed at End review · round 1" &&
                fstSame(fstStates(a.pane.steps), ["passed", "passed", "passed", "failed", "passed"]) &&
                fstSame(
                    a.pane.steps.filter((s) => s.key === "review").map((s) => [s.exit, s.fact]),
                    [["failed", ""]]
                ) &&
                a.pane.steps.every((s) => s.factTone === "muted") &&
                a.pane.detail?.includes(FST_ER_FINDING) &&
                a.pane.detailAbove &&
                a.pane.errors === 1,
            { row: a?.rows, pane: a?.pane?.steps, detail: a?.pane?.detail, detailAbove: a?.pane?.detailAbove }
        );

        wait = await fstShow(h, ctx, "reviewing");
        a = await fstAgent(h, (s) => s.rows[0].sub.startsWith("verifier reviewing") && s.pane.steps[3].state === "passed", wait);
        await shot("b4-reviewing-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta.startsWith("round 2 · verifier"), wait);
        rec(
            "B4. verifier reviewing with its tab gone: the row is the stage's own, every command passed, the Verifier running, round 1 one line",
            () =>
                a.rows.length === 1 &&
                a.rows[0].selected &&
                a.pane != null &&
                /^verifier reviewing · 4m \d\ds$/.test(a.rows[0].sub) &&
                fstSame(fstStates(a.pane.steps), [...fstRepeat("passed", 4), "running"]) &&
                a.pane.output == null &&
                fstSame(a.pane.past, FST_PANE_PAST) &&
                /^round 2 · verifier · 4m \d\ds$/.test(d.node.meta) &&
                fstSame(d.node.strip, [...fstRepeat("passed", 4), "running"]) &&
                d.peek.open === false,
            { row: a?.rows, pane: a?.pane?.steps, past: a?.pane?.past, node: d?.node, open: d?.peek?.open }
        );
        await shot("b4-reviewing-dag");

        // round 1's Final and Verify kept their output beside its ARC_FINAL_OUT (finalStepsDir), written before the
        // stage shows so the Final row opens on it
        const keptDir = join(ctx.out, "1-steps");
        mkdirSync(keptDir, { recursive: true });
        writeFileSync(join(keptDir, "final.txt"), FST_FINAL_KEPT);
        writeFileSync(join(keptDir, "verify.txt"), FST_VERIFY_KEPT);
        const paneStep = (s, key) => s?.pane?.steps.find((p) => p.key === key);
        const paneHead = (key) => `${FST_PANE}?.querySelector('[data-final-step="${key}"] [data-final-step-head]')`;
        wait = await fstShow(h, ctx, "failed");
        a = await fstAgent(
            h,
            (s) => s.rows[0].tone === "fail" && paneStep(s, "final").state === "failed" && paneStep(s, "final").body?.card != null,
            wait
        );
        await shot("b5-failed-pane");
        await finalShotsClick(h, paneHead("verify"));
        const besideVerify = await fstUntil(h, FST_AGENT, (s) => paneStep(s, "verify")?.body?.card != null);
        await finalShotsClick(h, `${FST_PANE}?.querySelector('[data-final-step="final"] [data-raw-toggle]')`);
        const rawFinal = await fstUntil(h, FST_AGENT, (s) => paneStep(s, "final")?.body?.card?.view === "raw");
        await shot("b5-failed-raw");
        // the screenshots live in the Final tab beside the pane, which has no link of its own
        await finalShotsClick(h, `document.querySelector("[data-workspace-final] [data-final-tab-shot]")`);
        const tabViewer = (await fstUntil(h, FST_AGENT, (s) => s.viewer))?.viewer;
        await closeViewer();
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 1 · failed at Final", wait);
        await shot("b5-failed-dag");
        await finalShotsClick(h, `${FST_DAG_PEEK}?.querySelector("[data-final-shots-link]")`);
        const peekViewer = (await fstUntil(h, FST_DAG, (s) => s.viewer))?.viewer;
        await shot("b5-failed-viewer");
        await closeViewer();
        const final = paneStep(a, "final");
        const verifier = paneStep(a, "verifier");
        const verifyCard = paneStep(besideVerify, "verify")?.body?.card;
        const rawText = paneStep(rawFinal, "final")?.body?.card?.raw ?? "";
        rec(
            "B5. failed at Final in round 1: the Final row opens on its own as a final-verify Tests card, its failures named with their scenario, its X square and exit 1 chip, no red detail; Verify opens beside it as a go test card; raw shows the output; the Verifier reads not run, quiet; the lead has it; the pane has no screenshots link, and the screenshots open the viewer from the Final tab and the DAG peek card",
            () =>
                a.rows[0].sub === "failed at Final · round 1" &&
                a.rows[0].tone === "fail" &&
                a.slot === "fail" &&
                fstSame(fstStates(a.pane.steps), [...fstRepeat("passed", 3), "failed", "notrun"]) &&
                fstSame(a.pane.steps.map((s) => s.expanded), [null, "false", "false", "true", null]) &&
                final.mark === "Failed" &&
                final.exit === "exit 1" &&
                final.body.card.runner === "final-verify" &&
                fstSame(
                    final.body.card.failures.map((f) => [f.name, f.where]),
                    FST_FINAL_FAILURES.map((f) => [f.step, FST_FINAL_SCENARIO])
                ) &&
                final.body.error == null &&
                a.pane.detail == null &&
                a.pane.errors === 0 &&
                verifier.fact === "not run" &&
                verifier.quiet &&
                verifyCard?.runner === "go test" &&
                paneStep(besideVerify, "final")?.body?.card != null &&
                rawText.includes(`# ${FST_FINAL_SCENARIO}`) &&
                rawText.includes(FST_FINAL_FAILURES[0].detail) &&
                a.pane.text.includes("The lead has this failure") &&
                !a.pane.end &&
                a.pane.shots == null &&
                tabViewer &&
                d.node.meta === "round 1 · failed at Final" &&
                fstSame(d.node.strip, [...fstRepeat("passed", 3), "failed", "notrun"]) &&
                d.peek.text.includes(fstFlat(FST_DETAIL)) &&
                d.peek.shots != null &&
                peekViewer,
            {
                row: a?.rows,
                slot: a?.slot,
                steps: a?.pane?.steps,
                detail: a?.pane?.detail,
                errors: a?.pane?.errors,
                verifyCard,
                raw: rawText.slice(0, 200),
                shots: a?.pane?.shots,
                tabViewer,
                node: d?.node,
                peek: d?.peek,
                peekViewer,
            }
        );

        // Check kept a plain output: it opens in place as a Bash panel, and a second click closes it
        writeFileSync(join(keptDir, "check.txt"), `${FST_KEPT_MARK}\n`);
        await h.goto("agent");
        const keptRead = `(() => {
            ${FST_LIB}
            return { check: paneStepsOf(${FST_PANE}).find((s) => s.key === "check") ?? null };
        })()`;
        await finalShotsClick(h, paneHead("check"));
        const keptCheck = await fstUntil(h, keptRead, (s) => (s.check?.body?.output ?? "").includes(FST_KEPT_MARK));
        await shot("b5b-kept-check");
        await finalShotsClick(h, paneHead("check"));
        // the body leaves through its pane's exit, so it is waited out
        const keptClosed = await fstUntil(h, keptRead, (s) => s.check?.expanded === "false" && s.check.body == null);
        await fstDag(h, ctx, (s) => s.node.meta === "round 1 · failed at Final", wait);
        const dagCell = `${FST_DAG_PEEK}?.querySelector('[data-final-step="check"]')`;
        const dagRead = `(() => ({
            text: (${FST_DAG_PEEK}?.textContent ?? "").replace(/\\s+/g, " ").trim(),
            expanded: [...(${FST_DAG_PEEK}?.querySelectorAll('[data-final-step][aria-expanded="true"]') ?? [])].map((c) => c.getAttribute("data-final-step")),
        }))()`;
        await finalShotsClick(h, dagCell);
        const keptDag = await fstUntil(h, dagRead, (s) => s.text.includes(FST_KEPT_MARK));
        await shot("b5b-kept-dag");
        await finalShotsClick(h, dagCell);
        // the output leaves through its pane's exit, so its text is waited out too
        const keptDagClosed = await fstUntil(h, dagRead, (s) => s.expanded.length === 0 && !s.text.includes(FST_KEPT_MARK));
        // a rerun of Check that printed nothing: its event's new end versions the file, so the pane reads it afresh
        writeFileSync(join(keptDir, "check.txt"), "");
        await wait.nudge();
        await h.goto("agent");
        await finalShotsClick(h, paneHead("check"));
        const keptEmpty = await fstUntil(h, keptRead, (s) => (s.check?.body?.text ?? "").includes(FST_KEPT_EMPTY), {
            nudge: wait.nudge,
        });
        await shot("b5b-kept-empty");
        rec(
            "B5b. a step that ended opens the output it kept: Check's in place in the pane as a Bash panel that a second click closes, and in the DAG peek card (under its row, the outcome still shown); an empty kept output reads the step printed nothing",
            () =>
                keptCheck.check.expanded === "true" &&
                keptCheck.check.body.panel &&
                keptCheck.check.body.card == null &&
                keptCheck.check.body.command?.endsWith(fstFlat(FST_CHECK)) &&
                keptClosed.check.body == null &&
                fstSame(keptDag.expanded, ["check"]) &&
                keptDag.text.includes(fstFlat(FST_DETAIL)) &&
                keptDagClosed.text.includes(fstFlat(FST_DETAIL)) &&
                !keptDagClosed.text.includes(FST_KEPT_MARK) &&
                keptEmpty.check.expanded === "true" &&
                keptEmpty.check.body.text.includes(FST_KEPT_EMPTY) &&
                !keptEmpty.check.body.text.includes(FST_KEPT_MARK),
            {
                keptCheck: keptCheck?.check,
                keptClosed: keptClosed?.check,
                keptDag,
                keptDagClosed,
                keptEmpty: keptEmpty?.check,
            }
        );

        // B5's stage with a failed end review too: applyEndReview appends the findings to the Final's detail
        await fstShow(h, ctx, "failed");
        const erDetail = `${FST_DETAIL}\n\n[End review] ${FST_ER_FINDING}`;
        const erNudge = await seedDag(
            h,
            ctx,
            (dag) => ({
                ...dag,
                final: { ...dag.final, detail: erDetail, endreview: { state: "failed", text: FST_ER_FINDING } },
            }),
            (dag) => JSON.stringify([dag?.final?.state ?? "", dag?.final?.endreview?.state ?? "", dag?.final?.detail ?? ""])
        );
        a = await fstAgent(
            h,
            // fstShow publishes the step events afresh, so the Final's kept output is read again
            (s) =>
                paneStep(s, "review")?.state === "failed" &&
                (s.pane?.detail ?? "").includes(FST_ER_FINDING) &&
                paneStep(s, "final")?.body?.card != null,
            { nudge: erNudge }
        );
        await shot("b5c-failed-end-review");
        const erFinal = paneStep(a, "final");
        rec(
            "B5c. B5's stage with a failed end review: the Final row still opens as a final-verify card with no error, End review reads failed, and the findings alone are the red block above the step box",
            () =>
                erFinal.state === "failed" &&
                erFinal.expanded === "true" &&
                erFinal.body.card.runner === "final-verify" &&
                erFinal.body.error == null &&
                paneStep(a, "review").state === "failed" &&
                a.pane.detailAbove &&
                a.pane.detail.includes(FST_ER_FINDING) &&
                FST_DETAIL.split("\n").every((line) => !a.pane.detail.includes(fstFlat(line))) &&
                a.pane.errors === 1,
            { steps: a?.pane?.steps, detail: a?.pane?.detail, detailAbove: a?.pane?.detailAbove, errors: a?.pane?.errors }
        );

        // a click overrides a row's default open state until the round changes: the failed Final row, open on its
        // own, is clicked closed and stays closed while its round's stage changes (the end review drops away)
        await finalShotsClick(h, paneHead("final"));
        const overridden = await fstUntil(h, FST_AGENT, (s) => paneStep(s, "final")?.expanded === "false" && paneStep(s, "final").body == null);
        wait = await fstShow(h, ctx, "failed");
        const sameRound = await fstAgent(
            h,
            (s) => paneStep(s, "final")?.state === "failed" && paneStep(s, "review") == null && s.pane.detail == null,
            wait
        );
        await shot("b5d-final-closed");
        // round 3, with the Final command printing: the row opens on its own again, on its live tail
        const keptDir3 = `${fstRound3Dir(ctx)}-steps`;
        mkdirSync(keptDir3, { recursive: true });
        writeFileSync(join(keptDir3, "final.txt"), FST_FINAL_KEPT);
        const lastTailLine = FST_FINAL_TAIL.trim().split("\n").at(-1);
        wait = await fstShow(h, ctx, "tailing");
        const tailing = await fstUntil(h, FST_FINAL_BODY, (s) => s.state === "running" && (s.output ?? "").includes(lastTailLine), wait);
        await shot("b5d-final-tail");
        rec(
            "B5d. a click closes the failed Final row that opened on its own, and it stays closed through a change in the same round; in round 3 the Final row opens on its own again, on the running command's live tail",
            () =>
                paneStep(overridden, "final").expanded === "false" &&
                paneStep(sameRound, "final").expanded === "false" &&
                paneStep(sameRound, "final").body == null &&
                tailing.expanded === "true" &&
                tailing.swap === "tail" &&
                !tailing.card,
            { overridden: paneStep(overridden, "final"), sameRound: paneStep(sameRound, "final"), tailing }
        );

        // the step ends: Final fails with its output kept, and the open body trades the tail for it in place, the kept
        // view fading in rather than the row closing and reopening
        await h.ev(FST_WATCH_SWAPS);
        wait = await fstShow(h, ctx, "refailed");
        const keptFinal = await fstUntil(
            h,
            FST_FINAL_BODY,
            (s) => s.state === "failed" && s.swap === "kept" && s.card && s.opacity === "1",
            wait
        );
        const swaps = await h.ev(FST_READ_SWAPS);
        await shot("b5e-final-kept");
        rec(
            "B5e. when the running Final step fails, its open row stays open and its body swaps the live tail for the kept output's Tests card, the kept view mounting at opacity 0 and settling at 1",
            () =>
                keptFinal.expanded === "true" &&
                keptFinal.swap === "kept" &&
                keptFinal.card &&
                keptFinal.opacity === "1" &&
                swaps.length > 0 &&
                swaps.at(-1).key === "kept" &&
                swaps.at(-1).opacity === "0",
            { keptFinal, swaps }
        );

        wait = await fstShow(h, ctx, "fixing");
        a = await fstAgent(h, (s) => s.rows[0].sub.startsWith("round 2") && s.rows[0].tone === "wait", wait);
        await shot("b6-fixing-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta.startsWith("round 2 waits on"), wait);
        rec(
            "B6. fix round under way: round 2 waits on the unfinished tasks, every step waiting, round 1 one past-round line",
            () =>
                a.rows[0].sub === "round 2 after 3 fix tasks" &&
                a.rows[0].tone === "wait" &&
                fstSame(fstStates(a.pane.steps), fstRepeat("waiting", 5)) &&
                fstSame(a.pane.past, FST_PANE_PAST) &&
                d.node.meta === "round 2 waits on t-1, t-2, t-3" &&
                fstSame(d.node.strip, fstRepeat("waiting", 5)) &&
                fstSame(d.peek.past, [{ round: "1", text: "round 1 · failed at Final" }]),
            { row: a?.rows, pane: a?.pane, past: a?.pane?.past, node: d?.node, peek: d?.peek }
        );
        await shot("b6-fixing-dag");

        // the pane's Round 1 line, below the steps, opens to the round's failure as the red block
        await h.goto("agent");
        const pastLine = `${FST_PANE}?.querySelector('[data-final-past-round="1"]')`;
        const pastRead = `(() => {
            const line = ${pastLine};
            const detail = line?.parentElement?.querySelector("[data-final-past-round-detail]");
            return {
                line: (line?.textContent ?? "").replace(/\\s+/g, " ").trim(),
                expanded: line?.getAttribute("aria-expanded") ?? null,
                error: (detail?.querySelector("[data-tool-error]")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
                shotsLink: line?.querySelector("[data-final-past-round-shots]") != null,
            };
        })()`;
        await finalShotsClick(h, pastLine);
        const pastOpen = await fstUntil(h, pastRead, (s) => s.error !== "");
        await shot("b6b-past-round-open");
        rec(
            "B6b. the pane's Round 1 line reads Round 1 and failed at Final with no screenshots link (the Final tab's Round switch has them), and a click opens its failure detail beneath it as the red block",
            () =>
                pastOpen.line.startsWith("Round 1") &&
                pastOpen.line.includes("failed at Final") &&
                !pastOpen.shotsLink &&
                pastOpen.expanded === "true" &&
                pastOpen.error === fstFlat(FST_DETAIL),
            pastOpen
        );

        // the verifier's tab joins the roster. Until the stage names its run, that tab is a stage row an earlier
        // round left, and the stage's row is its own
        wait = await fstShow(h, ctx, "reviewing", { verifier: false });
        const rebooted = await fstBoot(h, ctx, true);
        await fstAgent(h, (s) => s.rows.length === 1, wait);
        await clickRow();
        const own = await fstUntil(h, FST_AGENT, (s) => s.rows[0].selected && s.pane != null);
        wait = await fstShow(h, ctx, "reviewing");
        // the stage's own row leaves through the tree's exit animation, so one row is waited for, not read at once
        a = await fstUntil(h, FST_AGENT, (s) => s.pane == null && s.rows.length === 1 && s.rows[0].selected && s.stage.steps[3].state === "passed", wait);
        rec(
            "B7a. the row becomes the verifier's session: a focus on the stage's own row moves to the agent, one row, its rail keeps the step list",
            () =>
                rebooted &&
                own.rows.length === 1 &&
                own.rows[0].selected &&
                own.pane != null &&
                a.rows.length === 1 &&
                a.rows[0].selected &&
                a.pane == null &&
                a.rows[0].sub.startsWith("verifier reviewing") &&
                fstSame(fstStates(a.stage.steps), [...fstRepeat("passed", 4), "running"]),
            { rebooted, own: { rows: own?.rows, pane: own?.pane != null }, rows: a?.rows, pane: a?.pane != null, stage: a?.stage }
        );
        await shot("b7-session-agent");
        // away from the row, so landing on it is the Enter's doing
        await fstFocusLead(h);
        const away = await fstUntil(h, FST_AGENT, (s) => s.rows[0].selected === false);
        d = await fstDag(h, ctx, (s) => s.peek.open === true, wait);
        await shot("b7-session-dag");
        const entered = await h.ev(`(() => {
            const node = ${FST_NODE}?.closest(".react-flow__node");
            if (!node) return false;
            // Enter on a focused button is the button's own
            node.focus({ preventScroll: true });
            const init = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
            (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
            return true;
        })()`);
        const landed = await fstUntil(
            h,
            `({ modal: ${FST_MODAL} != null, agent: ${FST_AGENT} })`,
            (s) => !s.modal && s.agent.rows[0].selected
        );
        const onAgent = await h.activeSurfaceLabel();
        rec(
            "B7b. the final node's peek card has Open in Agent, and Enter on the node lands on the Agent surface with the verifier's session focused",
            () =>
                away.rows[0].selected === false &&
                d.peek.open === true &&
                entered &&
                !landed.modal &&
                onAgent === SURFACE_LABEL.agent &&
                landed.agent.rows.length === 1 &&
                landed.agent.rows[0].selected &&
                landed.agent.pane == null,
            { away: away?.rows, open: d?.peek?.open, entered, onAgent, modal: landed?.modal, rows: landed?.agent?.rows }
        );

        // the verifier gave its verdict: its run is over
        await fstWriteRun(h, ctx.verifierRunId, (run) => ({ ...run, completedts: ctx.verifierStart + FST_VERIFIER_MS }));
        wait = await fstShow(h, ctx, "unverified");
        a = await fstAgent(h, (s) => s.rows[0].tone === "warn" && s.stage.steps[4].state === "unverified", wait);
        await shot("b8-unverified-agent");
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 2 · unverified", wait);
        rec(
            "B8. unverified in round 2 on the verifier's verdict: unverified · 1 reason, the reason whole, the Verifier unverified, round 1 one line",
            () =>
                a.rows.length === 1 &&
                a.rows[0].sub === "unverified · 1 reason" &&
                a.rows[0].tone === "warn" &&
                a.slot === "warn" &&
                fstSame(fstStates(a.stage.steps), [...fstRepeat("passed", 4), "unverified"]) &&
                d.node.meta === "round 2 · unverified" &&
                fstSame(d.node.strip, [...fstRepeat("passed", 4), "unverified"]) &&
                d.peek.text.includes(FST_UNVERIFIED) &&
                !d.peek.end &&
                fstSame(d.peek.past, [{ round: "1", text: "round 1 · failed at Final" }]),
            { row: a?.rows, slot: a?.slot, stage: a?.stage, node: d?.node, peek: d?.peek }
        );
        await shot("b8-unverified-dag");

        wait = await fstShow(h, ctx, "passed");
        await h.goto("agent");
        // off the row, or the fold stays open under the reader
        await fstFocusLead(h);
        const folded = await fstUntil(h, FST_AGENT, (s) => s.rows.length === 0 && s.fold != null, wait);
        await shot("b9-passed-folded");
        await finalShotsClick(h, FST_FOLD);
        await fstUntil(h, FST_AGENT, (s) => s.rows.length === 1);
        await clickRow();
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].sub === `passed · ${FST_TOTAL}` && s.stage != null, wait);
        await shot("b9-passed-agent");
        d = await fstDag(h, ctx, (s) => s.node.meta === `round 2 · passed · ${FST_TOTAL}`, wait);
        rec(
            "B9. passed in round 2: the row is inside the run's finished group, every step shows its time, and the row and the node show the total",
            () =>
                folded.rows.length === 0 &&
                /review/.test(folded.fold) &&
                a.rows.length === 1 &&
                a.rows[0].sub === `passed · ${FST_TOTAL}` &&
                a.rows[0].tone === "pass" &&
                a.slot === "pass" &&
                fstSame(a.stage.steps.map((s) => s.text), FST_STEP_TEXT) &&
                d.node.meta === `round 2 · passed · ${FST_TOTAL}` &&
                fstSame(d.node.strip, fstRepeat("passed", 5)) &&
                fstSame(d.peek.steps.map((s) => s.text), FST_STEP_TEXT),
            { folded: { rows: folded?.rows, fold: folded?.fold }, row: a?.rows, slot: a?.slot, stage: a?.stage, node: d?.node, peek: d?.peek?.steps }
        );
        await shot("b9-passed-dag");

        // a reload drops the published events; without Check's the stage has no total, and every state stands
        const reloaded = await fstBoot(h, ctx, true);
        wait = await fstShow(h, ctx, "passed", { skip: "check" });
        if (await h.ev(`${FST_ROW} == null && ${FST_FOLD} != null`)) await finalShotsClick(h, FST_FOLD);
        await fstUntil(h, FST_AGENT, (s) => s.rows.length === 1);
        await clickRow();
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].sub === "passed" && s.stage.steps[0].text === "passed 22s", wait);
        await shot("b10-no-total-agent");
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 2 · passed", wait);
        rec(
            "B10. with one step's event gone: the total leaves the row and the node, that step shows no time, and every state stays passed",
            () =>
                reloaded &&
                a.rows[0].sub === "passed" &&
                a.rows[0].tone === "pass" &&
                fstSame(fstStates(a.stage.steps), fstRepeat("passed", 5)) &&
                fstSame(a.stage.steps.map((s) => s.text), FST_STEP_TEXT.map((t, i) => (i === 1 ? "passed" : t))) &&
                d.node.meta === "round 2 · passed" &&
                fstSame(d.node.strip, fstRepeat("passed", 5)),
            { reloaded, row: a?.rows, stage: a?.stage, node: d?.node }
        );
        await shot("b10-no-total-dag");

        // P10, P11: the verifier's tab is gone (no verifier agent in the roster), so the stage's own pane shows its
        // steps. Tree is published at 211 ms by hand; fstShow publishes the other four
        await fstBoot(h, ctx, false);
        const shown = await fstShow(h, ctx, "passed", { skip: "tree" });
        const publishTree = () => fstPublishStepMs(h, ctx, "tree", FST_SUB_SECOND_MS);
        const republish = async () => {
            await shown.nudge?.();
            await publishTree();
        };
        await republish();
        if (await h.ev(`${FST_ROW} == null && ${FST_FOLD} != null`)) await finalShotsClick(h, FST_FOLD);
        await fstUntil(h, FST_AGENT, (s) => s.rows.length === 1);
        await clickRow();
        const subSecond = await fstUntil(h, FST_AGENT, (s) => s.pane?.steps?.[0]?.fact === FST_SUB_SECOND_TIME, {
            nudge: republish,
        });
        await shot("b10b-sub-second-pane");
        rec(
            "P10. a step that ran 211 ms reads <1s in the pane, and the steps around it keep their times",
            () =>
                subSecond.pane.steps[0].key === "tree" &&
                subSecond.pane.steps[0].fact === FST_SUB_SECOND_TIME &&
                fstSame(subSecond.pane.steps.slice(1).map((s) => s.fact), FST_STEP_TIME.slice(1, 5)),
            { steps: subSecond?.pane?.steps?.map((s) => [s.key, s.fact]) }
        );
        const verifierHead = `${FST_PANE}?.querySelector('[data-final-step="verifier"] [data-final-step-head]')`;
        const clickable = await h.ev(`${verifierHead}?.tagName === "BUTTON"`);
        await finalShotsClick(h, verifierHead);
        const opened = await fstUntil(
            h,
            `(() => {
                const wrap = document.querySelector("[data-cockpit-surface-wrap]");
                return {
                    pane: ${FST_PANE} != null,
                    ended: (wrap?.textContent ?? "").includes(${JSON.stringify(FST_ENDED_BANNER)}),
                    finalTab: document.querySelector("[data-workspace-final]") != null,
                };
            })()`,
            (s) => !s.pane && s.ended
        );
        await shot("b10c-verifier-transcript");
        rec(
            "P11. the Verifier step of a passed stage is a button, and a click opens the verifier's ended transcript in place of the pane, with its Final tab beside it",
            () => clickable === true && opened.pane === false && opened.ended === true && opened.finalTab === true,
            { clickable, opened }
        );

        // --- Part A: a dag really finalizing, run by the engine ---
        const live = await fstStartLive(h, ctx);
        const liveBoot = await fstBoot(h, ctx, false);
        rec(
            "A0. the engine started round 1 on the seeded dag: Verify running with output, no tree on the stage and no verifier",
            () =>
                liveBoot &&
                live.status === "finalizing" &&
                live.state === "checking" &&
                live.step === "verify" &&
                live.output.includes(`${FST_MARK} 3`) &&
                live.tree === "" &&
                live.verifierrunid === "",
            { liveBoot, ...live }
        );
        a = await fstAgent(h, (s) => s.rows.length === 1 && /step 2 of 4$/.test(s.rows[0].sub) && s.status != null, {
            ms: 20_000,
        });
        rec(
            "A1. the tree has one Final verification row naming the running step, and the run's strip has its final slot",
            () =>
                a.rows.length === 1 &&
                a.rows[0].title === "Final verification" &&
                /^Verify · \S.* · step 2 of 4$/.test(a.rows[0].sub) &&
                a.rows[0].tone === "run" &&
                a.slot === "run" &&
                /final verification/i.test(a.strip),
            { rows: a?.rows, slot: a?.slot, strip: a?.strip }
        );
        rec(
            "A2. the lead's rail draws no step of the stage, the tree's row carries it, and the Run status reads Verifying",
            () =>
                a.railSteps === 0 &&
                a.status.startsWith("Verifying") &&
                a.status.includes("next Final, then the verifier"),
            { railSteps: a?.railSteps, status: a?.status }
        );
        await shot("a1-row-and-lead-rail");

        // the form the run sheet shares with the pane, opened where it always was and left without ending
        await h.goto("jarvis");
        await polishWaitFor(h, `typeof window.__openAddress === "function"`, 5000);
        await h.ev(`window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)})`);
        const sheetEnd = fstButton(FST_SHEET, "End final stage");
        await polishWaitFor(h, `!!${sheetEnd}`, 10_000);
        await finalShotsClick(h, sheetEnd);
        const sheetFormExpr = `(() => {
            const form = ${FST_SHEET}?.querySelector("[data-run-sheet-end-final]");
            return form
                ? {
                      reason: form.querySelector("textarea") != null,
                      buttons: [...form.querySelectorAll("button")].map((b) => b.textContent.trim()),
                  }
                : null;
        })()`;
        const sheetForm = await fstUntil(h, sheetFormExpr, (s) => s.reason);
        await shot("a3-run-sheet-end-form");
        await finalShotsClick(h, fstButton(`${FST_SHEET}?.querySelector("[data-run-sheet-end-final]")`, "Keep running"));
        const sheetClosed = await polishWaitFor(h, `${FST_SHEET} != null && ${sheetFormExpr} == null`, 5000);
        const stillRunning = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.final?.state;
        rec(
            "A3. the run sheet's End final stage opens the shared form with its reason box and both outcomes, and Keep running closes it",
            () =>
                sheetForm.reason &&
                fstSame(sheetForm.buttons, ["Pass unverified", "Fail", "Keep running"]) &&
                sheetClosed &&
                stillRunning === "checking",
            { sheetForm, sheetClosed, stillRunning }
        );

        await h.goto("agent");
        await finalShotsClick(h, `${FST_TREE}?.querySelector("[data-final-row]")`);
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].selected && s.pane.output != null && s.finalTab);
        rec(
            "A4. clicking the tree's row focuses it: the pipeline, Verify running with the spinner and opened on its live tail and the tail's note, no card, and End final stage; the workspace pane with its Final tab beside it, no details rail",
            () =>
                a.rows[0].selected &&
                !a.rail &&
                a.finalTab &&
                fstSame(fstStates(a.pane.steps), ["passed", "running", "waiting", "waiting"]) &&
                a.pane.steps[1].mark === "Running" &&
                a.pane.steps[1].expanded === "true" &&
                a.pane.steps[1].body.command.endsWith(fstFlat(FST_LIVE_VERIFY)) &&
                a.pane.steps[1].body.text.endsWith("output tail · the engine publishes it every 10s") &&
                a.pane.steps[1].body.card == null &&
                a.pane.output.includes(`${FST_MARK} 3`) &&
                a.pane.end,
            { rows: a?.rows, pane: a?.pane, rail: a?.rail, finalTab: a?.finalTab }
        );
        await shot("a4-pane");

        d = await fstDag(h, ctx, (s) => s.peek.output != null);
        rec(
            "A5. the DAG's last node is the final stage, with an edge from each sink task, and the stage line has no final verify entry",
            () =>
                d.cards[d.cards.length - 1] === "final" &&
                fstSame(d.edges.filter((e) => e.endsWith(">final")), FST_SINK_EDGES) &&
                /^round 1 · Verify · /.test(d.node.meta) &&
                fstSame(d.node.strip, ["passed", "running", "waiting", "waiting"]) &&
                d.stageLine.startsWith("Run route ·") &&
                !/final verify/i.test(d.stageLine),
            { cards: d?.cards, edges: d?.edges, node: d?.node, stageLine: d?.stageLine }
        );
        rec(
            "A6. selecting the node opens its peek card: each step's command and state, the output tail and End final stage",
            () =>
                d.node.pressed === "true" &&
                fstSame(d.peek.steps.map((s) => s.command), [
                    "prepares the tree the stage runs in",
                    FST_LIVE_VERIFY,
                    FST_LIVE_FINAL,
                    "judges the merged result",
                ]) &&
                fstSame(fstStates(d.peek.steps), ["passed", "running", "waiting", "waiting"]) &&
                d.peek.output.includes(FST_MARK) &&
                d.peek.end,
            { node: d?.node, peek: d?.peek }
        );
        await shot("a6-dag-peek");

        // the form opens inside the card, whose height the placement bounds by the pane; nothing else measures it
        const PEEK_FORM = `document.querySelector("[data-dag-final-peek] [data-run-sheet-end-final]")`;
        await finalShotsClick(h, `document.querySelector("[data-dag-final-peek] [data-final-end]")`);
        await polishWaitFor(h, `${PEEK_FORM} != null`, 3000);
        const peekForm = await h.ev(`(() => {
            const form = ${PEEK_FORM};
            if (!form) return null;
            const box = form.parentElement.getBoundingClientRect();
            const card = form.closest("[data-dag-final-peek]");
            const c = card.getBoundingClientRect();
            const clippedBy = [];
            for (let el = form.parentElement.parentElement; el && el !== document.body; el = el.parentElement) {
                const cs = getComputedStyle(el);
                if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
                const r = el.getBoundingClientRect();
                if (box.top < r.top - 0.5 || box.bottom > r.bottom + 0.5 || box.left < r.left - 0.5 || box.right > r.right + 0.5) {
                    clippedBy.push((el.className || el.tagName).toString().slice(0, 60));
                }
            }
            // what sits on the form's bottom corners: the form itself unless something covers or cuts it
            const corner = (x, y) => form.parentElement.contains(document.elementFromPoint(x, y));
            return {
                box: { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) },
                card: { top: Math.round(c.top), bottom: Math.round(c.bottom) },
                inCard: card != null,
                cardCuts: box.top < c.top - 0.5 || box.bottom > c.bottom + 0.5 || box.left < c.left - 0.5 || box.right > c.right + 0.5,
                viewport: innerHeight,
                clippedBy,
                corners: corner(box.left + 4, box.bottom - 4) && corner(box.right - 4, box.bottom - 4),
            };
        })()`);
        await shot("a6-dag-peek-end-form");
        await finalShotsClick(h, fstButton(PEEK_FORM, "Keep running"));
        const peekFormClosed = await polishWaitFor(h, `${PEEK_FORM} == null`, 3000);
        rec(
            "A6b. End final stage in the DAG peek card opens its form whole inside the card: neither the card nor any clipping ancestor cuts it, nothing covers its bottom, and Keep running closes it",
            () =>
                peekForm != null &&
                peekForm.inCard &&
                !peekForm.cardCuts &&
                peekForm.clippedBy.length === 0 &&
                peekForm.corners &&
                peekForm.box.bottom <= peekForm.viewport &&
                peekFormClosed,
            { peekForm, peekFormClosed }
        );

        await h.goto("agent");
        await finalShotsClick(h, `${FST_PANE}?.querySelector("[data-final-end]")`);
        const paneForm = (await fstUntil(h, FST_AGENT, (s) => s.pane.form))?.pane?.form;
        const typed = await h.ev(`(() => {
            const box = ${FST_PANE}?.querySelector("[data-run-sheet-end-final] textarea");
            if (!box) return false;
            // a controlled input takes a value only through the native setter and an input event
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(FST_REASON)});
            box.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`);
        const unverifiedBtn = fstButton(`${FST_PANE}?.querySelector("[data-run-sheet-end-final]")`, "Pass unverified");
        await polishWaitFor(h, `${unverifiedBtn}?.disabled === false`, 3000);
        await shot("a7-end-form");
        await finalShotsClick(h, unverifiedBtn);
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].tone === "warn" && s.pane.steps[1].state === "stopped", { ms: 20_000 });
        await shot("a7-ended-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 1 · unverified");
        rec(
            "A7. End final stage, as unverified with a reason: the row, the pane and the node read unverified, the reason is whole, and Verify reads stopped",
            () =>
                paneForm &&
                typed &&
                a.rows.length === 1 &&
                a.rows[0].sub === "unverified · 1 reason" &&
                a.rows[0].tone === "warn" &&
                a.slot === "warn" &&
                fstSame(fstStates(a.pane.steps), ["passed", "stopped", "notrun", "notrun"]) &&
                a.pane.text.includes(`ended by the human: ${FST_REASON}`) &&
                !a.pane.end &&
                d.node.meta === "round 1 · unverified" &&
                fstSame(d.node.strip, ["passed", "stopped", "notrun", "notrun"]) &&
                d.peek.text.includes(`ended by the human: ${FST_REASON}`) &&
                !d.peek.end,
            { paneForm, typed, rows: a?.rows, slot: a?.slot, pane: a?.pane, node: d?.node, peek: d?.peek }
        );
        await shot("a7-ended-dag");
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "final-stage", {
            what: "cancel the channel's other runs and restore the rail and view preferences",
            fn: async () => {
                try {
                    // the verifier's seeded run, and t-1's child run, which Part A unlinked from its task with its
                    // worker still at work in the lane's tree
                    const runs = ctx.channelId ? await channelRuns(h, ctx.channelId) : [];
                    for (const run of runs) {
                        if (run.id === ctx.runId) {
                            // the engine completed the run when the stage was ended, and a finished run is not cancelled
                            if (run.status === "done") ctx.runId = null;
                        } else if (run.status !== "done" && run.status !== "cancelled") {
                            await h.rpc("cancelrun", { channelid: ctx.channelId, runid: run.id });
                        }
                    }
                } finally {
                    await h.ev(
                        ctx.prevRail == null
                            ? `localStorage.removeItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`
                            : `localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, ${JSON.stringify(ctx.prevRail)})`
                    );
                    await restoreDefaultView(h);
                }
            },
        });
        rmSync(ctx.out, { recursive: true, force: true });
        // a worker that was just stopped holds its lane's tree for a moment, and a tree left behind fails the scenario
        rmSync(ctx.cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    },
};
