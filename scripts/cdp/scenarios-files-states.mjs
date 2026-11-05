// Diff surface scenario diff-states: the diff pane's states (binary, too large, empty, deleted, nothing picked,
// read failure) on one repo whose working tree holds a file of each kind and whose history has a commit with no
// files. Helpers come from scenarios-files-scope.mjs.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, lookEval, reloadApp, setInputExpr, waveService } from "./scenarios-shared.mjs";
import {
    DIFF_EDITOR,
    fileRowSel,
    historyRowCount,
    openOnDiff,
    pickFile,
    pickHistoryRow,
    removeFixtures,
    setViewport,
    sleep,
    textOf,
    until,
} from "./scenarios-files-scope.mjs";

const BLOB_BYTES = 1024;
// over the pane's size limit for an untracked file
const BIG_LOG_BYTES = 3 * 1024 * 1024;
// diffoptions.SPLIT_MIN_PX: below it the pane offers no split, so the hint names ⇧H instead of ⇧D
const SPLIT_MIN_PX = 900;
const NARROW_HINT = "Removed lines: collapse history (⇧H) or widen the window to use split view and comment on them";
const PANE = "[data-diff-pane]";
const emptyIs = (kind) => `!!document.querySelector(${JSON.stringify(`${PANE} [data-diff-empty="${kind}"]`)})`;

// opens a file and waits for the pane's empty state of that kind; returns what the pane says
async function emptyStateOf(h, path, kind) {
    const picked = await pickFile(h, path);
    const shown = picked && (await until(h, emptyIs(kind)));
    return { picked, shown, pane: (await textOf(h, PANE)).slice(0, 160) };
}

// an open diff can hold focus in Monaco, where the dispatcher lets every key through
async function pressKey(h, key, code, vk, modifiers = 0) {
    await h.ev("document.activeElement?.blur?.()");
    // a named key (Enter) types no character
    const text = key.length === 1 ? key : undefined;
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, text, windowsVirtualKeyCode: vk, modifiers });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
}

const SHIFT = 8; // CDP modifier bitmask
const CTRL = 2;
const COMMENT_STORAGE_KEY = "diff.comments.pending";
const FLAGS_KEY = "agent.launch.flags";
// a real Claude Code session on haiku, which keeps it cheap. The prompt is typed into its terminal rather than passed
// on the command line: the launch splits a quoted argument at its first space.
const ASK_COMMAND = "claude --model haiku";
const ASK_PROMPT = "Use the AskUserQuestion tool to ask me one question: should the retry budget be 3 or 8? Ask only that and do nothing else.";
// the folder-trust prompt a new temp folder gets; its default is "No, exit", so it is answered with Down then Enter
const TRUST_TEXT = "trust this folder";
const DOWN = "\x1b[B";
// Claude Code's input box: a rule line, then its prompt glyph (a shell prompt draws no rule)
const INPUT_BOX = /─{20,}\s*❯/;
const AGENT_READY_MS = 60_000;
const AGENT_ASKING_MS = 120_000;
const AGENT_POLL_MS = 1000;
const KEY_GAP_MS = 800;
const ASK_NOTE = "Keep the old helper until the caller moves.";

// the cockpit's model, found the way the other scenarios find it: on the nav rail's props
const MODEL = `(() => {
    const nav = document.querySelector('nav');
    const key = nav && Object.keys(nav).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? nav[key] : null; f != null; f = f.return) {
        if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
    }
    return null;
})()`;
const NEW_AGENT = `[...document.querySelectorAll('[role="dialog"]')].find((d) => /New agent/.test(flat(d.querySelector("h2"))))`;

