// Diff surface scenario diff-push: Fetch | Push in the toolbar, one step per board of the design, on clones of a
// local bare remote. Fetching and Pushing hold the action in flight by answering gitfetch / gitpush with a promise
// the step settles; every other push and fetch is real git against the bare remote.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, lookEval, lookHover, reloadApp } from "./scenarios-shared.mjs";
import { openOnDiff, removeFixtures, setViewport, sleep, until } from "./scenarios-files-scope.mjs";

// no name holds "diff-remote": diff-scope's step 2 counts the sources that fragment matches
const PUSH = {
    project: "verify-diff-push",
    plain: "verify-diff-push-plain",
    publish: "verify-diff-push-publish",
    detached: "verify-diff-push-detached",
    branch: "main",
    upstream: "origin/main",
    publishBranch: "publish-me",
};
const TOOLTIP_WAIT_MS = 5000;
const ACTION_WAIT_MS = 20000;

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const GROUP = "[data-files-remote]";
const FETCH = "[data-files-fetch]";
const PUSH_BTN = "[data-files-push]";
const PUSH_DETAIL = "[data-files-push-detail]";
const NOTICE = "[data-git-failure-notice]";
const HEADLINE = "[data-git-failure-notice] [data-git-failure-headline]";
const SUMMARY = "[data-files-range-summary]";
const text = (sel) => `(${q(sel)}?.textContent ?? "").trim()`;
// the shared Tooltip mounts on hover and fades in after its open delay
const TOOLTIP_TEXT = `(() => { const t = ${q("[role=tooltip]")}; return t && getComputedStyle(t).opacity === "1" ? t.textContent.trim() : ""; })()`;

function commitFile(dir, name, body, message) {
    writeFileSync(join(dir, name), body);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", message);
}

// a bare origin, the project's clone two commits ahead of origin/main, a clone that publishes a new branch, a
// detached clone, a helper clone that moves origin on, and a repository with no remote
function seedRepos() {
    const root = mkdtempSync(join(tmpdir(), "verify-diff-push-"));
    const bare = join(root, "origin.git");
    mkdirSync(bare);
    git(bare, "init", "-q", "--bare", `--initial-branch=${PUSH.branch}`);
    const seed = join(root, "seed");
    git(root, "clone", "-q", bare, seed);
    // an empty clone takes the user's init.defaultBranch, which may not be main
    git(seed, "symbolic-ref", "HEAD", `refs/heads/${PUSH.branch}`);
    commitFile(seed, "README.md", "# push\n", "seed the remote");
    git(seed, "push", "-q", "-u", "origin", PUSH.branch);

    const clone = join(root, "clone");
    git(root, "clone", "-q", bare, clone);
    commitFile(clone, "one.txt", "one\n", "first local commit");
    commitFile(clone, "two.txt", "two\n", "second local commit");

    const publish = join(root, "publish");
    git(root, "clone", "-q", bare, publish);
    git(publish, "checkout", "-q", "-b", PUSH.publishBranch);
    commitFile(publish, "publish.txt", "publish\n", "a branch the remote has not seen");

    const detached = join(root, "detached");
    git(root, "clone", "-q", bare, detached);
    git(detached, "checkout", "-q", "--detach");

    const other = join(root, "other");
    git(root, "clone", "-q", bare, other);

    const plain = join(root, "plain");
    mkdirSync(plain);
    git(plain, "init", "-q", `--initial-branch=${PUSH.branch}`);
    commitFile(plain, "x.txt", "x\n", "a repository with no remote");
    return { root, bare, clone, publish, detached, other, plain };
}

// answers one wshrpc command with a promise the step settles through window.__dpSettle; unholdRpc puts the client back
const holdRpc = (h, command) =>
    h.ev(`(() => {
        const c = window.TabRpcClient;
        if (!c.__dpOrig) c.__dpOrig = c.wshRpcCall;
        const call = c.__dpOrig.bind(c);
        c.wshRpcCall = (cmd, data, opts) =>
            cmd === ${JSON.stringify(command)} ? new Promise((r) => { window.__dpSettle = r; }) : call(cmd, data, opts);
    })()`);
