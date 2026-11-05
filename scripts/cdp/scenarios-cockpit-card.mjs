// Cockpit review scenarios: card header, chips and ask scroll.
// F8: two cards in one checkout charge its changes to neither alone, so both diff chips read "repo", while a card in
// a worktree of the same repo keeps its own chip. F12: an idle card's mute reads Move to Idle, in its menu and on its
// button. F22: at the 1000x700 dev window the standing-by card's name keeps its room beside its chips, and an asking
// card opens on its first option, whether the ask is there at mount or arrives later. The diff chips come from a real
// temp repo and worktree the transcripts point at; the fixture roster is read once at boot, so arrange reloads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TREE_RAIL_FIXTURE, git, lookEval, polishReload, polishWaitFor } from "./scenarios-shared.mjs";

const SMALL_WINDOW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const PROJECT = "card-layout";
const ID = {
    a: "fx-card-shared-a",
    b: "fx-card-shared-b",
    standing: "fx-card-standing",
    idle: "fx-card-idle",
    ask: "fx-card-asking",
    arrive: "fx-card-arrive",
};
const SHARED_TITLE = "All changes in this checkout, shared by 2 agents";
const SHELL = [
    { id: "bshcardserve", description: "serve the preview" },
    { id: "bshcardwatch", description: "watch the test suite" },
    { id: "bshcardtail", description: "tail the dev log" },
];
const ASK = {
    askId: "fx-card-ask",
    questions: [
        {
            header: "Parser",
            question: "Which parser should the fix keep?",
            options: [
                { label: "keep the hand-written parser", description: "smallest change, keeps today's error messages" },
                { label: "move to the generated parser", description: "drops 400 lines, changes every error message" },
                { label: "keep both behind a flag", description: "doubles the test matrix until one goes" },
            ],
        },
    ],
};
const FIRST_OPTION = ASK.questions[0].options[0].label;
// enough narration that a short card's feed overflows its body
const narration = (who) =>
    Array.from({ length: 14 }, (_, i) => ({ kind: "message", text: `${who}: step ${i + 1} of the parser review, read and noted.` }));

// the records claude writes when a Bash call starts in the background, so the card reads its shell tasks for real
function shellStart(task, dir, timestamp) {
    const toolUseId = `toolu_${task.id}`;
    const output = join(dir, `${task.id}.output`);
    writeFileSync(output, "running\n");
    return [
        {
            type: "assistant",
            timestamp,
            message: {
                role: "assistant",
                content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: `./${task.id}.sh`, description: task.description, run_in_background: true } }],
            },
        },
        {
            type: "user",
            timestamp,
            message: {
                role: "user",
                content: [
                    {
                        tool_use_id: toolUseId,
                        type: "tool_result",
                        content: `Command running in background with ID: ${task.id}. Output is being written to: ${output}. You will be notified when it completes. To check interim output, use Read on that file path.`,
                        is_error: false,
                    },
                ],
            },
            toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: task.id },
        },
    ];
}

// the standing card's subagents are real files beside its transcript, where GetSubagentsCommand looks: a value lent
// into the store is replaced by the next disk read, which the tracker does on its own clock
function writeSubagents(dir, name) {
    const sub = join(dir, name, "subagents");
    mkdirSync(sub, { recursive: true });
    const record = (type, content) => JSON.stringify({ type, isSidechain: true, message: { role: type, content } });
    writeFileSync(join(sub, "agent-fxsub1.jsonl"), record("user", "Explore the parser's callers") + "\n");
    writeFileSync(
        join(sub, "agent-fxsub2.jsonl"),
        [record("user", "Plan the parser rewrite"), record("assistant", [{ type: "text", text: "Planned." }])].join("\n") + "\n"
    );
}

// a transcript whose cwd record points the card's git chip at `cwd`; written after the repo's commit, so the
// session start anchors on it
function writeTranscript(dir, name, cwd, shellTasks = []) {
    const timestamp = new Date().toISOString();
    const records = [{ type: "user", cwd, timestamp, message: { role: "user", content: `verify ${name}` } }];
    for (const t of shellTasks) records.push(...shellStart(t, dir, timestamp));
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, records.map((r) => JSON.stringify(r) + "\n").join(""));
    return path;
}

function roster(t) {
    const now = Date.now();
    const agent = (id, name, extra) => ({
        id,
        name,
        project: PROJECT,
        task: name,
        agent: "claude",
        model: "opus",
        blockId: `fx-blk-${id}`,
        previousInfo: [{ kind: "message", text: `${name} is on it.` }],
        ...extra,
    });
    return [
        agent(ID.a, "shared checkout one", { state: "working", activity: "editing the parser", activeMs: 120_000, transcriptPath: t.a }),
        agent(ID.b, "shared checkout two", { state: "working", activity: "writing its tests", activeMs: 90_000, transcriptPath: t.b }),
        agent(ID.standing, "standing-by agent with a long descriptive name", {
            state: "idle",
            idleSince: now - 60_000,
            transcriptPath: t.standing,
        }),
        agent(ID.idle, "idle card", { state: "idle", idleSince: now - 60_000 }),
        agent(ID.ask, "asking at mount", { state: "asking", blockedMs: 30_000, previousInfo: narration("asking at mount"), ask: ASK }),
        agent(ID.arrive, "ask arrives later", {
            state: "working",
            activity: "reading the spec",
            activeMs: 60_000,
            previousInfo: narration("ask arrives later"),
        }),
    ];
}