// launches a Claude Code agent in the project through New agent; returns its tab, block and roster name
async function launchAskingAgent(h, project) {
    await lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { naFlagsAtom } = await mod("app/view/agents/naflagsstore.ts");
        const model = ${MODEL};
        // a remembered flag would be appended to the command
        globalStore.set(naFlagsAtom, {});
        globalStore.set(model.newAgentOpenAtom, true);
        await until(() => ${NEW_AGENT} != null, 5000);
        button(${NEW_AGENT}?.querySelector('[role="radiogroup"][aria-label="Project"]'), new RegExp("^" + ${JSON.stringify(project)} + "$"))?.click();
        button(${NEW_AGENT}?.querySelector('[role="radiogroup"][aria-label="Runtime"]'), /Claude Code/)?.click();
        await nap(200);
    `);
    await h.ev(setInputExpr(`document.getElementById("na-cmd")`, ASK_COMMAND));
    return lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { atoms } = await mod("app/store/global-atoms.ts");
        const model = ${MODEL};
        const before = new Set(globalStore.get(model.pendingLaunchesAtom).map((p) => p.tabId));
        const project = flat(${NEW_AGENT}?.querySelector('[role="radiogroup"][aria-label="Project"] [aria-checked="true"]'));
        await nap(200);
        button(${NEW_AGENT}, /^Launch agent/)?.click();
        const closed = await until(() => ${NEW_AGENT} == null, 15000);
        const pending = globalStore.get(model.pendingLaunchesAtom).find((p) => !before.has(p.tabId));
        const error = closed ? null : flat(${NEW_AGENT});
        // a failed launch leaves the dialog up over every later scenario
        if (!closed) globalStore.set(model.newAgentOpenAtom, false);
        return {
            closed,
            project,
            error,
            tabId: pending?.tabId ?? null,
            blockId: pending?.blockId ?? null,
            name: pending?.name ?? null,
            workspaceId: globalStore.get(atoms.workspace)?.oid ?? null,
        };
    `);
}

const agentState = (h, tabId) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        return globalStore.get(${MODEL}.agentsAtom).find((a) => a.id === ${JSON.stringify(tabId)})?.state ?? null;
    `);

const typeInto = (h, blockId, text) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
        await RpcApi.ControllerInputCommand(TabRpcClient, { blockid: ${JSON.stringify(blockId)}, inputdata64: btoa(${JSON.stringify(text)}) });
    `);