const unholdRpc = (h) =>
    h.ev(`(() => { const c = window.TabRpcClient; if (c?.__dpOrig) { c.wshRpcCall = c.__dpOrig; delete c.__dpOrig; } })()`);
const settleHeld = (h, answer) => h.ev(`window.__dpSettle?.(${JSON.stringify(answer)})`);

const filesCwd = (h) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { filesStateAtom } = await mod("app/view/agents/filesstore.ts");
        return globalStore.get(filesStateAtom)?.cwd ?? null;
    `);

// the surface on a project whose change list has landed, so its remote facts are in
async function openProject(h, name, dir) {
    if (!(await openOnDiff(h, name))) return false;
    for (let waited = 0; waited < 15000; waited += 250) {
        const cwd = await filesCwd(h);
        if (cwd && cwd.replace(/\\/g, "/").toLowerCase() === dir.replace(/\\/g, "/").toLowerCase()) return true;
        await sleep(250);
    }
    return false;
}

// the change list re-read now rather than on the next poll tick, after git moved under the surface
const rereadChanges = (h) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { filesStateAtom, reloadChanges } = await mod("app/view/agents/filesstore.ts");
        await reloadChanges(globalStore.get(filesStateAtom)?.cwd ?? null);
        return true;
    `);

async function pickRange(h, kind) {
    await h.ev(`${q(`[data-range-chip="${kind}"]`)}?.click()`);
    return until(h, `${q(`[data-range-chip="${kind}"]`)}?.getAttribute("aria-pressed") === "true"`, 10000);
}

// a real pointer over the Push wrapper's centre, then the tooltip once its open delay has passed
async function hoverPush(h) {
    const at = await h.ev(`(() => {
        const r = ${q(PUSH_BTN)}?.parentElement?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`);
    if (!at) return "";
    await lookHover(h, at.x, at.y);
    await until(h, `${TOOLTIP_TEXT} !== ""`, TOOLTIP_WAIT_MS);
    return h.ev(TOOLTIP_TEXT);
}

async function unhover(h) {
    await lookHover(h, 1, 1);
    await until(h, `!${q("[role=tooltip]")}`, TOOLTIP_WAIT_MS);
}

// the colour a token draws as, read through a probe so a runtime theme cannot make the check stale
const tokenColor = (h, token) =>
    h.ev(`(() => {
        const p = document.createElement("span");
        p.style.color = "var(${token})";
        document.body.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
    })()`);

const pushSpinning = `!!${q(`${PUSH_BTN} svg.animate-spin`)}`;
const fetchSpinning = `!!${q(`${FETCH} svg.animate-spin`)}`;
const disabled = (sel) => `${q(sel)}?.disabled === true`;