const card = (id) => `document.querySelector('[data-cockpit-surface] [data-agent-id="${id}"]')`;
const chipOf = (id) => `(() => {
    const c = ${card(id)}?.querySelector('[data-diff-chip]');
    return c ? { kind: c.dataset.diffChip, text: flat(c), title: c.title } : null;
})()`;

// whether the card's first answer option sits inside its scroll region, and whether that region overflows at all
const optionInView = (id) => `(() => {
    const c = ${card(id)};
    const region = c?.querySelector('.overflow-y-auto');
    const opt = [...(region?.querySelectorAll('button') ?? [])].find((b) => flat(b).includes(${JSON.stringify(FIRST_OPTION)}));
    if (!region || !opt) return { found: false };
    const r = region.getBoundingClientRect();
    const o = opt.getBoundingClientRect();
    return {
        found: true,
        inView: o.top >= r.top - 1 && o.bottom <= r.bottom + 1,
        overflows: region.scrollHeight > region.clientHeight + 1,
        scrollTop: Math.round(region.scrollTop),
        region: [Math.round(r.top), Math.round(r.bottom)],
        option: [Math.round(o.top), Math.round(o.bottom)],
    };
})()`;

export const cockpitCardLayout = {
    name: "cockpit-card-layout",
    surface: "cockpit",
    async arrange(h) {
        const ctx = {};
        try {
            ctx.root = mkdtempSync(join(tmpdir(), "verify-card-layout-"));
            const repo = join(ctx.root, "repo");
            const wt = join(ctx.root, "repo-wt");
            mkdirSync(repo);
            git(repo, "init", "-q", "--initial-branch=main");
            writeFileSync(join(repo, "parser.go"), "package parser\n\nfunc Parse() int {\n    return 1\n}\n");
            git(repo, "add", ".");
            git(repo, "commit", "-q", "-m", "seed the parser");
            git(repo, "worktree", "add", "-q", "-b", "feature", wt);
            writeFileSync(join(repo, "parser.go"), "package parser\n\nfunc Parse() int {\n    return 2\n}\n");
            writeFileSync(join(wt, "parser.go"), "package parser\n\n// Parse parses.\nfunc Parse() int {\n    return 3\n}\n");
            const transcripts = {
                a: writeTranscript(ctx.root, "shared-a", repo),
                // the same checkout, spelled with forward slashes
                b: writeTranscript(ctx.root, "shared-b", repo.replace(/\\/g, "/")),
                standing: writeTranscript(ctx.root, "standing", wt, SHELL),
            };
            writeSubagents(ctx.root, "standing");
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(roster(transcripts), null, 2));
            ctx.wroteFixture = true;
            await h.cdp("Emulation.setDeviceMetricsOverride", SMALL_WINDOW);
            await polishReload(h);
            await h.goto("cockpit");
            const ready = await polishWaitFor(h, `Object.values(${JSON.stringify(ID)}).every((id) => !!document.querySelector('[data-cockpit-surface] [data-agent-id="' + id + '"]'))`, 15_000);
            if (!ready) ctx.arrangeError = "the fixture cards never rendered";
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) return [{ step: "cockpit-card-layout: arrange", ok: false, detail: ctx.arrangeError }];
        const steps = [];

        const chips = await lookEval(h, `
            await until(() => ${card(ID.a)}?.querySelector('[data-diff-chip]') && ${card(ID.b)}?.querySelector('[data-diff-chip]') && ${card(ID.standing)}?.querySelector('[data-diff-chip]'), 20000);
            return { a: ${chipOf(ID.a)}, b: ${chipOf(ID.b)}, worktree: ${chipOf(ID.standing)} };
        `);
        const repoChip = (c) => c?.kind === "repo" && c.text.startsWith("repo") && c.title === SHARED_TITLE;
        steps.push({
            step: "two cards in one checkout show the repo-wide diff chip",
            ok: repoChip(chips.a) && repoChip(chips.b) && chips.worktree?.kind === "agent" && !chips.worktree.text.startsWith("repo"),
            detail: JSON.stringify(chips),
        });
        await h.shot("cdp-shots/cockpit-card-layout-repo-chip.png");

        // right-clicks the card, reads its menu and mute button, and leaves the menu open for the shot
        const openMenu = (id) =>
            lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
                closeContextMenu();
                const c = ${card(id)};
                const r = c.getBoundingClientRect();
                c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 }));
                await until(() => globalStore.get(contextMenuAtom) != null, 2000);
                await nap(250);
                return {
                    labels: (globalStore.get(contextMenuAtom)?.items ?? []).map((i) => i.label).filter(Boolean),
                    rendered: [...document.querySelectorAll("span.whitespace-nowrap")].map((s) => s.textContent).filter((t) => t.startsWith("Move to")),
                    button: [...c.querySelectorAll("button[title^='Move to']")].map((b) => b.title),
                };
            `);
        const closeMenu = () => lookEval(h, `(await mod("app/store/contextmenu.ts")).closeContextMenu();`);
        const menu = { idle: await openMenu(ID.idle) };
        await h.shot("cdp-shots/cockpit-card-layout-idle-menu.png");
        menu.working = await openMenu(ID.a);
        await closeMenu();
        steps.push({
            step: "an idle card's menu and button read Move to Idle",
            ok:
                menu.idle.labels.includes("Move to Idle") &&
                !menu.idle.labels.includes("Move to background") &&
                menu.idle.rendered.includes("Move to Idle") &&
                menu.idle.button.join() === "Move to Idle" &&
                menu.working.labels.includes("Move to background") &&
                menu.working.button.join() === "Move to background (B)",
            detail: JSON.stringify(menu),
        });

        const header = await lookEval(h, `
            const c = () => ${card(ID.standing)};
            const chipEls = () => [
                c()?.querySelector('[data-shell-tasks-chip]'),
                [...(c()?.querySelectorAll('button[title$="subagents"]') ?? [])][0],
                c()?.querySelector('[data-diff-chip]'),
            ];
            await until(() => chipEls().every(Boolean) && flat(c()).toLowerCase().includes("standing by"), 15000);
            // into view for the shot
            c()?.scrollIntoView({ block: "center" });
            await nap(300);
            const R = (el) => el.getBoundingClientRect();
            const overlap = (p, q) => p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom && q.top < p.bottom;
            const head = c()?.firstElementChild;
            const status = head?.firstElementChild;
            const name = status?.querySelector("b");
            const pill = name?.nextElementSibling ?? null;
            const shown = (e) => e != null && R(e).width > 0;
            // everything the header draws side by side: the name, the project chip if shown, the chips, the buttons
            const items = [
                ["name", name],
                ["project", pill],
                ...chipEls().map((e, i) => [["shell", "subagents", "diff"][i], e]),
                ...[...(head?.querySelectorAll(":scope > button") ?? [])].filter((b) => !chipEls().includes(b)).map((b) => [b.title, b]),
            ].filter(([, e]) => shown(e));
            const overlaps = [];
            for (let i = 0; i < items.length; i++)
                for (let j = i + 1; j < items.length; j++)
                    if (overlap(R(items[i][1]), R(items[j][1]))) overlaps.push(items[i][0] + "/" + items[j][0]);
            return {
                card: Math.round(R(c()).width),
                standing: flat(c()).toLowerCase().includes("standing by"),
                name: name ? { width: Math.round(R(name).width), text: flat(name), insideStatus: R(name).right <= R(status).right + 0.5 } : null,
                project: shown(pill),
                chips: chipEls().map((e) => e && e.innerText.replace(/\\s+/g, " ").trim()),
                items: items.map(([k, e]) => k + ":" + Math.round(R(e).left) + "-" + Math.round(R(e).right)),
                overlaps,
                clipped: head ? items.filter(([, e]) => R(e).right > R(head).right + 0.5).map(([k]) => k) : null,
            };
        `);
        // a card under 420px drops the project chip and shows its chips as counts, and the name keeps at least its
        // floor, whole inside the status line
        const narrow = header.card < 420;
        steps.push({
            step: "at 1000x700 the standing-by card's name and chips do not overlap",
            ok:
                header.standing &&
                header.chips.every(Boolean) &&
                header.name?.width >= 30 &&
                header.name.insideStatus &&
                header.overlaps.length === 0 &&
                header.clipped?.length === 0 &&
                (!narrow || (!header.project && /^\d+$/.test(header.chips[0]) && /^\d+$/.test(header.chips[1]))),
            detail: JSON.stringify(header),
        });
        await h.shot("cdp-shots/cockpit-card-layout-header.png");

        const ask = await lookEval(h, `
            const atMount = ${optionInView(ID.ask)};
            // the working card's feed is stuck to its bottom when the ask lands; the card grows to an asking share
            window.__cockpitRosterFixture.patch(${JSON.stringify(ID.arrive)}, { state: "asking", activity: undefined, blockedMs: 1000, ask: ${JSON.stringify({ ...ASK, askId: "fx-card-ask-arrive" })} });
            await until(() => ${optionInView(ID.arrive)}.found, 4000);
            await nap(600);
            return { mount: atMount, arrival: ${optionInView(ID.arrive)} };
        `);
        steps.push({
            step: "at 1000x700 an asking card shows its first option without scrolling",
            ok: ask.mount.found && ask.mount.inView && ask.arrival.found && ask.arrival.inView,
            detail: JSON.stringify(ask),
        });
        await h.shot("cdp-shots/cockpit-card-layout-ask.png");
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx?.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
        await h.cdp("Emulation.clearDeviceMetricsOverride");
        // onto the live roster again
        await polishReload(h);
        await h.goto("cockpit");
        if (ctx?.root) rmSync(ctx.root, { recursive: true, force: true });
    },
};
