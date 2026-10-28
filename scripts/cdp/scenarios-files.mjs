// Diff surface scenarios: git history, compare, review marks, comments, renames.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    CTRL,
    FINAL_SHOTS_UICTX,
    MIN_FONT_PX,
    SURFACE_ROOT,
    floorStep,
    git,
    openCanvasTerminal,
    polishWaitFor,
    reloadApp,
    restoreLocalStorage,
    teardownFixtureRun,
    waveService,
} from "./scenarios-shared.mjs";

// --- git history: filters, paging, the two repository-failure panels, persistence ----------------
// Every state is arranged for real — globalStore is not on window, so nothing can be injected. The
// broken repo is a genuine failure: its ref file resolves but the object it names is gone, so
// `git log` fails while the directory is still a work tree.
export const gitHistory = {
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
            // on a fresh store the projects reach the frontend a moment after createproject, and until
            // then the surface is its no-source empty state, which has no picker
            const option = `[data-files-source-option=${JSON.stringify(name)}]`;
            if (!(await polishWaitFor(h, `!!document.querySelector('[data-files-source-picker]')`, 10000))) {
                throw new Error("the Diff source picker never rendered");
            }
            await h.ev(`document.querySelector('[data-files-source-picker]').click()`);
            await polishWaitFor(h, `!!document.querySelector(${JSON.stringify(option)})`, 5000);
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
            "3. filter narrows the list, states the matching count, and hides the graph",
            filtered > 0 && filtered < first && countChip.includes("matching") && !gutterStillThere,
            `rows=${filtered} chip="${countChip}" gutterStillThere=${gutterStillThere}`
        );
        await h.shot("cdp-shots/git-history-filtered.png");

        // a filter that matches nothing leaves one message, the history's own: the commit pane and the
        // diff pane step aside rather than each asking for a pick there is nothing to make
        await h.ev(`document.querySelector('[data-history-filter]').focus()`);
        await h.cdp("Input.insertText", { text: "-matches-nothing" });
        await sleep(1200);
        const noneRows = await rowCount();
        const noneText = await h.ev(`document.body.innerText`);
        const diffPane = await present("[data-diff-pane]");
        rec(
            "3b. a filter with no matches shows only the history's empty state",
            noneRows === 0 &&
                noneText.includes("No commits match") &&
                !noneText.includes("Select a commit") &&
                !noneText.includes("Pick a ") &&
                !diffPane,
            `rows=${noneRows} diffPane=${diffPane} selectCommit=${noneText.includes("Select a commit")} pick=${noneText.includes("Pick a ")}`
        );
        await h.shot("cdp-shots/git-history-no-match.png");

        // Escape clears the filters (the header says "Clear filters" with an esc hint), not navigate home
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
        const historyFloor = await floorStep(h, `11. no visible text on the Diff surface's history is under ${MIN_FONT_PX}px`, SURFACE_ROOT);

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
        steps.push(historyFloor);

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

// --- diff surface: a comparison at the shipped window size ---------------------------------------
// The layout claim the parity plan was written for: at 1000x700 the history column has to fold to a
// rail, or a fixed 460px of commits plus the file list leaves the diff pane about 240px and nothing
// in it can be read. Pinned to that size on purpose - at the harness's roomy 1600x950 default there
// is room for all three columns and the assertion proves nothing.
export const diffCompare = {
    name: "diff-compare",
    surface: "files",
    async arrange(h) {
        const dir = mkdtempSync(join(tmpdir(), "verify-diff-compare-"));
        git(dir, "init", "-q", "--initial-branch=main");
        writeFileSync(join(dir, "README.md"), "# retry\n");
        writeFileSync(
            join(dir, "policy.go"),
            `package retry

func Budget() int {
    return 3
}
`
        );
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "seed the retry package");
        git(dir, "checkout", "-q", "-b", "feature");
        writeFileSync(
            join(dir, "policy.go"),
            `package retry

func Budget() int {
    return 8
}
`
        );
        writeFileSync(
            join(dir, "submit.go"),
            `package retry

func Submit(id string) error {
    return nil
}
`
        );
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "raise the budget, add submit");
        const name = "verify-diff-compare";
        await h.rpc("createproject", { name, path: dir });

        // Deterministic entry. historyCollapsedAtom is an explicit override that a resize deliberately
        // cannot undo (difflayout.ts), and it is module-level, so it outlives the surface for the whole
        // life of the page. An earlier run of this scenario would otherwise be the thing that decides
        // what "at 1000x700" means below, and a reload is the only route back to "follow the width".
        try {
            await h.ev("location.reload()");
        } catch {
            /* the evaluate is cut off by the navigation it just started */
        }
        for (let waited = 0; waited < 30000; waited += 500) {
            const up = await h
                .ev("!!window.TabRpcClient && !!document.querySelector('nav button')")
                .catch(() => false);
            if (up) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        return { dir, name };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const present = (sel) => h.ev(`!!document.querySelector(${JSON.stringify(sel)})`);
        const widthOf = (sel) =>
            h.ev(
                `(() => { const el = document.querySelector(${JSON.stringify(sel)});
                  return el ? Math.round(el.getBoundingClientRect().width) : 0; })()`
            );
        const click = async (sel) => {
            const ok = await h.ev(
                `(() => { const el = document.querySelector(${JSON.stringify(sel)});
                  if (!el) return false; el.click(); return true; })()`
            );
            if (!ok) throw new Error(`nothing to click at ${sel}`);
        };
        // a cold dev app compiles the surface's modules on first visit, so the fixed sleeps below are a
        // floor, not a budget - wait for the thing itself rather than guessing how slow the first run is
        const waitFor = async (sel, ms) => {
            for (let waited = 0; waited < ms; waited += 250) {
                if (await present(sel)) return true;
                await sleep(250);
            }
            return false;
        };

        // the shipped window (src-tauri/tauri.conf.json), which is the whole point of this scenario
        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 1000,
            height: 700,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await sleep(600);

        await click("[data-files-source-picker]");
        await sleep(200);
        await click(`[data-files-source-option=${JSON.stringify(ctx.name)}]`);
        await sleep(1600); // change list + history page

        const railWidth = await widthOf("[data-history-rail]");
        const expandedRow = await present("[data-history-row]");
        rec(
            "1. at 1000x700 the commit column folds to a rail",
            railWidth > 0 && railWidth <= 48 && !expandedRow,
            `railWidth=${railWidth} expandedRows=${expandedRow}`
        );

        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "c",
            code: "KeyC",
            text: "c",
            windowsVirtualKeyCode: 67,
        });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67 });
        await sleep(2200); // divergence, then the aggregate's own change list
        const chipOn = await h.ev(
            `document.querySelector('[data-range-chip="compare"]')?.getAttribute('aria-pressed') === 'true'`
        );
        rec("2. c switches the range to a two-ref comparison", chipOn, `compareChipPressed=${chipOn}`);

        // the rail stands in for the compare column at this width too, so prove the column is what it
        // unfolds into rather than a separate history-only affordance
        await click('[data-history-rail] button[title="Expand history"]');
        await sleep(500);
        const column = await present("[data-compare-column]");
        await click('button[title="Collapse history"]');
        await sleep(500);
        const railBack = await present("[data-history-rail]");
        rec(
            "3. the rail unfolds into the compare column and back",
            column && railBack,
            `column=${column} railBack=${railBack}`
        );

        await waitFor('[data-changed-file-row="policy.go"]', 8000);
        const files = await h.ev(
            `Array.from(document.querySelectorAll('[data-changed-file-row]')).map(e => e.dataset.changedFileRow).join(',')`
        );
        rec(
            "4. the aggregate lists what the branch changed",
            files.includes("policy.go") && files.includes("submit.go"),
            `files=${files}`
        );

        // the modified file, not the added one: it is the case that needs both FileAtRef reads. Recorded
        // as part of the step rather than thrown, so a miss here still reports what the four above found.
        const opened = await h.ev(
            `(() => { const el = document.querySelector('[data-changed-file-row="policy.go"]');
              if (!el) return false; el.click(); return true; })()`
        );
        await sleep(2500); // two FileAtRef reads, then Monaco's first mount
        const editor = await present("[data-diff-pane] .monaco-diff-editor");
        const paneWidth = await widthOf("[data-diff-pane]");
        rec(
            "5. the file opens in Monaco, in a pane wide enough to read",
            opened && editor && paneWidth >= 400,
            `clicked=${opened} monaco=${editor} paneWidth=${paneWidth}`
        );
        await h.shot("cdp-shots/diff-compare.png");
        steps.push(await floorStep(h, `6. no visible text on the Diff surface is under ${MIN_FONT_PX}px`, SURFACE_ROOT));

        return steps;
    },
    async teardown(h, ctx) {
        // This scenario is the only one that drives module-level Diff state, and both bits it touches
        // OUTLIVE the surface: compare mode, and an explicit collapse that a resize deliberately cannot
        // undo (difflayout.ts). Leaving the column explicitly collapsed makes the next Diff scenario read
        // a rail at 1600x950 and find no [data-history-scroll] at all, which is how this was found.
        const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...esc });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...esc });
        await h.ev(`document.querySelector('[data-history-rail] button[title="Expand history"]')?.click()`);
        try {
            await h.rpc("deleteproject", { name: ctx.name });
        } catch {
            /* leave a stale registry entry rather than failing teardown */
        }
        try {
            // the surface is still scoped here, so wavesrv may hold the repo open a moment longer
            rmSync(ctx.dir, { recursive: true, force: true });
        } catch {
            /* a leftover temp repo is cheaper than a failed teardown */
        }
    },
};