async function compareSteps(h, ctx, rec) {
    // 1. Main
    const opened = await openProject(h, PUSH.project, ctx.clone);
    const comparing = opened && (await pickRange(h, "compare"));
    const grouped = comparing && (await until(h, `!!${q(`${GROUP} ${FETCH}`)} && !!${q(`${GROUP} ${PUSH_BTN}`)}`, 10000));
    const ahead = grouped && (await until(h, `${text(PUSH_DETAIL)} === "↑2"`, 10000));
    // the summary waits for the comparison's merge base
    await until(h, `${text(SUMMARY)}.startsWith("since ")`, 10000);
    const layout = await h.ev(`(() => {
        const s = ${q(SUMMARY)}?.getBoundingClientRect();
        const d = ${q("[data-files-remote-divider]")}?.getBoundingClientRect();
        const g = ${q(GROUP)}?.getBoundingClientRect();
        return s && d && g ? { summaryRight: s.right, dividerLeft: d.left, dividerRight: d.right, groupLeft: g.left, dividerWidth: d.width, role: ${q(GROUP)}.getAttribute("role"), label: ${q(GROUP)}.getAttribute("aria-label") } : null;
    })()`);
    const summary = await h.ev(text(SUMMARY));
    await h.shot("cdp-shots/diff-push-main.png");
    rec(
        "1. Main: in compare Fetch and Push ↑2 are one Remote group right of the summary and a 1px divider; the summary names no branch",
        comparing &&
            grouped &&
            ahead &&
            layout != null &&
            layout.role === "group" &&
            layout.label === "Remote" &&
            Math.round(layout.dividerWidth) === 1 &&
            layout.summaryRight <= layout.dividerLeft &&
            layout.dividerRight <= layout.groupLeft &&
            summary.startsWith("since ") &&
            !summary.includes(PUSH.branch),
        JSON.stringify({ opened, comparing, grouped, ahead, layout, summary, detail: await h.ev(text(PUSH_DETAIL)) })
    );

    // 2. Fetching
    let fetching = {};
    try {
        await holdRpc(h, "gitfetch");
        await h.ev(`${q(FETCH)}.click()`);
        const spinning = await until(h, fetchSpinning, 5000);
        fetching = { spinning, label: await h.ev(text(FETCH)), pushHeld: await h.ev(disabled(PUSH_BTN)) };
        await h.shot("cdp-shots/diff-push-fetching.png");
        await settleHeld(h, { isrepo: true, fetchedat: 0 });
        fetching.settled = await until(h, `!(${fetchSpinning}) && !(${disabled(PUSH_BTN)})`, 10000);
    } finally {
        await unholdRpc(h);
    }
    rec(
        "2. Fetching: a running fetch spins and reads Fetching…, and Push is disabled until it ends",
        fetching.spinning && fetching.label.startsWith("Fetching…") && fetching.pushHeld && fetching.settled,
        JSON.stringify(fetching)
    );

    // 3. Fetched
    await h.ev(`${q(FETCH)}.click()`);
    const clockSel = `${FETCH} [data-files-fetched]`;
    const fetched = await until(h, `${text(clockSel)} === "just now"`, ACTION_WAIT_MS);
    await h.shot("cdp-shots/diff-push-fetched.png");
    rec(
        "3. Fetched: a real fetch leaves \"just now\" inside the Fetch button",
        fetched,
        JSON.stringify({ fetch: await h.ev(text(FETCH)), clock: await h.ev(text(clockSel)) })
    );

    // 4. FetchFailed: origin pointed at a path that is no repository, so git itself refuses
    git(ctx.clone, "remote", "set-url", "origin", join(ctx.root, "missing.git"));
    let failed = {};
    try {
        await h.ev(`${q(FETCH)}.click()`);
        const shown = await until(h, `!!${q(NOTICE)}`, ACTION_WAIT_MS);
        failed = {
            shown,
            notice: await h.ev(text(NOTICE)),
            headline: await h.ev(text(HEADLINE)),
            alert: await h.ev(`!!${q(`${FETCH} svg.text-error`)}`),
        };
        await h.shot("cdp-shots/diff-push-fetch-failed.png");
    } finally {
        git(ctx.clone, "remote", "set-url", "origin", ctx.bare);
    }
    rec(
        "4. FetchFailed: the notice reads Fetch failed with git's own headline, and Fetch shows the alert",
        failed.shown && failed.notice.includes("Fetch failed") && failed.headline.startsWith("fatal:") && failed.alert,
        JSON.stringify(failed)
    );
    await h.ev(`${q(`${NOTICE} [aria-label="Dismiss"]`)}?.click()`);
    await until(h, `!${q(NOTICE)}`, 5000);

    // 5. Pushing
    let pushing = {};
    try {
        await holdRpc(h, "gitpush");
        await h.ev(`${q(PUSH_BTN)}.click()`);
        const spinning = await until(h, pushSpinning, 5000);
        pushing = { spinning, label: await h.ev(text(PUSH_BTN)), fetchHeld: await h.ev(disabled(FETCH)) };
        await h.shot("cdp-shots/diff-push-pushing.png");
        // nothing was pushed: no time, no failure, the counts as they were
        await settleHeld(h, { isrepo: true, pushedat: 0 });
        pushing.settled = await until(h, `!(${pushSpinning}) && !(${disabled(FETCH)})`, 10000);
        pushing.detail = await h.ev(text(PUSH_DETAIL));
    } finally {
        await unholdRpc(h);
    }
    rec(
        "5. Pushing: a running push spins and reads Pushing…, and Fetch is disabled until it ends",
        pushing.spinning && pushing.label.startsWith("Pushing…") && pushing.fetchHeld && pushing.settled,
        JSON.stringify(pushing)
    );
    await pickRange(h, "working");

    // 6. NoRemote
    const plainOpen = await openProject(h, PUSH.plain, ctx.plain);
    const plainCompare = plainOpen && (await pickRange(h, "compare"));
    const column = plainCompare && (await until(h, `!!${q("[data-compare-column]")}`, 10000));
    // the change list's answer is in once the project's cwd is; give the group a beat to not appear
    await sleep(1000);
    const noRemote = { group: await h.ev(`!!${q(GROUP)}`), divider: await h.ev(`!!${q("[data-files-remote-divider]")}`) };
    await h.shot("cdp-shots/diff-push-no-remote.png");
    rec(
        "6. NoRemote: comparing in a repository with no remote draws no Remote group and no divider",
        plainCompare && column && !noRemote.group && !noRemote.divider,
        JSON.stringify({ plainOpen, plainCompare, column, ...noRemote })
    );
    await pickRange(h, "working");
}