// the terminal's visible text, from the xterm the hidden Agent surface keeps mounted
const screenOf = (h, blockId) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
        try {
            const r = await RpcApi.TermGetScrollbackLinesCommand(TabRpcClient, { linestart: 0, lineend: 200, lastcommand: false }, { route: "feblock:" + ${JSON.stringify(blockId)} });
            return r.lines.join(" ");
        } catch (e) {
            return "";
        }
    `);

// accepts the trust prompt once it shows, types the question's prompt once Claude Code's input is up, then waits for the ask
async function untilAsking(h, agent) {
    const seen = [];
    let trusted = false;
    let prompted = false;
    for (let waited = 0; waited < AGENT_READY_MS && !prompted; waited += AGENT_POLL_MS) {
        await sleep(AGENT_POLL_MS);
        const screen = await screenOf(h, agent.blockId);
        if (!trusted && screen.includes(TRUST_TEXT)) {
            await typeInto(h, agent.blockId, DOWN);
            await sleep(KEY_GAP_MS);
            await typeInto(h, agent.blockId, "\r");
            trusted = true;
        } else if (!screen.includes(TRUST_TEXT) && INPUT_BOX.test(screen)) {
            // Claude Code is past the trust prompt and its input box is drawn
            await sleep(KEY_GAP_MS);
            await typeInto(h, agent.blockId, ASK_PROMPT);
            await sleep(KEY_GAP_MS);
            await typeInto(h, agent.blockId, "\r");
            prompted = true;
        }
    }
    for (let waited = 0; prompted && waited < AGENT_ASKING_MS; waited += AGENT_POLL_MS) {
        const state = await agentState(h, agent.tabId);
        if (state !== seen[seen.length - 1]) seen.push(state);
        if (state === "asking") return { asking: true, trusted, prompted, seen };
        await sleep(AGENT_POLL_MS);
    }
    return { asking: false, trusted, prompted, seen, screen: (await screenOf(h, agent.blockId)).replace(/\s+/g, " ").slice(-600) };
}

export const STATES = {
    project: "verify-diff-states",
    seed: "seed the states repo",
    noFiles: "a commit with no files",
    deleted: "src/old.py",
    deletedEmpty: "src/gone.txt",
    binary: "src/blob.bin",
    big: "big.log",
    empty: "src/empty.txt",
};

function seedStatesRepo() {
    const dir = mkdtempSync(join(tmpdir(), "verify-diff-states-"));
    git(dir, "init", "-q", "--initial-branch=main");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, STATES.deleted), "def old():\n    return 1\n");
    writeFileSync(join(dir, STATES.deletedEmpty), "");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", STATES.seed);
    git(dir, "commit", "-q", "--allow-empty", "-m", STATES.noFiles);
    rmSync(join(dir, STATES.deleted));
    rmSync(join(dir, STATES.deletedEmpty));
    writeFileSync(join(dir, STATES.binary), randomBytes(BLOB_BYTES));
    writeFileSync(join(dir, STATES.big), "x".repeat(BIG_LOG_BYTES - 1) + "\n");
    writeFileSync(join(dir, STATES.empty), "");
    return dir;
}

export const diffStates = {
    name: "diff-states",
    surface: "files",
    async arrange(h) {
        const dir = seedStatesRepo();
        await h.rpc("createproject", { name: STATES.project, path: dir });
        // the comment store reads its key once, at module load, so it is cleared before the reload; teardown puts
        // back the user's comments and remembered launch flags
        const prevComments = await h.ev(`localStorage.getItem(${JSON.stringify(COMMENT_STORAGE_KEY)})`);
        const prevFlags = await h.ev(`localStorage.getItem(${JSON.stringify(FLAGS_KEY)})`);
        await h.ev(`localStorage.removeItem(${JSON.stringify(COMMENT_STORAGE_KEY)})`);
        // fresh module state: Diff's scope, range and history collapse outlive the surface for the page's life
        await reloadApp(h);
        return { dir, names: [STATES.project], dirs: [dir], prevComments, prevFlags, agent: null };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        // one failed step is one FAIL row, not an abort of every step after it
        const guard = async (step, fn) => {
            try {
                await fn();
            } catch (e) {
                rec(step, false, String(e?.message ?? e));
            }
        };
        try {
            await setViewport(h);
            const opened = await openOnDiff(h, STATES.project);
            // the working tree draws as a history row of its own, above the two commits
            const rows = await historyRowCount(h);
            const commits = await h.ev(`(() => {
                const text = [...document.querySelectorAll("[data-history-row]")].map((r) => r.textContent).join("\\n");
                return [${JSON.stringify(STATES.seed)}, ${JSON.stringify(STATES.noFiles)}].every((s) => text.includes(s));
            })()`);
            const files = [STATES.deleted, STATES.deletedEmpty, STATES.binary, STATES.big, STATES.empty];
            const listed = await until(h, files.map((p) => `!!document.querySelector(${JSON.stringify(fileRowSel(p))})`).join(" && "));
            const listedRows = await h.ev(
                `[...document.querySelectorAll("[data-changed-file-row]")].map((e) => e.dataset.changedFileRow).join(",")`
            );
            const picked = await pickFile(h, STATES.deleted);
            const diff = picked && (await until(h, `!!document.querySelector(${JSON.stringify(DIFF_EDITOR)})`));
            rec(
                "1. the project opens on Diff with its two commits, lists each working-tree file, and the deleted file opens a diff",
                opened && rows === 3 && commits && listed && diff,
                JSON.stringify({ opened, rows, commits, listed, listedRows, picked, diff, pane: (await textOf(h, "[data-diff-pane]")).slice(0, 120) })
            );
            await h.shot("cdp-shots/diff-states-open.png");
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
            return steps;
        }

        const s2 = "2. untracked binary: the working-tree read says Binary file instead of drawing bytes";
        await guard(s2, async () => {
            const got = await emptyStateOf(h, STATES.binary, "binary");
            rec(s2, got.shown && got.pane.includes("Binary file"), JSON.stringify(got));
            await h.shot("cdp-shots/diff-states-binary.png");
        });

        const s3 = "3. untracked too large: a 3 MB untracked file is capped on the working-tree side";
        await guard(s3, async () => {
            const got = await emptyStateOf(h, STATES.big, "toolarge");
            rec(s3, got.shown && got.pane.includes("Too large to show here"), JSON.stringify(got));
        });

        const s4 = "4. new empty file: an empty untracked file reads New empty file, not a rename";
        await guard(s4, async () => {
            const got = await emptyStateOf(h, STATES.empty, "newempty");
            rec(s4, got.shown && got.pane.includes("New empty file"), JSON.stringify(got));
            await h.shot("cdp-shots/diff-states-new-empty.png");
        });

        const s5 = "5. deleted empty file: a deleted empty file reads Deleted empty file, not a rename";
        await guard(s5, async () => {
            const got = await emptyStateOf(h, STATES.deletedEmpty, "deletedempty");
            rec(s5, got.shown && got.pane.includes("Deleted empty file"), JSON.stringify(got));
        });

        const s6 = "6. narrow-pane hint: with history expanded at 1600x950 the removed-lines hint names ⇧H, not ⇧D";
        await guard(s6, async () => {
            // the history column is what narrows the pane below split's width
            await h.ev(`document.querySelector('[aria-label="Expand history"]')?.click()`);
            const expanded = await until(h, `!document.querySelector('[aria-label="Expand history"]')`);
            const picked = await pickFile(h, STATES.deleted);
            const diff = picked && (await until(h, `!!document.querySelector(${JSON.stringify(DIFF_EDITOR)})`));
            const hinted = diff && (await until(h, `!!document.querySelector("[data-diff-split-hint]")`));
            const hint = await textOf(h, "[data-diff-split-hint]");
            const width = await h.ev(`document.querySelector(${JSON.stringify(PANE)})?.clientWidth ?? 0`);
            rec(
                s6,
                expanded && hinted && hint === NARROW_HINT && width < SPLIT_MIN_PX,
                JSON.stringify({ expanded, picked, diff, hint, width })
            );
            await h.shot("cdp-shots/diff-states-narrow-hint.png");
        });

        const s7 = "7. diff read failure: a modified file denied read-data says Couldn’t read this file with Retry, and Retry reads it once readable";
        await guard(s7, async () => {
            const path = join(ctx.dir, STATES.deleted);
            const winPath = path.replace(/\//g, "\\");
            // a size the index does not hold, so git lists it as modified without hashing its bytes
            writeFileSync(path, "def old():\n    return 30\n");
            // refreshes the index's stat for it, so later statuses never need to read it
            git(ctx.dir, "status", "--porcelain");
            const picked = await pickFile(h, STATES.deleted);
            await pressKey(h, "r", "KeyR", 82);
            // monaco draws a space as a non-breaking one
            const editorHas = (text) =>
                `(document.querySelector(${JSON.stringify(DIFF_EDITOR)})?.textContent ?? "").replace(/\\u00a0/g, " ").includes(${JSON.stringify(text)})`;
            const diff = picked && (await until(h, editorHas("return 30")));
            // read-data only: the stat still succeeds and git still lists it, the read of its bytes fails
            execFileSync("icacls", [winPath, "/deny", `${process.env.USERNAME}:(RD)`], { stdio: "pipe" });
            let failed = false;
            let failedText = "";
            let recovered = false;
            try {
                await pressKey(h, "r", "KeyR", 82);
                failed = await until(h, `${emptyIs("failed")} && !!document.querySelector("[data-diff-retry]")`);
                failedText = await textOf(h, PANE);
                await h.shot("cdp-shots/diff-states-read-failure.png");
            } finally {
                execFileSync("icacls", [winPath, "/remove:d", process.env.USERNAME], { stdio: "pipe" });
            }
            try {
                await h.ev(`document.querySelector("[data-diff-retry]")?.click()`);
                recovered = await until(h, editorHas("return 30"));
            } finally {
                // later steps see the fixture's deleted file
                rmSync(path, { force: true });
            }
            rec(
                s7,
                diff && failed && failedText.includes("Couldn’t read this file") && recovered,
                JSON.stringify({ picked, diff, failed, failedText: failedText.slice(0, 200), recovered })
            );
        });

        const s8 = "8. pick a file: a commit with no files asks for a file and names n / p";
        await guard(s8, async () => {
            const picked = await pickHistoryRow(h, STATES.noFiles);
            const shown = picked && (await until(h, emptyIs("nofile")));
            const pane = await textOf(h, PANE);
            rec(
                s8,
                shown &&
                    pane.includes("Pick a file to see its changes") &&
                    pane.includes("Choose one from the list, or step through it with n / p."),
                JSON.stringify({ picked, shown, pane: pane.slice(0, 160) })
            );
            await h.shot("cdp-shots/diff-states-pick-file.png");
        });

        // the seed commit lists src/gone.txt then src/old.py
        const s9 = "9. n / p step files: n opens the next row without marking it, declines at the last, and p steps back";
        await guard(s9, async () => {
            const openRow = () =>
                h.ev(`(() => { const r = document.querySelector('[data-changed-file-row][aria-current="true"]');
                    return r ? r.dataset.changedFileRow + ":" + r.dataset.reviewState : null; })()`);
            const isOpen = (path) => `document.querySelector(${JSON.stringify(fileRowSel(path))})?.getAttribute("aria-current") === "true"`;
            const picked = (await pickHistoryRow(h, STATES.seed)) && (await pickFile(h, STATES.deletedEmpty));
            await pressKey(h, "n", "KeyN", 78);
            const next = (await until(h, isOpen(STATES.deleted))) && (await openRow());
            await pressKey(h, "n", "KeyN", 78);
            await sleep(500);
            const atEnd = await openRow();
            await pressKey(h, "p", "KeyP", 80);
            const back = (await until(h, isOpen(STATES.deletedEmpty))) && (await openRow());
            rec(
                s9,
                picked && next === `${STATES.deleted}:none` && atEnd === `${STATES.deleted}:none` && back === `${STATES.deletedEmpty}:none`,
                JSON.stringify({ picked, next, atEnd, back })
            );
            await h.shot("cdp-shots/diff-states-step-files.png");
        });

        const s10 = "10. ⇧D declined when narrow: with history expanded at 1600x950, ⇧D leaves the pane unified";
        await guard(s10, async () => {
            const splitState = () =>
                lookEval(h, `
                    const { globalStore } = await mod("app/store/jotaiStore.ts");
                    const o = await mod("app/view/agents/diffoptions.ts");
                    return { split: globalStore.get(o.splitViewAtom), available: globalStore.get(o.splitAvailableAtom) };
                `);
            const expanded = await h.ev(`!document.querySelector('[aria-label="Expand history"]')`);
            const picked = await pickFile(h, STATES.deleted);
            const diff = picked && (await until(h, `!!document.querySelector(${JSON.stringify(DIFF_EDITOR)})`));
            const before = await splitState();
            await pressKey(h, "D", "KeyD", 68, SHIFT);
            await sleep(500);
            const after = await splitState();
            const width = await h.ev(`document.querySelector(${JSON.stringify(PANE)})?.clientWidth ?? 0`);
            rec(
                s10,
                expanded && diff && width < SPLIT_MIN_PX && !before.available && !before.split && !after.split,
                JSON.stringify({ expanded, picked, diff, width, before, after })
            );
        });

        const s11 = "11. asking agent waits: a Claude Code agent asking a question gets no comments — the bar says answer it first and ⇧Enter sends nothing";
        await guard(s11, async () => {
            const agent = await launchAskingAgent(h, STATES.project);
            ctx.agent = agent;
            if (agent.tabId == null) {
                rec(s11, false, `the launch did not start: ${JSON.stringify(agent)}`);
                return;
            }
            const asked = await untilAsking(h, agent);
            // the working tree then edits old.py, so the agent's synthetic row lists it with a side to comment on
            writeFileSync(join(ctx.dir, STATES.deleted), "def old():\n    return 2\n");
            await h.goto("files");
            await setViewport(h);
            // by id: the picker's own trigger and the project row carry the same name as the agent
            const agentRow = `document.querySelector(${JSON.stringify(`[data-files-source-agent="${agent.tabId}"]`)})`;
            await h.ev(`document.querySelector("[data-files-source-picker]")?.click()`);
            const listed = await until(h, `!!${agentRow}`, 10000);
            await h.ev(`${agentRow}?.click()`);
            // The picker's text already holds the agent's name under the project scope, so it cannot say the switch
            // happened. Until the agent scope's own load settles, the list on screen is the project's (the seed commit
            // step 10 left open, which lists old.py too), and a file picked there is replaced when the scope resets
            // to its default row (F4). So this waits for the store to hold the agent scope, its change list, and
            // its synthetic row selected.
            const scope = await lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const fs = await mod("app/view/agents/filesstore.ts");
                const hs = await mod("app/view/agents/githistorystore.ts");
                const { WORKING_TREE } = await mod("app/view/agents/historyrows.ts");
                const model = ${MODEL};
                const read = () => {
                    const origin = globalStore.get(model.diffScopeAtom)?.repo.origin;
                    const files = globalStore.get(fs.filesStateAtom)?.changes?.files ?? null;
                    const rows = globalStore.get(hs.historyRowsAtom) ?? [];
                    return {
                        agent: origin?.kind === "agent" && origin.id === ${JSON.stringify(agent.tabId)},
                        files: files?.map((f) => f.path) ?? null,
                        commit: globalStore.get(hs.selectedCommitAtom),
                        top: rows[0]?.workingTree ? rows[0].subject : null,
                    };
                };
                const settled = await until(() => {
                    const s = read();
                    return s.agent && !!s.files?.includes(${JSON.stringify(STATES.deleted)}) && s.top != null && s.commit === WORKING_TREE;
                }, 15000);
                return { settled, ...read() };
            `);
            const scoped = scope.settled && !(await h.ev(`!!${agentRow}`));
            const opened = scoped && (await pickFile(h, STATES.deleted)) && (await until(h, `!!document.querySelector(${JSON.stringify(DIFF_EDITOR)})`));
            await pressKey(h, "m", "KeyM", 77);
            const drafting = await until(h, `!!document.querySelector("[data-diff-comment-draft] textarea")`, 3000);
            await h.ev(`document.querySelector("[data-diff-comment-draft] textarea")?.focus()`);
            await h.cdp("Input.insertText", { text: ASK_NOTE });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: CTRL });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: CTRL });
            const waiting = await until(h, `document.querySelector("[data-comment-send-bar]")?.dataset.recipientKind === "wait"`, 8000);
            // every agentprompt the page makes is counted, and none is forwarded
            await h.ev(`(() => {
                const c = window.TabRpcClient;
                window.__dsPrompts = 0;
                if (!c.__dsOrig) {
                    c.__dsOrig = c.wshRpcCall;
                    const call = c.wshRpcCall.bind(c);
                    c.wshRpcCall = (command, data, opts) => {
                        if (command !== "agentprompt") return call(command, data, opts);
                        window.__dsPrompts++;
                        return Promise.resolve(null);
                    };
                }
            })()`);
            // with any other recipient ⇧Enter would really send, or start a new agent, so it is pressed only on a wait bar
            if (waiting) {
                await pressKey(h, "Enter", "Enter", 13, SHIFT);
                await sleep(1000);
            }
            const bar = await h.ev(`(() => { const b = document.querySelector("[data-comment-send-bar]"); if (!b) return null;
                const send = b.querySelector("[data-comment-send]");
                return { kind: b.dataset.recipientKind, detail: b.querySelector("[data-comment-detail]")?.textContent ?? null,
                    send: send?.textContent ?? null, disabled: send?.disabled ?? null,
                    pending: document.querySelectorAll('[data-diff-comment-card][data-comment-state="pending"]').length }; })()`);
            const prompts = await h.ev(`window.__dsPrompts`);
            await h.shot("cdp-shots/diff-states-asking-agent.png");
            await h.ev(`(() => { const c = window.TabRpcClient; if (c.__dsOrig) { c.wshRpcCall = c.__dsOrig; delete c.__dsOrig; } })()`);
            rec(
                s11,
                asked.asking &&
                    listed &&
                    scoped &&
                    opened &&
                    drafting &&
                    waiting &&
                    bar?.kind === "wait" &&
                    bar.detail === `${agent.name} is asking a question — answer it first` &&
                    bar.send === "Send 1 comment" &&
                    bar.disabled === true &&
                    bar.pending === 1 &&
                    prompts === 0,
                JSON.stringify({ agent: { name: agent.name, project: agent.project }, asked, listed, scoped, scope, opened, drafting, waiting, bar, prompts })
            );
        });
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`diff-states teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        if (ctx.agent?.tabId) {
            await step("close the agent", () => waveService(h, "workspace", "CloseTab", [ctx.agent.workspaceId, ctx.agent.tabId, false]));
        }
        await step("restore comments and launch flags", () =>
            h.ev(`(() => {
                const put = (k, v) => (v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v));
                put(${JSON.stringify(COMMENT_STORAGE_KEY)}, ${JSON.stringify(ctx.prevComments ?? null)});
                put(${JSON.stringify(FLAGS_KEY)}, ${JSON.stringify(ctx.prevFlags ?? null)});
            })()`)
        );
        await removeFixtures(h, ctx.names, ctx.dirs);
    },
};