// --- diff surface: review marks in the changed-file list -----------------------------------------
// docs/superpowers/plans/2026-10-12-diff-review-marks.md, end to end on a temp repo: marking from
// the row box, v and the header button, a directory box, a file that changed after it was marked, a
// reload, and a commit and a compare aggregate that keep marks of their own.
const REVIEW_STORAGE_KEY = "diff.review.marks";

// the retry package on a feature branch, and a working tree with one file of each status the list draws:
// README.md modified, src/retry/policy.go modified, src/retry/backoff.go added, src/retry/legacy.go deleted
function seedRetryRepo(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    git(dir, "init", "-q", "--initial-branch=main");
    mkdirSync(join(dir, "src", "retry"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# retry\n");
    writeFileSync(join(dir, "src", "retry", "policy.go"), "package retry\n\nfunc Budget() int {\n    return 3\n}\n");
    writeFileSync(join(dir, "src", "retry", "legacy.go"), "package retry\n\nfunc Legacy() {}\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "seed the retry package");
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "src", "retry", "policy.go"), "package retry\n\nfunc Budget() int {\n    return 8\n}\n");
    writeFileSync(
        join(dir, "src", "retry", "submit.go"),
        "package retry\n\nfunc Submit(id string) error {\n    return nil\n}\n"
    );
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "raise the budget, add submit");
    // the working tree: four files, one of each status the list draws
    writeFileSync(join(dir, "README.md"), "# retry\n\nBudgets and backoff for job submission.\n");
    writeFileSync(
        join(dir, "src", "retry", "policy.go"),
        "package retry\n\nfunc Budget() int {\n    return 8\n}\n\nfunc Floor() int {\n    return 1\n}\n"
    );
    writeFileSync(join(dir, "src", "retry", "backoff.go"), "package retry\n\nfunc Backoff(n int) int {\n    return n * 2\n}\n");
    git(dir, "add", "-N", "src/retry/backoff.go");
    rmSync(join(dir, "src", "retry", "legacy.go"));
    return dir;
}

export const diffReviewMarks = {
    name: "diff-review-marks",
    surface: "files",
    async arrange(h) {
        const dir = seedRetryRepo("verify-diff-review-");
        const name = "verify-diff-review-marks";
        await h.rpc("createproject", { name, path: dir });

        // the store reads localStorage once, at module load, so the key is cleared before the reload that
        // gives this scenario fresh module state; teardown puts back whatever the user had
        const prevMarks = await h.ev(`localStorage.getItem(${JSON.stringify(REVIEW_STORAGE_KEY)})`);
        await h.ev(`localStorage.removeItem(${JSON.stringify(REVIEW_STORAGE_KEY)})`);
        await reloadApp(h);
        return { dir, name, prevMarks };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
        const rowSel = (path) => `[data-changed-file-row=${JSON.stringify(path)}]`;
        const boxSel = (path) => `[data-review-toggle=${JSON.stringify(path)}]`;
        const DIR = "src/retry";
        const dirRowSel = `[data-changed-dir-row=${JSON.stringify(DIR)}]`;
        const dirBoxSel = `[data-review-toggle-dir=${JSON.stringify(DIR)}]`;
        const until = async (expr, ms = 8000) => {
            for (let waited = 0; waited < ms; waited += 250) {
                if (await h.ev(expr).catch(() => false)) return true;
                await sleep(250);
            }
            return false;
        };
        const click = (sel) => h.ev(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
        const stateOf = (path) => h.ev(`${q(rowSel(path))}?.dataset.reviewState ?? "absent"`);
        const openRow = () => h.ev(`${q('[data-changed-file-row][aria-current="true"]')}?.dataset.changedFileRow ?? ""`);
        const rows = () =>
            h.ev(`Array.from(document.querySelectorAll('[data-changed-file-row]')).map(e => e.dataset.changedFileRow).join(',')`);
        const progress = async () =>
            JSON.parse(
                await h.ev(`(() => { const el = ${q("[data-files-reviewed]")};
                  return JSON.stringify(el ? { done: el.dataset.done, total: el.dataset.total, text: el.textContent }
                                           : { done: null, total: null, text: "" }); })()`)
            );
        const doneIs = (n) => `${q("[data-files-reviewed]")}?.dataset.done === ${JSON.stringify(String(n))}`;
        const stateIs = (path, state) => `${q(rowSel(path))}?.dataset.reviewState === ${JSON.stringify(state)}`;
        const isOpen = (path) => `${q(rowSel(path))}?.getAttribute("aria-current") === "true"`;
        const press = async (key, code, vk) => {
            // an open diff can hold focus in Monaco, where the dispatcher lets every key through
            await h.ev("document.activeElement?.blur?.()");
            await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key, windowsVirtualKeyCode: vk });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
        };
        const pin = () =>
            h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        const pick = async () => {
            await click("[data-files-source-picker]");
            const option = `[data-files-source-option=${JSON.stringify(ctx.name)}]`;
            await until(`!!${q(option)}`, 4000);
            await click(option);
            return until(`!!${q(rowSel("src/retry/backoff.go"))}`, 15000);
        };

        try {
            await pin();
            await sleep(400);
            const picked = await pick();
            const listed = await until(`document.querySelectorAll('[data-changed-file-row]').length === 4`, 4000);
            const allNone = await until(
                `Array.from(document.querySelectorAll('[data-changed-file-row]')).every(e => e.dataset.reviewState === "none")`,
                2000
            );
            let p = await progress();
            rec(
                "1. the working tree lists 4 unreviewed files and a progress line at 0/4",
                picked && listed && allNone && p.done === "0" && p.total === "4",
                `rows=${await rows()} progress=${p.done}/${p.total}`
            );
            await h.shot("cdp-shots/diff-review-marks-empty.png");

            await click(rowSel("README.md"));
            const headerUp = await until(`!!${q("[data-review-open]")}`);
            await press("v", "KeyV", 86);
            const advanced = await until(`${stateIs("README.md", "ok")} && ${doneIs(1)} && ${isOpen("src/retry/backoff.go")}`);
            rec(
                "2. v marks README.md and opens the next unreviewed file, wrapping round to src/retry/backoff.go",
                headerUp && advanced,
                `header=${headerUp} README=${await stateOf("README.md")} done=${(await progress()).done} open=${await openRow()}`
            );
            await h.shot("cdp-shots/diff-review-marks-partial.png");

            await click(boxSel("src/retry/policy.go"));
            const boxed = await until(stateIs("src/retry/policy.go", "ok"));
            await sleep(300); // a selection move would land with the mark, so give it a beat to show
            const stayed = (await openRow()) === "src/retry/backoff.go";
            rec(
                "3. a box on another row marks it without moving the open file",
                boxed && stayed,
                `policy=${await stateOf("src/retry/policy.go")} open=${await openRow()}`
            );

            const partialDir = await until(`${q(dirRowSel)}?.textContent.includes("1/3")`, 3000);
            rec(
                "4a. the src/retry directory row reads 1/3",
                partialDir,
                `dirRow="${await h.ev(`${q(dirRowSel)}?.textContent ?? "absent"`)}"`
            );
            await h.shot("cdp-shots/diff-review-marks-dir-partial.png");

            await click(dirBoxSel);
            const allDone = await until(
                `${stateIs("src/retry/backoff.go", "ok")} && ${stateIs("src/retry/legacy.go", "ok")} && ${doneIs(4)}`
            );
            p = await progress();
            rec(
                "4b. the directory box marks the rest, and the progress line reads all 4 reviewed",
                allDone && p.text.includes("all 4 reviewed"),
                `done=${p.done}/${p.total} text="${p.text}"`
            );
            await h.shot("cdp-shots/diff-review-marks-all.png");

            await click(dirRowSel);
            const folded = await until(`!${q(rowSel("src/retry/policy.go"))} && !!${q(dirRowSel)}`, 3000);
            const foldedBox = await h.ev(`${q(dirBoxSel)}?.getAttribute("aria-pressed") === "true"`);
            rec(
                "4c. the collapsed directory keeps its reviewed box",
                folded && foldedBox,
                `collapsed=${folded} boxPressed=${foldedBox}`
            );
            await h.shot("cdp-shots/diff-review-marks-dir-collapsed.png");
            await click(dirRowSel);
            await until(`!!${q(rowSel("src/retry/policy.go"))}`, 3000);

            appendFileSync(join(ctx.dir, "src", "retry", "policy.go"), "\n// floors stay above zero\n");
            await press("r", "KeyR", 82);
            const stale = await until(`${stateIs("src/retry/policy.go", "stale")} && ${doneIs(3)}`, 15000);
            rec(
                "5. a file edited after it was marked reads stale and drops out of the count",
                stale,
                `policy=${await stateOf("src/retry/policy.go")} done=${(await progress()).done}`
            );
            await h.shot("cdp-shots/diff-review-marks-stale.png");

            // the header labels its buttons only on a pane of LABELLED_MIN_PX (diffoptions.ts), which 1600px
            // leaves about 760px of, so this one step widens the window to show the label
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 2000, height: 950, deviceScaleFactor: 1, mobile: false });
            await click(rowSel("README.md"));
            const pressed = await until(`${q("[data-review-open]")}?.getAttribute("aria-pressed") === "true"`);
            await until(`${q("[data-review-open]")}?.textContent.startsWith("Reviewed")`, 3000);
            const label = await h.ev(`${q("[data-review-open]")}?.textContent ?? ""`);
            await h.shot("cdp-shots/diff-review-marks-header-reviewed.png");
            await pin();
            await click("[data-review-open]");
            const unmarked = await until(stateIs("README.md", "none"));
            await sleep(300);
            const keptOpen = (await openRow()) === "README.md";
            rec(
                "6. the header button reads Reviewed on a marked file, and unmarking it stays on that file",
                pressed && label.startsWith("Reviewed") && unmarked && keptOpen,
                `pressed=${pressed} label="${label}" README=${await stateOf("README.md")} open=${await openRow()}`
            );

            await reloadApp(h);
            await pin();
            await h.goto("files");
            const repicked = await pick();
            const kept = await until(
                `${stateIs("src/retry/backoff.go", "ok")} && ${stateIs("src/retry/policy.go", "stale")}`,
                4000
            );
            rec(
                "7. marks survive a reload",
                repicked && kept,
                `backoff=${await stateOf("src/retry/backoff.go")} policy=${await stateOf("src/retry/policy.go")}`
            );

            const commitClicked = await h.ev(`(() => {
                const row = Array.from(document.querySelectorAll('[data-history-row]'))
                    .find((r) => r.textContent.includes("raise the budget, add submit"));
                const btn = row?.querySelector("button");
                if (!btn) return false;
                btn.click();
                return true;
            })()`);
            const commitRows = await until(
                `!!${q(rowSel("src/retry/submit.go"))} && !${q(rowSel("README.md"))} && document.querySelectorAll('[data-changed-file-row]').length === 2`
            );
            const commitFresh =
                (await stateOf("src/retry/policy.go")) === "none" && (await stateOf("src/retry/submit.go")) === "none";
            // one box at a time: a box on the open file advances the selection, which re-renders the list
            await click(boxSel("src/retry/policy.go"));
            await until(stateIs("src/retry/policy.go", "ok"), 3000);
            await click(boxSel("src/retry/submit.go"));
            const commitAll = await until(`${doneIs(2)} && ${q("[data-files-reviewed]")}?.textContent.includes("all 2 reviewed")`);
            rec(
                "8. the feature commit keeps marks of its own, separate from the working tree",
                commitClicked && commitRows && commitFresh && commitAll,
                `clicked=${commitClicked} rows=${await rows()} startedNone=${commitFresh} text="${(await progress()).text}"`
            );
            await h.shot("cdp-shots/diff-review-marks-commit.png");

            await press("c", "KeyC", 67);
            const comparing = await until(
                `${q('[data-range-chip="compare"]')}?.getAttribute("aria-pressed") === "true" && !!${q(rowSel("src/retry/submit.go"))} && ${doneIs(0)}`,
                10000
            );
            // entering compare opens the ref editor on the pair it already reads; applying that pair as
            // it stands closes the editor, whose suggestions would otherwise cover pane 2 in the shot
            await h.ev(`(() => {
                const root = document.querySelector('input[placeholder="base ref"]')?.parentElement?.parentElement;
                Array.from(root?.querySelectorAll("button") ?? []).find((b) => b.textContent.trim() === "Compare")?.click();
            })()`);
            await until(`!document.querySelector('input[placeholder="base ref"]') && !!${q(boxSel("src/retry/submit.go"))}`, 5000);
            await click(boxSel("src/retry/submit.go"));
            const oneMarked = await until(doneIs(1));
            p = await progress();
            rec(
                "9a. the compare aggregate starts unreviewed, and one mark reads 1/N",
                comparing && oneMarked && p.text.includes(`1/${p.total} reviewed`),
                `rows=${await rows()} done=${p.done}/${p.total} text="${p.text}"`
            );
            await h.shot("cdp-shots/diff-review-marks-compare.png");

            await click("[data-review-clear]");
            const cleared = await until(doneIs(0), 3000);
            rec("9b. Clear drops the aggregate's marks", cleared, `done=${(await progress()).done}`);
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        // compare mode and an explicit history collapse both outlive the surface (see diff-compare)
        const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...esc });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...esc });
        await h.ev(`document.querySelector('[data-history-rail] button[title="Expand history"]')?.click()`);
        await h.ev(restoreLocalStorage(REVIEW_STORAGE_KEY, ctx.prevMarks));
        try {
            await h.rpc("deleteproject", { name: ctx.name });
        } catch {
            /* leave a stale registry entry rather than failing teardown */
        }
        try {
            rmSync(ctx.dir, { recursive: true, force: true });
        } catch {
            /* a leftover temp repo is cheaper than a failed teardown */
        }
    },
};