async function workingSteps(h, ctx, rec) {
    // 7. WorkingTree
    const opened = await openProject(h, PUSH.project, ctx.clone);
    const ahead = opened && (await until(h, `${text(PUSH_DETAIL)} === "↑2"`, 10000));
    const noFetch = !(await h.ev(`!!${q(FETCH)}`));
    const tip = await hoverPush(h);
    await h.shot("cdp-shots/diff-push-working-tree.png");
    await unhover(h);
    rec(
        "7. WorkingTree: on the working range Push reads ↑2 with no Fetch, and hovering it shows the reason tooltip",
        ahead && noFetch && tip === `Push 2 commits to ${PUSH.upstream}`,
        JSON.stringify({ opened, ahead, noFetch, tip })
    );

    // 8. Pushed
    await h.ev(`${q(PUSH_BTN)}.click()`);
    const pushed = await until(h, `${text(PUSH_DETAIL)} === "just now"`, ACTION_WAIT_MS);
    const label = await h.ev(text(PUSH_BTN));
    const remoteTip = git(ctx.bare, "rev-parse", PUSH.branch).toString().trim();
    const localTip = git(ctx.clone, "rev-parse", "HEAD").toString().trim();
    await h.shot("cdp-shots/diff-push-pushed.png");
    rec(
        "8. Pushed: after a real push the ↑ count is gone and the push time sits inside the button",
        pushed && !label.includes("↑") && remoteTip === localTip,
        JSON.stringify({ pushed, label, remoteMoved: remoteTip === localTip })
    );

    // 9. FirstPush
    const pubOpen = await openProject(h, PUSH.publish, ctx.publish);
    const publishShown = pubOpen && (await until(h, `${text(PUSH_BTN)}.startsWith("Publish")`, 10000));
    const pubTip = publishShown ? await hoverPush(h) : "";
    await h.shot("cdp-shots/diff-push-first-push.png");
    await unhover(h);
    if (publishShown) await h.ev(`${q(PUSH_BTN)}.click()`);
    const published =
        publishShown &&
        (await until(h, `${text(PUSH_BTN)}.startsWith("Push") && ${text(PUSH_DETAIL)} === "just now"`, ACTION_WAIT_MS));
    const pubLabel = await h.ev(text(PUSH_BTN));
    let remoteHas = false;
    try {
        git(ctx.bare, "rev-parse", "--verify", PUSH.publishBranch);
        remoteHas = true;
    } catch {
        /* the branch never reached the remote */
    }
    await h.shot("cdp-shots/diff-push-published.png");
    rec(
        "9. FirstPush: a branch with no upstream reads Publish with its reason, and publishing leaves Push with nothing ahead",
        publishShown &&
            pubTip === `Publish ${PUSH.publishBranch} to origin and track it` &&
            published &&
            !pubLabel.includes("↑") &&
            remoteHas,
        JSON.stringify({ pubOpen, publishShown, pubTip, published, pubLabel, remoteHas })
    );

    // 10. PushRejected: the remote gains a commit from a second clone, and the project commits on top of the old tip
    const backOpen = await openProject(h, PUSH.project, ctx.clone);
    git(ctx.other, "pull", "-q");
    commitFile(ctx.other, "other.txt", "other\n", "a commit from another clone");
    git(ctx.other, "push", "-q");
    commitFile(ctx.clone, "three.txt", "three\n", "a third local commit");
    await rereadChanges(h);
    const oneAhead = backOpen && (await until(h, `${text(PUSH_DETAIL)} === "↑1"`, 10000));
    if (oneAhead) await h.ev(`${q(PUSH_BTN)}.click()`);
    const rejected = oneAhead && (await until(h, `!!${q(NOTICE)}`, ACTION_WAIT_MS));
    const notice = await h.ev(text(NOTICE));
    const headline = await h.ev(text(HEADLINE));
    const pushAlert = await h.ev(`!!${q(`${PUSH_BTN} svg.text-error`)}`);
    await h.shot("cdp-shots/diff-push-rejected.png");
    rec(
        "10. PushRejected: the notice reads Push failed with the ! [rejected] headline and the upstream in its note",
        rejected &&
            notice.includes("Push failed") &&
            notice.includes(`${PUSH.upstream} has commits you lack. Fetch, then merge them before pushing.`) &&
            headline.startsWith("! [rejected]") &&
            pushAlert,
        JSON.stringify({ backOpen, oneAhead, rejected, notice, headline, pushAlert })
    );
    await h.ev(`${q(`${NOTICE} [aria-label="Dismiss"]`)}?.click()`);
    await until(h, `!${q(NOTICE)}`, 5000);

    // 11. Diverged: the fixture fetches, so the behind count is current
    git(ctx.clone, "fetch", "-q");
    await rereadChanges(h);
    const diverged = await until(h, `${text(PUSH_DETAIL)} === "↑1 ↓1"`, 10000);
    const detailColor = await h.ev(`getComputedStyle(${q(PUSH_DETAIL)}).color`);
    const warning = await tokenColor(h, "--color-warning");
    const divTip = await hoverPush(h);
    await h.shot("cdp-shots/diff-push-diverged.png");
    await unhover(h);
    rec(
        "11. Diverged: ↑1 ↓1 in the warning colour, and the hovered tooltip says to merge before pushing",
        diverged && detailColor === warning && divTip === `${PUSH.upstream} has 1 commit you lack: merge before pushing`,
        JSON.stringify({ diverged, detail: await h.ev(text(PUSH_DETAIL)), detailColor, warning, divTip })
    );

    // 12. Detached
    const detOpen = await openProject(h, PUSH.detached, ctx.detached);
    const shown = detOpen && (await until(h, `!!${q(PUSH_BTN)}`, 10000));
    const isDisabled = await h.ev(disabled(PUSH_BTN));
    const detLabel = await h.ev(text(PUSH_BTN));
    const detTip = shown ? await hoverPush(h) : "";
    await h.shot("cdp-shots/diff-push-detached.png");
    await unhover(h);
    rec(
        "12. Detached: Push is disabled, and hovering it still shows the detached reason",
        shown && isDisabled && detLabel === "Push" && detTip === "HEAD is detached: check out a branch to push",
        JSON.stringify({ detOpen, shown, isDisabled, detLabel, detTip })
    );
}

export const diffPush = {
    name: "diff-push",
    surface: "files",
    async arrange(h) {
        const repos = seedRepos();
        const names = [PUSH.project, PUSH.plain, PUSH.publish, PUSH.detached];
        await h.rpc("createproject", { name: PUSH.project, path: repos.clone });
        await h.rpc("createproject", { name: PUSH.plain, path: repos.plain });
        await h.rpc("createproject", { name: PUSH.publish, path: repos.publish });
        await h.rpc("createproject", { name: PUSH.detached, path: repos.detached });
        // fresh module state: the Diff surface's scope and the remote states outlive the surface for the page's life
        await reloadApp(h);
        return { ...repos, names, dirs: [repos.root] };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail });
        try {
            await setViewport(h);
            await compareSteps(h, ctx, rec);
            await workingSteps(h, ctx, rec);
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await unholdRpc(h).catch(() => {});
        await removeFixtures(h, ctx.names, ctx.dirs);
        await reloadApp(h);
    },
};