// --- diff surface: comments on the diff's lines ---------------------------------------------------
// docs/superpowers/plans/2026-10-26-diff-comments.md, Task 3, on diff-review-marks's temp repo: the + on a
// hovered line, `m` on a selection, a note with an `m` in it, edit and delete, a removed range in split view,
// and a comment that follows its lines when the working tree moves them.
const COMMENT_STORAGE_KEY = "diff.comments.pending";
const SHIFT = 8;
// in-page: where line n's number sits in one side's editor of the diff pane, and where that editor's text starts
const DIFF_LINE_LIB = `
const lineBox = (side, n) => {
    const ed = document.querySelector('[data-diff-pane] .editor.' + side);
    const el = ed && [...ed.querySelectorAll('.margin-view-overlays .line-numbers')]
        .find((e) => e.textContent.trim() === String(n));
    if (!el || el.getBoundingClientRect().height === 0) return null;
    const r = el.getBoundingClientRect();
    const text = ed.querySelector('.view-lines').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2, textLeft: text.left };
};`;

// Task 4's steps: the Prompt board's three notes, on policy.go as the board draws it, from a shell tab made a
// roster agent (its block's cwd is the temp repo)
const DC_AGENT_TOPIC = "verify-diff-comments-agent";
const PLUS_HOVER_TRIES = 3;
const DC_POLICY_BOARD = "package retry\n\nfunc Budget() int {\n    return 8\n}\n\nfunc Floor() int {\n    return 1\n}\n";
const DC_NOTE_RETURN = "Why 8? The incident note says five retries were enough. Put the reason in a comment above the return.";
const DC_NOTE_FLOOR = "A floor of 1 means a zero budget can never be configured. Return 0 here and let Budget enforce the minimum.";
const DC_NOTE_LEGACY = "Keep Legacy() for one release; the scheduler still calls it.";

// A run arranged as diff-review-marks-run arranges its own: deferred, written done with sealed evidence (which
// draws the sheet's diff link), and with a landing tree and no land state, so it has not landed. Opened the way
// a finished run's sheet opens it.
async function openDcRun(h, ctx, { until, q, rowSel }) {
    const cwd = mkdtempSync(join(tmpdir(), "verify-diff-comments-run-"));
    ctx.run = { cwd };
    try {
        git(cwd, "init", "-q", "--initial-branch=main");
        mkdirSync(join(cwd, "src", "retry"), { recursive: true });
        writeFileSync(join(cwd, "src", "retry", "policy.go"), "package retry\n\nfunc Budget() int {\n    return 3\n}\n");
        git(cwd, "add", ".");
        git(cwd, "commit", "-q", "-m", "seed the retry package");
        const wslist = await h.rpc("workspacelist", null);
        const ch = await h.rpc("createchannel", { name: "verify-diff-comments-run", projectpath: cwd });
        ctx.run.channelId = ch.oid;
        const created = await h.rpc("createrun", {
            channelid: ch.oid,
            workspaceid: wslist[0].workspacedata.oid,
            goal: "verify diff-comments: do nothing, make no file changes, stop immediately",
            runtime: "claude",
            mode: "orchestrator",
            deferstart: true,
        });
        ctx.run.runId = created.run.id;
        ctx.run.landPath = created.run.landpath;
        const tree = created.run.landpath || cwd;
        writeFileSync(join(tree, "src", "retry", "policy.go"), "package retry\n\nfunc Budget() int {\n    return 8\n}\n");
        git(tree, "add", "src");
        git(tree, "commit", "-q", "-m", "raise the budget");
        const oref = `run:${created.run.id}`;
        const evidence = {
            capturedts: Date.now(),
            hash: "",
            files: [{ path: "src/retry/policy.go", stat: "M", add: 1, del: 1 }],
            addtotal: 1,
            deltotal: 1,
            runtimems: 0,
            durationms: 0,
        };
        const stored = await waveService(h, "object", "GetObject", [oref]);
        await waveService(
            h,
            "object",
            "UpdateObject",
            [{ ...stored, otype: "run", status: "done", report: "", evidence, landpath: tree }, false],
            FINAL_SHOTS_UICTX
        );
        await h.goto("jarvis");
        await until(`typeof window.__openAddress === "function"`, 5000);
        await h.ev(`window.__openAddress(${JSON.stringify(oref)})`);
        const link = `[...document.querySelectorAll("[data-evidence-block] button")].find((b) => /open the repository diff/.test(b.textContent || ""))`;
        const linked = await until(`!!(${link})`, 10000);
        await h.ev(`${link}?.click()`);
        const listed = await until(`!!${q(rowSel("src/retry/policy.go"))}`, 15000);
        return { ok: linked && listed, linked, listed, landpath: created.run.landpath };
    } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}

// --- diff surface: the row a source opens on --------------------------------------------------------
// defaultSelection opens a dirty tree on its uncommitted row. Picking an agent source whose folder a project
// source already showed must land there too, as must picking it straight after a reload.
const DSR_AGENT_TOPIC = "verify-diff-source-row-agent";
export const diffSourceRow = {
    name: "diff-source-row",
    surface: "files",
    async arrange(h) {
        const dir = seedRetryRepo("verify-diff-source-row-");
        const name = "verify-diff-source-row";
        await h.rpc("createproject", { name, path: dir });
        return { dir, name };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
        const until = async (expr, ms = 8000) => {
            for (let waited = 0; waited < ms; waited += 250) {
                if (await h.ev(expr).catch(() => false)) return true;
                await sleep(250);
            }
            return false;
        };
        const click = (sel) => h.ev(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
        const README = `[data-changed-file-row="README.md"]`;
        const selectedRow = () =>
            h.ev(`[...document.querySelectorAll("[data-history-row] > button.bg-surface-selected")].map((b) => b.textContent).join(" | ")`);
        // the row settles after both the change list and the history land; read it once it has held for a second
        const settledRow = async () => {
            let last = null;
            for (let waited = 0; waited < 8000; waited += 500) {
                const now = await selectedRow();
                if (now && now === last) return now;
                last = now;
                await sleep(500);
            }
            return last;
        };
        const agentRow = `[...document.querySelectorAll("button")].find((b) => !b.dataset.filesSourceOption &&
            (b.querySelector("span.truncate")?.textContent ?? "").startsWith(${JSON.stringify(DSR_AGENT_TOPIC)}))`;
        const pickAgent = async () => {
            await click("[data-files-source-picker]");
            const listed = await until(`!!(${agentRow})`, 10000);
            await h.ev(`${agentRow}?.click()`);
            return listed && (await until(`!!${q(README)}`, 15000));
        };
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            await click("[data-files-source-picker]");
            const option = `[data-files-source-option=${JSON.stringify(ctx.name)}]`;
            await until(`!!${q(option)}`, 4000);
            await click(option);
            const projectListed = await until(`!!${q(README)}`, 15000);
            const onProject = await settledRow();
            rec(
                "1. a project source on a dirty tree opens on Uncommitted changes",
                projectListed && /Uncommitted changes/.test(onProject ?? ""),
                JSON.stringify({ projectListed, selected: onProject })
            );

            await openCanvasTerminal(h, ctx, DSR_AGENT_TOPIC);
            await h.rpc("setmeta", { oref: `block:${ctx.blockId}`, meta: { "cmd:cwd": ctx.dir } });
            await h.rpc("eventpublish", {
                event: "agent:status",
                scopes: [`block:${ctx.blockId}`],
                persist: 1,
                data: { oref: `block:${ctx.blockId}`, state: "working", agent: "claude", cwd: ctx.dir, ts: Date.now() },
            });
            const agentListed = await pickAgent();
            const onAgent = await settledRow();
            rec(
                "2. switching to an agent source in the same folder opens on Uncommitted changes",
                agentListed && /Uncommitted changes/.test(onAgent ?? ""),
                JSON.stringify({ agentListed, selected: onAgent })
            );
            await h.shot("cdp-shots/diff-source-row-agent.png");

            await reloadApp(h);
            await h.goto("files");
            const reloadListed = await pickAgent();
            const afterReload = await settledRow();
            rec(
                "3. after a reload, picking the agent source first opens on Uncommitted changes",
                reloadListed && /Uncommitted changes/.test(afterReload ?? ""),
                JSON.stringify({ reloadListed, selected: afterReload })
            );
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx.tabId) {
            try {
                await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false]);
            } catch {
                /* a tab left open is cheaper than a failed teardown */
            }
        }
        try {
            await h.rpc("deleteproject", { name: ctx.name });
        } catch {
            /* leave a stale registry entry rather than failing teardown */
        }
        try {
            rmSync(ctx.dir, { recursive: true, force: true });
        } catch {
            /* a leftover temp repo is cheaper than a failed teardown */
        }
    },
};

// --- diff surface: renames --------------------------------------------------------------------------
// The pane reads a renamed file's left side at its old path (the change list keeps git's rename source), so a
// pure rename reads Contents unchanged and an edited one shows only its edit, never the whole file as added.
const RENAME_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
export const diffRename = {
    name: "diff-rename",
    surface: "files",
    async arrange(h) {
        const dir = mkdtempSync(join(tmpdir(), "verify-diff-rename-"));
        git(dir, "init", "-q", "--initial-branch=main");
        writeFileSync(join(dir, "a.txt"), RENAME_LINES.join("\n") + "\n");
        writeFileSync(join(dir, "b.txt"), RENAME_LINES.map((l) => `b ${l}`).join("\n") + "\n");
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "seed two files");
        git(dir, "mv", "a.txt", "moved.txt");
        git(dir, "commit", "-q", "-m", "pure rename");
        git(dir, "mv", "b.txt", "b2.txt");
        writeFileSync(join(dir, "b2.txt"), RENAME_LINES.map((l, i) => (i === 4 ? "b edited" : `b ${l}`)).join("\n") + "\n");
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "rename and edit");
        const name = "verify-diff-rename";
        await h.rpc("createproject", { name, path: dir });
        return { dir, name };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
        const until = async (expr, ms = 8000) => {
            for (let waited = 0; waited < ms; waited += 250) {
                if (await h.ev(expr).catch(() => false)) return true;
                await sleep(250);
            }
            return false;
        };
        const click = (sel) => h.ev(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
        const rowSel = (path) => `[data-changed-file-row=${JSON.stringify(path)}]`;
        const status = (path) => h.ev(`${q(rowSel(path))}?.querySelector("span")?.textContent ?? null`);
        const openCommit = (subject) =>
            h.ev(`(() => { const b = [...document.querySelectorAll("[data-history-row] > button")]
                .find((x) => x.textContent.includes(${JSON.stringify(subject)})); if (!b) return false; b.click(); return true; })()`);
        const pane = () => h.ev(`${q("[data-diff-pane]")}?.textContent ?? ""`);
        // inserted lines Monaco draws in the right side: a rename read as wholly added would mark all ten
        const inserted = () => h.ev(`document.querySelectorAll("[data-diff-pane] .editor.modified .view-overlays .line-insert").length`);
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            await click("[data-files-source-picker]");
            const option = `[data-files-source-option=${JSON.stringify(ctx.name)}]`;
            await until(`!!${q(option)}`, 4000);
            await click(option);
            const listed = await until(`[...document.querySelectorAll("[data-history-row]")].some((r) => r.textContent.includes("pure rename"))`, 15000);

            const pure = listed && (await openCommit("pure rename"));
            const pureRow = pure && (await until(`!!${q(rowSel("moved.txt"))}`, 8000));
            if (pureRow) await click(rowSel("moved.txt"));
            const unchanged = await until(`(${q("[data-diff-pane]")}?.textContent ?? "").includes("Contents unchanged")`, 8000);
            const pureStatus = await status("moved.txt");
            rec(
                "1. a pure rename lists as R and the pane reads Contents unchanged",
                pureRow && pureStatus === "R" && unchanged,
                JSON.stringify({ listed, pureRow, status: pureStatus, pane: (await pane()).slice(0, 160) })
            );
            await h.shot("cdp-shots/diff-rename-pure.png");

            const edited = await openCommit("rename and edit");
            const editRow = edited && (await until(`!!${q(rowSel("b2.txt"))}`, 8000));
            if (editRow) await click(rowSel("b2.txt"));
            const drawn = await until(`document.querySelectorAll("[data-diff-pane] .editor.modified .view-overlays .line-insert").length > 0`, 8000);
            await sleep(500);
            const insertedLines = await inserted();
            const editStatus = await status("b2.txt");
            rec(
                "2. a rename with one edited line lists as R and the pane marks that one line, not the whole file",
                editRow && editStatus === "R" && drawn && insertedLines === 1,
                JSON.stringify({ editRow, status: editStatus, insertedLines })
            );
            await h.shot("cdp-shots/diff-rename-edited.png");
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        try {
            await h.rpc("deleteproject", { name: ctx.name });
        } catch {
            /* leave a stale registry entry rather than failing teardown */
        }
        try {
            rmSync(ctx.dir, { recursive: true, force: true });
        } catch {
            /* a leftover temp repo is cheaper than a failed teardown */
        }
    },
};

export const diffComments = {
    name: "diff-comments",
    surface: "files",
    async arrange(h) {
        const dir = seedRetryRepo("verify-diff-comments-");
        const name = "verify-diff-comments";
        await h.rpc("createproject", { name, path: dir });
        // the comment store reads localStorage once, at module load, so the key is cleared before the reload that
        // gives this scenario fresh module state; teardown puts back whatever the user had
        const prevComments = await h.ev(`localStorage.getItem(${JSON.stringify(COMMENT_STORAGE_KEY)})`);
        await h.ev(`localStorage.removeItem(${JSON.stringify(COMMENT_STORAGE_KEY)})`);
        await reloadApp(h);
        return { dir, name, prevComments };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
        const rowSel = (path) => `[data-changed-file-row=${JSON.stringify(path)}]`;
        const POLICY = "src/retry/policy.go";
        const LEGACY = "src/retry/legacy.go";
        const DRAFT = "[data-diff-comment-draft]";
        const TEXTAREA = `${DRAFT} textarea`;
        const until = async (expr, ms = 8000) => {
            for (let waited = 0; waited < ms; waited += 250) {
                if (await h.ev(expr).catch(() => false)) return true;
                await sleep(250);
            }
            return false;
        };
        const click = (sel) => h.ev(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
        const pin = (width = 1600) =>
            h.cdp("Emulation.setDeviceMetricsOverride", { width, height: 950, deviceScaleFactor: 1, mobile: false });
        const lineBox = async (side, n) =>
            JSON.parse(await h.ev(`(() => { ${DIFF_LINE_LIB} return JSON.stringify(lineBox(${JSON.stringify(side)}, ${n})); })()`));
        const rectOf = async (sel) =>
            JSON.parse(
                await h.ev(`(() => { const el = ${q(sel)}; if (!el) return "null";
                  const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, mid: r.top + r.height / 2 }); })()`)
            );
        const cards = async () =>
            JSON.parse(
                await h.ev(`JSON.stringify([...document.querySelectorAll('[data-diff-comment-card]')].map((c) => ({
                    id: c.dataset.diffCommentCard,
                    state: c.dataset.commentState,
                    label: c.querySelector('[data-diff-comment-label]')?.textContent ?? "",
                    note: c.querySelector('[data-diff-comment-note]')?.textContent ?? "",
                    top: c.getBoundingClientRect().top,
                    original: !!c.closest('.editor.original'),
                })))`)
            );
        const draftTitle = () => h.ev(`${q(`${DRAFT} label`)}?.textContent ?? ""`);
        // the first card's top sits just below line n's bottom: the zone hangs under the line, after its padding
        const cardUnder = (side, n) => `(() => { ${DIFF_LINE_LIB}
            const l = lineBox(${JSON.stringify(side)}, ${n});
            const c = ${q("[data-diff-comment-card]")};
            if (!l || !c) return false;
            const gap = c.getBoundingClientRect().top - l.bottom;
            return gap >= -1 && gap < 20; })()`;
        const titleIs = (t) => `${q(`${DRAFT} label`)}?.textContent === ${JSON.stringify(t)}`;
        const mouse = (type, x, y, extra = {}) => h.cdp("Input.dispatchMouseEvent", { type, x, y, ...extra });
        const hover = (x, y) => mouse("mouseMoved", x, y);
        const clickAt = async (x, y) => {
            await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
            await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
        };
        const drag = async (from, to) => {
            await mouse("mousePressed", from.x, from.y, { button: "left", buttons: 1, clickCount: 1 });
            await mouse("mouseMoved", (from.x + to.x) / 2, (from.y + to.y) / 2, { button: "left", buttons: 1 });
            await mouse("mouseMoved", to.x, to.y, { button: "left", buttons: 1 });
            await mouse("mouseReleased", to.x, to.y, { button: "left", clickCount: 1 });
        };
        const key = async (k, code, vk, modifiers = 0, text) => {
            await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, text });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
        };
        const ctrlEnter = () => key("Enter", "Enter", 13, CTRL);
        // a selection over lines from..to of one side, from the start of the first to past the end of the last
        // after a view switch the diff editor re-aligns the two sides over a few frames, and a drag measured
        // mid-way starts on the wrong line: wait for two reads of the line to agree
        const settledLineBox = async (side, n) => {
            let last = null;
            for (let waited = 0; waited < 3000; waited += 250) {
                const now = await lineBox(side, n);
                if (now != null && JSON.stringify(now) === JSON.stringify(last)) return now;
                last = now;
                await sleep(250);
            }
            return last;
        };
        const selectLines = async (side, from, to) => {
            const a = await settledLineBox(side, from);
            const b = await lineBox(side, to);
            if (a == null || b == null) return false;
            await drag({ x: a.textLeft + 2, y: a.mid }, { x: b.textLeft + 300, y: b.mid });
            return h.ev(`!!document.activeElement?.closest('[data-diff-pane] .editor.${side}')`);
        };
        // The first move onto a freshly opened pair can reach Monaco without an onMouseMove the layer sees, and
        // the line can shift a row while the diff settles; a user's pointer keeps moving, so this re-measures and
        // moves a few pixels on until the + shows (steps 9a and 11 failed on a single hover).
        const plusOn = async (n) => {
            for (let attempt = 0; attempt < PLUS_HOVER_TRIES; attempt++) {
                const l = await lineBox("modified", n);
                if (l == null) return null;
                await hover(l.textLeft + 40 + attempt * 3, l.mid);
                if (await until(`!!${q("[data-diff-comment-plus]")}`, 1500)) {
                    return { plus: await rectOf("[data-diff-comment-plus]"), line: l };
                }
            }
            return null;
        };
        const pick = async () => {
            await click("[data-files-source-picker]");
            const option = `[data-files-source-option=${JSON.stringify(ctx.name)}]`;
            await until(`!!${q(option)}`, 4000);
            await click(option);
            return until(`!!${q(rowSel(POLICY))}`, 15000);
        };
        const openFile = async (path) => {
            await click(rowSel(path));
            return until(
                `${q(rowSel(path))}?.getAttribute("aria-current") === "true" && (() => { ${DIFF_LINE_LIB} return !!lineBox("modified", 1); })()`,
                10000
            );
        };

        const BAR = "[data-comment-send-bar]";
        const bar = async () =>
            JSON.parse(
                await h.ev(`(() => { const b = ${q(BAR)}; if (!b) return "null";
                    const t = (s) => b.querySelector(s)?.textContent ?? null;
                    const send = b.querySelector("[data-comment-send]");
                    return JSON.stringify({ kind: b.dataset.recipientKind, text: b.textContent, count: t("[data-comment-count]"),
                        recipient: t("[data-comment-recipient]"), detail: t("[data-comment-detail]"), hint: t("[data-comment-hint]"),
                        sent: t("[data-comment-sent-note]"), error: t("[data-comment-error]"),
                        send: send?.textContent ?? null, sendDisabled: send?.disabled ?? null }); })()`)
            );
        const badge = (path) =>
            h.ev(`(() => { const b = ${q(`${rowSel(path)} [data-changed-file-comments]`)}; return b ? b.title : null; })()`);
        const comment = async (note) => {
            await h.cdp("Input.insertText", { text: note });
            await ctrlEnter();
            return until(`!${q(DRAFT)}`, 3000);
        };
        const commentOnLine = async (n, note) => {
            const at = await plusOn(n);
            if (at == null) return false;
            await clickAt(at.plus.x, at.plus.mid);
            return (await until(titleIs(`Comment on line ${n}`), 3000)) && comment(note);
        };
        const commentOnRange = async (side, from, to, title, note) => {
            if (!(await selectLines(side, from, to))) return false;
            await key("m", "KeyM", 77, 0, "m");
            return (await until(titleIs(title), 3000)) && comment(note);
        };
        const toggleSplit = async () => {
            await h.ev("document.activeElement?.blur?.()");
            await key("D", "KeyD", 68, SHIFT, "D");
        };

        try {
            await pin();
            await sleep(400);
            const picked = await pick();
            const opened = await openFile(POLICY);
            // step 7's state, read before the first comment and recorded in order after step 6
            const hintedBar = (await until(`!!${q("[data-comment-hint]")}`, 5000)) ? await bar() : null;
            await h.shot("cdp-shots/diff-comments-hint.png");
            const hovered = await plusOn(3);
            const onLine3 = hovered != null && Math.abs(hovered.plus.mid - hovered.line.mid) < 4;
            await h.shot("cdp-shots/diff-comments-plus.png");
            if (hovered != null) await clickAt(hovered.plus.x, hovered.plus.mid);
            const drafted = await until(titleIs("Comment on line 3"), 3000);
            await h.shot("cdp-shots/diff-comments-draft-line3.png");
            await key("Escape", "Escape", 27);
            const cancelled = await until(`!${q(DRAFT)}`, 3000);
            rec(
                "1. hovering line 3 of src/retry/policy.go shows the +; clicking it opens a draft titled Comment on line 3, and Esc cancels it",
                picked && opened && onLine3 && drafted && cancelled,
                `picked=${picked} opened=${opened} plus=${JSON.stringify(hovered)} drafted=${drafted} cancelled=${cancelled}`
            );

            const selected = await selectLines("modified", 7, 9);
            await key("m", "KeyM", 77, 0, "m");
            const ranged = await until(titleIs("Comment on lines 7–9"), 3000);
            rec(
                "2. selecting lines 7-9 and pressing m in the editor opens a draft titled Comment on lines 7–9",
                selected && ranged,
                `focusInEditor=${selected} title="${await draftTitle()}"`
            );
            await h.shot("cdp-shots/diff-comments-composer.png");

            const NOTE = "A floor of 1 means a zero budget can never be configured. Return 0 here and let Budget enforce the minimu";
            const focused = await h.ev(`document.activeElement === ${q(TEXTAREA)}`);
            await h.cdp("Input.insertText", { text: NOTE });
            await key("m", "KeyM", 77, 0, "m");
            await sleep(300);
            const typed = await h.ev(`${q(TEXTAREA)}?.value ?? ""`);
            const oneDraft = await h.ev(`document.querySelectorAll(${JSON.stringify(DRAFT)}).length === 1 && ${titleIs("Comment on lines 7–9")}`);
            await ctrlEnter();
            const added = await until(`!${q(DRAFT)} && document.querySelectorAll('[data-diff-comment-card][data-comment-state="pending"]').length === 1`);
            const under9 = await until(cardUnder("modified", 9), 3000);
            const [first] = await cards();
            const line9 = await lineBox("modified", 9);
            const handedBack = await h.ev(`document.activeElement === document.body`);
            rec(
                "3. a note typed with an m keeps every character, and Ctrl+Enter adds a pending card under line 9",
                focused && typed === `${NOTE}m` && oneDraft && added && first?.label === "Lines 7–9" && under9 && handedBack,
                `focused=${focused} typed="${typed}" oneDraft=${oneDraft} card=${JSON.stringify(first)} line9=${JSON.stringify(line9)} focusOnBody=${handedBack}`
            );
            await h.shot("cdp-shots/diff-comments-pending.png");

            const EDITED = "Return 0 here and let Budget enforce the minimum.";
            await click(`[data-diff-comment-card=${JSON.stringify(first?.id ?? "")}] [data-diff-comment-edit]`);
            const editing = await until(`document.activeElement === ${q(TEXTAREA)}`, 3000);
            await h.ev(`${q(TEXTAREA)}?.select()`);
            await h.cdp("Input.insertText", { text: EDITED });
            await ctrlEnter();
            const edited = await until(`!${q(DRAFT)} && ${q("[data-diff-comment-note]")}?.textContent === ${JSON.stringify(EDITED)}`);
            const afterEdit = await cards();
            await h.shot("cdp-shots/diff-comments-edited.png");
            const again = await plusOn(3);
            if (again != null) await clickAt(again.plus.x, again.plus.mid);
            await until(titleIs("Comment on line 3"), 3000);
            await h.cdp("Input.insertText", { text: "drop me" });
            await ctrlEnter();
            await until(`document.querySelectorAll('[data-diff-comment-card]').length === 2`, 3000);
            const extra = (await cards()).find((c) => c.label === "Line 3");
            await click(`[data-diff-comment-card=${JSON.stringify(extra?.id ?? "")}] [data-diff-comment-delete]`);
            const deleted = await until(
                `document.querySelectorAll('[data-diff-comment-card]').length === 1 && !!${q(`[data-diff-comment-card=${JSON.stringify(first?.id ?? "")}]`)}`,
                3000
            );
            rec(
                "4. edit changes the note and keeps the comment; delete removes the card",
                editing && edited && afterEdit.length === 1 && afterEdit[0].id === first?.id && extra != null && deleted,
                `editing=${editing} cards=${JSON.stringify(afterEdit)} extra=${extra?.id} deleted=${deleted}`
            );
            await h.shot("cdp-shots/diff-comments-deleted.png");

            const legacy = await openFile(LEGACY);
            const hinted = await until(`!!${q("[data-diff-split-hint]")}`, 5000);
            const hintText = await h.ev(`${q("[data-diff-split-hint]")}?.textContent ?? ""`);
            await h.shot("cdp-shots/diff-comments-split-hint.png");
            // split needs a pane of SPLIT_MIN_PX (diffoptions.ts), which 1600px with history open does not leave
            await pin(2000);
            await sleep(500);
            await h.ev("document.activeElement?.blur?.()");
            await key("D", "KeyD", 68, SHIFT, "D");
            const split = await until(`(() => { ${DIFF_LINE_LIB} return !!lineBox("original", 3); })()`, 5000);
            const leftSelected = await selectLines("original", 1, 3);
            await key("m", "KeyM", 77, 0, "m");
            const leftTitled = await until(titleIs("Comment on removed lines 1–3"), 3000);
            const leftTitle = await draftTitle();
            await h.cdp("Input.insertText", { text: "Legacy() may still have callers outside this package; say where they went." });
            await ctrlEnter();
            const leftAdded = await until(`!${q(DRAFT)} && ${cardUnder("original", 3)}`, 3000);
            const removed = (await cards()).find((c) => c.label === "Removed lines 1–3");
            rec(
                "5. unified view hints at split on the deleted legacy.go; after Shift+D its left side takes a comment reading Removed lines 1–3",
                legacy && hinted && split && leftSelected && leftTitled && leftAdded && removed?.original === true,
                `hint="${hintText}" split=${split} focusInLeft=${leftSelected} title="${leftTitle}" underLine3=${leftAdded} card=${JSON.stringify(removed)}`
            );
            await h.shot("cdp-shots/diff-comments-removed.png");
            await h.ev("document.activeElement?.blur?.()");
            await key("D", "KeyD", 68, SHIFT, "D");
            await pin();

            await openFile(POLICY);
            const before = (await cards()).map((c) => c.label);
            writeFileSync(
                join(ctx.dir, "src", "retry", "policy.go"),
                "package retry\n// retries are per job\n// budgets are per tenant\n\nfunc Budget() int {\n    return 8\n}\n\nfunc Floor() int {\n    return 1\n}\n"
            );
            // no refresh key: the working-tree poll reloads the open pair by itself
            const moved = await until(`${q("[data-diff-comment-label]")}?.textContent === "Lines 9–11"`, 20000);
            const under11 = await until(cardUnder("modified", 11), 3000);
            const [after] = await cards();
            const line11 = await lineBox("modified", 11);
            rec(
                "6. two lines added above the commented range move its card down with them on the next poll",
                before.length === 1 && before[0] === "Lines 7–9" && moved && under11,
                `before=${JSON.stringify(before)} after=${JSON.stringify(after)} line11=${JSON.stringify(line11)}`
            );
            await h.shot("cdp-shots/diff-comments-refound.png");

            const hintWant = `Press m or click a line's + to comment for ${ctx.name}`;
            rec(
                `7. before any comment the bar is the hint "${hintWant}"`,
                hintedBar?.kind === "none" && hintedBar?.hint === hintWant,
                JSON.stringify(hintedBar)
            );

            // step 6's edit left the Budget return on line 6
            const third = await commentOnLine(6, DC_NOTE_RETURN);
            const badges = { policy: await badge(POLICY), legacy: await badge(LEGACY) };
            const projectBar = await bar();
            // the bar names the project's folder, which is the temp repo's
            const folder = basename(ctx.dir);
            rec(
                `8. with comments on two files the list badges them and the bar reads 3 comments in 2 files · to a new agent in ${folder}`,
                third &&
                    badges.policy === "2 pending comments" &&
                    badges.legacy === "1 pending comment" &&
                    projectBar?.kind === "new" &&
                    projectBar.count === "3 comments" &&
                    projectBar.text.includes("in 2 files · to") &&
                    projectBar.recipient === "a new agent" &&
                    projectBar.detail === `in ${folder}` &&
                    projectBar.send === "Start agent with 3 comments⇧↵",
                JSON.stringify({ third, badges, bar: projectBar })
            );
            await h.shot("cdp-shots/diff-comments-badges.png");

            // a shell tab made a roster agent by the status report `wsh agentstatus` sends, its block's cwd the
            // temp repo; the shell is never shown, so it never starts there
            writeFileSync(join(ctx.dir, "src", "retry", "policy.go"), DC_POLICY_BOARD);
            await openCanvasTerminal(h, ctx, DC_AGENT_TOPIC);
            await h.rpc("setmeta", { oref: `block:${ctx.blockId}`, meta: { "cmd:cwd": ctx.dir } });
            const reportAgent = (state) =>
                h.rpc("eventpublish", {
                    event: "agent:status",
                    scopes: [`block:${ctx.blockId}`],
                    persist: 1,
                    data: { oref: `block:${ctx.blockId}`, state, agent: "claude", cwd: ctx.dir, ts: Date.now() },
                });
            await reportAgent("working");
            await click("[data-files-source-picker]");
            const agentRow = `[...document.querySelectorAll("button")].find((b) => !b.dataset.filesSourceOption &&
                (b.querySelector("span.truncate")?.textContent ?? "").startsWith(${JSON.stringify(DC_AGENT_TOPIC)}))`;
            const listed = await until(`!!(${agentRow})`, 10000);
            await h.ev(`${agentRow}?.click()`);
            // the source opens on the uncommitted row (diff-source-row), whose list has README.md and legacy.go
            const agentOpened =
                (await until(`!!${q(rowSel("README.md"))} && !!${q(rowSel(LEGACY))}`, 15000)) && (await openFile(POLICY));
            const name = await h.ev(`${q("[data-files-source-picker] span.truncate")}?.textContent ?? ""`);
            const onAgent = [
                await commentOnLine(4, DC_NOTE_RETURN),
                await commentOnRange("modified", 7, 9, "Comment on lines 7–9", DC_NOTE_FLOOR),
            ];
            await openFile(LEGACY);
            // split needs a pane of SPLIT_MIN_PX, as in step 5
            await pin(2000);
            await sleep(500);
            await toggleSplit();
            await until(`(() => { ${DIFF_LINE_LIB} return !!lineBox("original", 3); })()`, 5000);
            onAgent.push(await commentOnRange("original", 1, 3, "Comment on removed lines 1–3", DC_NOTE_LEGACY));
            await until(`${q("[data-comment-detail]")}?.textContent === "working, joins its turn"`, 5000);
            const working = await bar();
            // the pair label is the arranged repo's: the anchor the worktree pair was loaded against
            ctx.agentAnchor = await h.ev(`(() => {
                const store = JSON.parse(localStorage.getItem(${JSON.stringify(COMMENT_STORAGE_KEY)}) || "{}");
                const key = Object.keys(store).find((k) => k.includes(${JSON.stringify(ctx.tabId)}));
                return key ? store[key].comments[0]?.refs?.original?.ref ?? null : null; })()`);
            rec(
                `9a. on a live agent working, the bar reads 3 comments in 2 files · to ${name}, working, joins its turn`,
                listed &&
                    agentOpened &&
                    onAgent.every(Boolean) &&
                    working?.kind === "live" &&
                    working.count === "3 comments" &&
                    working.text.includes("in 2 files · to") &&
                    working.recipient === name &&
                    working.detail === "working, joins its turn" &&
                    working.send === "Send 3 comments⇧↵",
                JSON.stringify({ listed, agentOpened, name, onAgent, bar: working })
            );
            await h.shot("cdp-shots/diff-comments-live-working.png");

            await reportAgent("idle");
            const idleShown = await until(`${q("[data-comment-detail]")}?.textContent === "at its prompt"`, 8000);
            rec("9b. with the agent idle the detail reads at its prompt", idleShown, JSON.stringify(await bar()));
            await h.shot("cdp-shots/diff-comments-live-idle.png");

            // the page's own agentprompt calls: refused once, then recorded and resolved, never forwarded, so
            // nothing is typed into the shell
            await h.ev(`(() => {
                const c = window.TabRpcClient;
                if (!c.__dcOrig) {
                    c.__dcOrig = c.wshRpcCall;
                    const call = c.wshRpcCall.bind(c);
                    c.wshRpcCall = (command, data, opts) => {
                        if (command !== "agentprompt") return call(command, data, opts);
                        window.__dcPrompts.push(data);
                        if (window.__dcRefuse) {
                            window.__dcRefuse = false;
                            return Promise.reject(new Error("verify refused the prompt"));
                        }
                        return Promise.resolve(null);
                    };
                }
                window.__dcPrompts = [];
                window.__dcRefuse = true;
            })()`);
            await click("[data-comment-send]");
            const errored = await until(`!!${q("[data-comment-error]")}`, 5000);
            const failed = await bar();
            const kept = await h.ev(`document.querySelectorAll("[data-diff-comment-card]").length`);
            rec(
                `9c. a refused send shows Couldn't send to ${name}: … with Send again, and the cards and count stay`,
                errored &&
                    (failed?.error ?? "").startsWith(`Couldn't send to ${name}: `) &&
                    failed.send === "Send again⇧↵" &&
                    failed.count === "3 comments" &&
                    kept === 1,
                JSON.stringify({ bar: failed, cardsOnLegacy: kept })
            );
            await h.shot("cdp-shots/diff-comments-send-failed.png");

            await h.ev("window.__dcPrompts = []; document.activeElement?.blur?.()");
            await key("Enter", "Enter", 13, SHIFT, "\r");
            await key("Enter", "Enter", 13, SHIFT, "\r");
            const sentShown = await until(`!!${q("[data-comment-sent-note]")}`, 5000);
            await sleep(300);
            const prompts = JSON.parse(await h.ev(`JSON.stringify(window.__dcPrompts)`));
            const stored = JSON.parse(await h.ev(`localStorage.getItem(${JSON.stringify(COMMENT_STORAGE_KEY)}) || "{}"`));
            const anchor = ctx.agentAnchor;
            const short = /^[0-9a-f]{40}$/.test(anchor ?? "") ? anchor.slice(0, 7) : anchor;
            const want = [
                `Review comments on your changes (worktree against ${short}), 3 comments:`,
                "",
                "  src/retry/policy.go:4",
                "  >     return 8",
                `  ${DC_NOTE_RETURN}`,
                "",
                "  src/retry/policy.go:7-9",
                "  > func Floor() int {",
                `  ${DC_NOTE_FLOOR}`,
                "",
                `  src/retry/legacy.go: removed lines 1-3 of ${short}`,
                "  > package retry",
                `  ${DC_NOTE_LEGACY}`,
                "",
                "  Line numbers are the file as shown in the diff. Address each comment, then say which you changed.",
            ].join("\n");
            const text = prompts[0]?.text ?? "";
            mkdirSync("cdp-shots", { recursive: true });
            writeFileSync("cdp-shots/diff-comments-prompt.txt", text);
            const sentBar = await bar();
            const left = await h.ev(`document.querySelectorAll("[data-diff-comment-card]").length`);
            rec(
                `9d. Shift+Enter sends exactly one agentprompt with the Prompt board's text, the cards leave and Sent 3 comments to ${name} shows`,
                sentShown &&
                    prompts.length === 1 &&
                    prompts[0].blockid === ctx.blockId &&
                    text === want &&
                    left === 0 &&
                    sentBar?.sent?.startsWith(`Sent 3 comments to ${name}`) &&
                    Object.keys(stored).every((k) => !k.includes(ctx.tabId)),
                JSON.stringify({ prompts: prompts.length, block: prompts[0]?.blockid, matches: text === want, sentBar, cardsLeft: left }) +
                    "\nprompt:\n" +
                    text +
                    (text === want ? "" : "\nwant:\n" + want)
            );
            await h.shot("cdp-shots/diff-comments-sent.png");
            await h.ev(`(() => { const c = window.TabRpcClient; if (c.__dcOrig) { c.wshRpcCall = c.__dcOrig; delete c.__dcOrig; } })()`);

            await toggleSplit();
            await pin();
            await openFile(POLICY);
            const lastOne = await commentOnLine(4, DC_NOTE_RETURN);
            await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false]);
            ctx.tabClosed = true;
            const endedText = `${name} has ended · to`;
            const ended = await until(`(${q(BAR)}?.textContent ?? "").includes(${JSON.stringify(endedText)})`, 15000);
            const endedBar = await bar();
            rec(
                `10. after the agent's tab closes the bar keeps its batch and reads ${name} has ended · to a new agent in ${name}'s folder`,
                lastOne &&
                    ended &&
                    endedBar?.kind === "new" &&
                    endedBar.count === "1 comment" &&
                    endedBar.recipient === "a new agent" &&
                    endedBar.detail === `in ${name}'s folder`,
                JSON.stringify({ lastOne, bar: endedBar })
            );
            await h.shot("cdp-shots/diff-comments-ended.png");

            // the page's own launch, with the claude block's meta recorded and swapped for a shell in ~ before it
            // reaches wavesrv, so no agent starts; the tab it makes is closed in teardown
            await h.ev(`(() => {
                const c = window.TabRpcClient;
                c.__dcOrig = c.wshRpcCall;
                const call = c.wshRpcCall.bind(c);
                window.__dcLaunch = { block: null, tab: null };
                c.wshRpcCall = (command, data, opts) => {
                    if (command === "setmeta" && data?.meta?.cmd === "claude") {
                        window.__dcLaunch.block = data.meta;
                        data = { ...data, meta: { view: "term", controller: "shell", "cmd:cwd": "~" } };
                    } else if (command === "setmeta" && String(data?.oref ?? "").startsWith("tab:") && data?.meta?.["session:agent"]) {
                        window.__dcLaunch.tab = data.oref.slice(4);
                    }
                    return call(command, data, opts);
                };
            })()`);
            await h.ev("document.activeElement?.blur?.()");
            await click("[data-comment-send]");
            const launched = await until(`!!window.__dcLaunch?.tab`, 15000);
            const launch = JSON.parse(await h.ev(`JSON.stringify(window.__dcLaunch)`));
            await h.ev(`(() => { const c = window.TabRpcClient; if (c.__dcOrig) { c.wshRpcCall = c.__dcOrig; delete c.__dcOrig; } })()`);
            ctx.launchedTabId = launch.tab;
            const task = launch.block?.["cmd:args"]?.at(-1) ?? "";
            const norm = (p) => String(p ?? "").replace(/\\/g, "/").toLowerCase();
            // the agent's batch is keyed by its tab; the project's batch from step 8 holds the same note
            const batchGone = Object.keys(
                JSON.parse(await h.ev(`localStorage.getItem(${JSON.stringify(COMMENT_STORAGE_KEY)}) || "{}"`))
            ).every((k) => !k.includes(ctx.tabId));
            rec(
                `10b. Start agent with 1 comment launches claude in ${name}'s folder with the comment as its task, and the batch clears`,
                launched &&
                    launch.block?.cmd === "claude" &&
                    norm(launch.block?.["cmd:cwd"]) === norm(ctx.dir) &&
                    task.startsWith(`Review comments on the changes in ${name} (worktree against `) &&
                    task.includes("  src/retry/policy.go:4\n") &&
                    task.includes(DC_NOTE_RETURN) &&
                    batchGone,
                JSON.stringify({ launched, cmd: launch.block?.cmd, cwd: launch.block?.["cmd:cwd"], tab: launch.tab, batchGone }) +
                    "\ntask:\n" +
                    task
            );

            const runOpened = await openDcRun(h, ctx, { until, q, rowSel });
            const runFile = runOpened.ok && (await openFile(POLICY));
            const onRun = runFile && (await commentOnLine(4, DC_NOTE_RETURN));
            const reason = `run ${(ctx.run?.runId ?? "").slice(0, 8)} hasn't landed; send once it does`;
            const waited = await until(`${q("[data-comment-detail]")}?.textContent === ${JSON.stringify(reason)}`, 8000);
            const runBar = await bar();
            rec(
                `11. a run source that has not landed reads ${reason} with Send disabled`,
                waited && runBar?.kind === "wait" && runBar.sendDisabled === true && runBar.count === "1 comment",
                JSON.stringify({ opened: runOpened, runFile, onRun, bar: runBar })
            );
            await h.shot("cdp-shots/diff-comments-run-wait.png");
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev("document.activeElement?.blur?.()");
        await h.ev(`(() => { const c = window.TabRpcClient; if (c?.__dcOrig) { c.wshRpcCall = c.__dcOrig; delete c.__dcOrig; } })()`);
        for (const tabId of [ctx.tabClosed ? null : ctx.tabId, ctx.launchedTabId]) {
            if (!tabId) continue;
            try {
                await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, tabId, false]);
            } catch {
                /* a tab left open is cheaper than a failed teardown */
            }
        }
        await h.ev(restoreLocalStorage(COMMENT_STORAGE_KEY, ctx.prevComments));
        // the store still holds this scenario's batch in memory and would write it back over the restored key
        await reloadApp(h);
        if (ctx.run != null) {
            // a done run cannot be cancelled
            await teardownFixtureRun(h, { ...ctx.run, runId: null }, "diff-comments", null);
        }
        try {
            await h.rpc("deleteproject", { name: ctx.name });
        } catch {
            /* leave a stale registry entry rather than failing teardown */
        }
        try {
            rmSync(ctx.dir, { recursive: true, force: true });
        } catch {
            /* a leftover temp repo is cheaper than a failed teardown */
        }
    },
};

// --- diff surface: review marks on a run's range --------------------------------------------------
// diff-review-marks covers the working tree, a commit and a compare; this one opens the Diff surface the way
// a finished run's sheet does, so the marks land under the run subject (run:<id>:<base>) and survive a reload.
// The run is deferred (no lead) and written done with sealed evidence, which is what draws the sheet's link.
export const diffReviewMarksRun = {
    name: "diff-review-marks-run",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-diff-review-run-"));
        const ctx = { cwd };
        try {
            git(cwd, "init", "-q", "--initial-branch=main");
            mkdirSync(join(cwd, "src", "retry"), { recursive: true });
            writeFileSync(join(cwd, "README.md"), "# retry\n");
            writeFileSync(join(cwd, "src", "retry", "policy.go"), "package retry\n\nfunc Budget() int {\n    return 3\n}\n");
            git(cwd, "add", ".");
            git(cwd, "commit", "-q", "-m", "seed the retry package");

            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-diff-review-marks-run", projectpath: cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: "verify diff-review-marks-run: do nothing, make no file changes, stop immediately",
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            ctx.base = created.run.basecommit;
            if (!ctx.base) throw new Error("createrun recorded no base commit");

            // what the run "landed", after its base, on its own branch tree: that is the tree the run's diff reads
            const tree = created.run.landpath || cwd;
            writeFileSync(join(tree, "src", "retry", "policy.go"), "package retry\n\nfunc Budget() int {\n    return 8\n}\n");
            writeFileSync(join(tree, "src", "retry", "submit.go"), "package retry\n\nfunc Submit(id string) error {\n    return nil\n}\n");
            git(tree, "add", "src");
            git(tree, "commit", "-q", "-m", "raise the budget, add submit");

            const oref = `run:${ctx.runId}`;
            const evidence = {
                capturedts: Date.now(),
                hash: "",
                files: [
                    { path: "src/retry/policy.go", stat: "M", add: 1, del: 1 },
                    { path: "src/retry/submit.go", stat: "A", add: 5, del: 0 },
                ],
                addtotal: 6,
                deltotal: 1,
                runtimems: 0,
                durationms: 0,
            };
            const stored = await waveService(h, "object", "GetObject", [oref]);
            await waveService(
                h,
                "object",
                "UpdateObject",
                [{ ...stored, otype: "run", status: "done", report: "", evidence }, false],
                FINAL_SHOTS_UICTX
            );
            const back = await waveService(h, "object", "GetObject", [oref]);
            if (back?.status !== "done" || back?.evidence == null) {
                throw new Error(`the run did not keep its done state: status=${back?.status}`);
            }
            ctx.runDone = true;

            // the store reads localStorage once, at module load, so the key is cleared before the reload
            ctx.prevMarks = await h.ev(`localStorage.getItem(${JSON.stringify(REVIEW_STORAGE_KEY)})`);
            await h.ev(`localStorage.removeItem(${JSON.stringify(REVIEW_STORAGE_KEY)})`);
            await reloadApp(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. arrange", false, ctx.arrangeError);
            return steps;
        }
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
        const rowSel = (path) => `[data-changed-file-row=${JSON.stringify(path)}]`;
        const until = async (expr, ms = 8000) => {
            for (let waited = 0; waited < ms; waited += 250) {
                if (await h.ev(expr).catch(() => false)) return true;
                await sleep(250);
            }
            return false;
        };
        const click = (sel) => h.ev(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`);
        const progress = () =>
            h.ev(`(() => { const el = ${q("[data-files-reviewed]")}; return el ? el.dataset.done + "/" + el.dataset.total : "absent"; })()`);
        const POLICY = "src/retry/policy.go";
        const SUBMIT = "src/retry/submit.go";
        const subjectSuffix = `|run:${ctx.runId}:${ctx.base}`;
        // opens the run's sheet and follows its "open the repository diff" link onto the Diff surface
        const openRunDiff = async () => {
            await h.goto("jarvis");
            await until(`typeof window.__openAddress === "function"`, 5000);
            await h.ev(`window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)})`);
            const linked = await until(
                `[...document.querySelectorAll("[data-evidence-block] button")].some((b) => /open the repository diff/.test(b.textContent || ""))`,
                10000
            );
            await h.ev(`[...document.querySelectorAll("[data-evidence-block] button")]
                .find((b) => /open the repository diff/.test(b.textContent || ""))?.click()`);
            const listed = await until(`!!${q(rowSel(SUBMIT))} && !!${q(rowSel(POLICY))}`, 15000);
            return { linked, listed };
        };
        const storedSubject = () =>
            h.ev(`(() => {
                const store = JSON.parse(localStorage.getItem(${JSON.stringify(REVIEW_STORAGE_KEY)}) || "{}");
                const key = Object.keys(store).find((k) => k.endsWith(${JSON.stringify(subjectSuffix)}));
                return JSON.stringify({ keys: Object.keys(store), key: key ?? null, files: key ? Object.keys(store[key].files ?? {}) : [] });
            })()`).then((s) => JSON.parse(s));

        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            const first = await openRunDiff();
            const range = await h.ev(`document.body.innerText.includes("This run")`);
            rec(
                "1. the run sheet's link opens the run's range with both files unreviewed",
                first.linked && first.listed && range && (await progress()) === "0/2",
                `linked=${first.linked} listed=${first.listed} thisRun=${range} progress=${await progress()}`
            );
            await h.shot("cdp-shots/diff-review-marks-run-empty.png");

            await click(`[data-review-toggle=${JSON.stringify(POLICY)}]`);
            const marked = await until(`${q(rowSel(POLICY))}?.dataset.reviewState === "ok"`, 3000);
            const subject = await storedSubject();
            rec(
                "2. a mark on the run range is stored under run:<id>:<base>",
                marked && (await progress()) === "1/2" && subject.key != null && subject.files.includes(POLICY),
                JSON.stringify({ marked, progress: await progress(), want: subjectSuffix, ...subject })
            );
            await h.shot("cdp-shots/diff-review-marks-run-marked.png");

            await reloadApp(h);
            const again = await openRunDiff();
            const kept = await until(`${q(rowSel(POLICY))}?.dataset.reviewState === "ok"`, 3000);
            rec(
                "3. after a reload the run range still reads policy.go reviewed, 1/2",
                again.listed && kept && (await progress()) === "1/2",
                `listed=${again.listed} kept=${kept} progress=${await progress()}`
            );
            await h.shot("cdp-shots/diff-review-marks-run-reloaded.png");
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        // a done run cannot be cancelled, so only one that never got that far is
        await teardownFixtureRun(h, ctx.runDone ? { ...ctx, runId: null } : ctx, "diff-review-marks-run", {
            what: "restore the review marks",
            fn: () => h.ev(restoreLocalStorage(REVIEW_STORAGE_KEY, ctx.prevMarks)),
        });
    },
};
