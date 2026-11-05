// Agent review scenario `agent-tree` (F3, F6, F15, F16): with no agents the tree's AGENTS group offers New agent and
// recent sessions; Rename and Pin show on a booting row at once; Duplicate starts a fresh session with the source's
// launch flags and not its task; a terminal launched on the Agent surface is focused there, and New agent names it
// "Add terminal" anywhere else. The roster is a fixture of [] beside one real plain terminal tab; the booting and
// duplicated tabs are pending launches with no agent controller, so nothing an agent runs is started. The duplicate
// runs `node -e ""`, which exits at once.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPage, closeTabs, focusAgent, makeTab, restoreRoster, setRoster } from "./agent-page-fixtures.mjs";
import { setInputExpr, waveService } from "./scenarios-shared.mjs";

const NAME = "agent-tree";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const RECENT_IN_TREE = 3;
const WAIT_MS = 10_000;
const RECENT_KEY = "agent.launch.recentprojects";

const ROW = (id) => `document.querySelector('[data-agent-tree] [data-tree-agent="${id}"]')`;
const NEW_AGENT_MODAL = `[...document.querySelectorAll('[role="dialog"]')].find((d) => /New agent/.test(flat(d.querySelector("h2"))))`;

// opens the row's context menu and runs the item with this label, as a click on it does
const rowMenu = (h, id, label) =>
    agentPage(
        h,
        `const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
        const row = ${ROW(id)};
        if (!row) return { ok: false, why: "no row" };
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
        await until(() => globalStore.get(contextMenuAtom) != null, 2000);
        const items = globalStore.get(contextMenuAtom)?.items ?? [];
        const item = items.find((i) => i.label === ${JSON.stringify(label)});
        closeContextMenu();
        if (!item) return { ok: false, why: "no item", labels: items.map((i) => i.label).filter(Boolean) };
        item.click();
        return { ok: true };`
    );

// opens New agent, picks the Terminal runtime and reads its launch button (its text ends in the chord hint). With
// restore unset it launches and returns the tab the launch focused and the runtime the modal had picked; the modal
// keeps its runtime between opens, so a call given restore picks that runtime again and closes without launching.
const terminalFromModal = (h, restore) =>
    agentPage(
        h,
        `const model = agentsModel();
        const button = (from, re) => [...(from?.querySelectorAll("button") ?? [])].find((b) => re.test(flat(b)));
        const modal = () => ${NEW_AGENT_MODAL};
        const runtimes = () => modal()?.querySelector('[role="radiogroup"][aria-label="Runtime"]');
        globalStore.set(model.newAgentOpenAtom, true);
        await until(() => modal()?.querySelector('[role="radiogroup"][aria-label="Project"] [aria-checked="true"]') != null);
        const picked = flat(runtimes()?.querySelector('[aria-checked="true"]'));
        button(runtimes(), /^Terminal/)?.click();
        await nap(250);
        const label = flat(button(modal(), /^(Open|Add) terminal|^Launch agent/));
        const surface = globalStore.get(model.surfaceAtom);
        const restore = ${JSON.stringify(restore ?? null)};
        if (restore != null) {
            if (restore) button(runtimes(), new RegExp("^" + restore))?.click();
            await nap(100);
            globalStore.set(model.newAgentOpenAtom, false);
            return { label, surface };
        }
        const before = globalStore.get(model.focusIdAtom);
        button(modal(), /^(Open|Add) terminal/)?.click();
        const closed = await until(() => modal() == null, ${WAIT_MS});
        await until(() => globalStore.get(model.focusIdAtom) !== before, 3000);
        const focusId = globalStore.get(model.focusIdAtom);
        return { label, surface, picked, closed, error: closed ? null : flat(modal()), focusId: focusId !== before ? focusId : null };`
    );

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const tag = randomUUID().slice(0, 8);
                const ctx = { tag, tabIds: [], project: `verify-tree-${tag}` };
                await h.goto("agent");
                // a throw past this point still returns ctx, so teardown removes whatever was already made
                try {
                    ctx.dir = mkdtempSync(join(tmpdir(), "verify-agent-tree-"));
                    ctx.prevRecent = await h.ev(`localStorage.getItem(${JSON.stringify(RECENT_KEY)})`);
                    await setRoster(h, []);
                    const term = await makeTab(h, ctx, {
                        label: `tree-term-${tag}`,
                        blockMeta: { view: "term", "cmd:cwd": ctx.dir },
                        tabMeta: { "session:agent": "terminal" },
                    });
                    ctx.termId = term.tabId;
                    // a project New agent can launch a terminal in, scoped so the modal preselects it
                    const r = await agentPage(
                        h,
                        `const ps = await mod("app/view/agents/projectsstore.ts");
                        const model = agentsModel();
                        await ps.registerProject(${JSON.stringify(ctx.project)}, ${JSON.stringify(ctx.dir)});
                        const listed = await until(() => globalStore.get(ps.projectListAtom).some((p) => p.name === ${JSON.stringify(ctx.project)}), ${WAIT_MS});
                        const prevScope = globalStore.get(model.projectFilterAtom);
                        globalStore.set(model.projectFilterAtom, ${JSON.stringify(ctx.project)});
                        return { listed, prevScope };`
                    );
                    ctx.madeProject = true;
                    ctx.prevScope = r.prevScope;
                    if (!r.listed) throw new Error(`project ${ctx.project} never reached the project list`);
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the terminal tab and project", false, ctx.arrangeError);
                    return steps;
                }

                // 1. no agents: the AGENTS group offers New agent and the recent sessions
                await focusAgent(h, ctx.termId);
                const empty = await agentPage(
                    h,
                    `const R = await mod("app/view/agents/recentsessionsstore.ts");
                    const box = () => document.querySelector("[data-agent-tree] [data-tree-empty]");
                    await until(() => box() != null, ${WAIT_MS});
                    await until(() => globalStore.get(R.recentSessionsAtom) != null, ${WAIT_MS});
                    await nap(300);
                    const sessions = globalStore.get(R.recentSessionsAtom) ?? [];
                    const recent = [...(box()?.querySelectorAll("[data-tree-recent]") ?? [])].map((b) => b.dataset.treeRecent);
                    return {
                        text: flat(box()),
                        agents: globalStore.get(agentsModel().agentsAtom).length,
                        sessions: sessions.length,
                        want: sessions.slice(0, ${RECENT_IN_TREE}).map((s) => s.id),
                        recent,
                    };`
                );
                await h.shot(SHOT(1, "empty-agents"));
                empty.opened = await agentPage(
                    h,
                    `document.querySelector("[data-agent-tree] [data-tree-new-agent]")?.click();
                    const opened = await until(() => ${NEW_AGENT_MODAL} != null, 3000);
                    globalStore.set(agentsModel().newAgentOpenAtom, false);
                    return opened;`
                );
                const recentOk =
                    empty.sessions === 0 || JSON.stringify(empty.recent) === JSON.stringify(empty.want);
                rec(
                    "1. with no agents the AGENTS group shows No agents, New agent (opens its modal) and recent sessions",
                    empty.agents === 0 &&
                        empty.text.includes("No agents") &&
                        empty.text.includes("New agent") &&
                        empty.opened &&
                        recentOk,
                    (empty.sessions === 0
                        ? "the recent sessions part is skipped: the store has no recent sessions. "
                        : "") + JSON.stringify(empty)
                );

                // 2. Rename and Pin through the row menu show on a booting row at once
                try {
                    const booting = await makeTab(h, ctx, { label: `tree-boot-${ctx.tag}`, pending: true });
                    ctx.bootingId = booting.tabId;
                } catch (e) {
                    rec("2. arrange the booting tab", false, String(e?.message ?? e));
                    return steps;
                }
                const newName = `renamed-${ctx.tag}`;
                const renameMenu = await rowMenu(h, ctx.bootingId, "Rename");
                await agentPage(
                    h,
                    `await until(() => ${ROW(ctx.bootingId)}?.querySelector("input") != null, 3000);
                    return true;`
                );
                await h.ev(setInputExpr(`${ROW(ctx.bootingId)}?.querySelector("input")`, newName));
                const renamed = await agentPage(
                    h,
                    `const input = ${ROW(ctx.bootingId)}?.querySelector("input");
                    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
                    const shown = await until(() => flat(${ROW(ctx.bootingId)}).includes(${JSON.stringify(newName)}), ${WAIT_MS});
                    return { shown, text: flat(${ROW(ctx.bootingId)}) };`
                );
                const pinMenu = await rowMenu(h, ctx.bootingId, "Pin");
                const pinned = await agentPage(
                    h,
                    `const shown = await until(() => ${ROW(ctx.bootingId)}?.querySelector('[aria-label="Pinned"]') != null, ${WAIT_MS});
                    const agent = globalStore.get(agentsModel().agentsAtom).find((a) => a.id === ${JSON.stringify(ctx.bootingId)});
                    return { shown, booting: agent?.booting === true };`
                );
                await h.shot(SHOT(2, "booting-rename-pin"));
                rec(
                    "2. Rename and Pin through the row menu show on the booting row at once",
                    renameMenu.ok && pinMenu.ok && renamed.shown && pinned.shown && pinned.booting,
                    JSON.stringify({ renameMenu, renamed, pinMenu, pinned })
                );

                // 3. Duplicate drops the source's task and keeps its launch flags
                try {
                    const source = await makeTab(h, ctx, {
                        label: `tree-dup-${ctx.tag}`,
                        pending: true,
                        blockMeta: {
                            view: "term",
                            controller: "cmd",
                            cmd: "node",
                            "cmd:args": ["-e", "", "TASK"],
                            "agent:baseargs": ["-e", ""],
                            // the session resolver ignores a term block without a cwd, and Duplicate with it
                            "cmd:cwd": ctx.dir,
                        },
                    });
                    ctx.sourceId = source.tabId;
                } catch (e) {
                    rec("3. arrange the duplicate's source tab", false, String(e?.message ?? e));
                    return steps;
                }
                const known = JSON.stringify(ctx.tabIds);
                const dupMenu = await rowMenu(h, ctx.sourceId, "Duplicate");
                const dupId = await agentPage(
                    h,
                    `const model = agentsModel();
                    const known = ${known};
                    await until(() => !known.includes(globalStore.get(model.focusIdAtom)), ${WAIT_MS});
                    const id = globalStore.get(model.focusIdAtom);
                    return known.includes(id) ? null : id;`
                );
                let dupArgs = null;
                if (dupId) {
                    ctx.tabIds.push(dupId);
                    const tab = await waveService(h, "object", "GetObject", [`tab:${dupId}`]);
                    const block = await waveService(h, "object", "GetObject", [`block:${tab?.blockids?.[0]}`]);
                    dupArgs = block?.meta?.["cmd:args"] ?? null;
                }
                await h.shot(SHOT(3, "duplicate"));
                rec(
                    "3. Duplicate creates a block whose cmd:args is the source's baseargs, without its task",
                    dupMenu.ok && dupId != null && JSON.stringify(dupArgs) === JSON.stringify(["-e", ""]),
                    JSON.stringify({ dupMenu, dupId, dupArgs })
                );

                // 4. a terminal from New agent: "Open terminal" and focused on the Agent surface, "Add terminal" elsewhere
                await focusAgent(h, ctx.termId);
                const onAgent = await terminalFromModal(h);
                if (onAgent.focusId) ctx.tabIds.push(onAgent.focusId);
                const pane = await agentPage(
                    h,
                    `const id = ${JSON.stringify(onAgent.focusId)};
                    const shown = await until(() => document.querySelector('[data-agent-terminal="' + id + '"]')?.checkVisibility() === true, ${WAIT_MS});
                    return { shown, surface: globalStore.get(agentsModel().surfaceAtom) };`
                );
                await h.shot(SHOT(4, "terminal-focused"));
                await agentPage(h, `globalStore.set(agentsModel().surfaceAtom, "cockpit"); await nap(400); return true;`);
                const onCockpit = await terminalFromModal(h, onAgent.picked ?? "");
                await h.shot(SHOT(4, "cockpit-label"));
                rec(
                    "4. New agent's terminal reads Open terminal and is focused on the Agent surface, Add terminal on the Cockpit",
                    onAgent.surface === "agent" &&
                        onAgent.label.startsWith("Open terminal") &&
                        onAgent.closed &&
                        onAgent.focusId != null &&
                        pane.shown &&
                        pane.surface === "agent" &&
                        onCockpit.surface === "cockpit" &&
                        onCockpit.label.startsWith("Add terminal"),
                    JSON.stringify({ onAgent, pane, onCockpit })
                );
                return steps;
            },
            // best-effort, so one failed step does not strand the rest
            async teardown(h, ctx) {
                const step = async (what, fn) => {
                    try {
                        await fn();
                    } catch (e) {
                        console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
                    }
                };
                await step("close the tabs", () => closeTabs(h, ctx));
                await step("restore the roster", () => restoreRoster(h));
                await step("restore the scope and recent projects", () =>
                    agentPage(
                        h,
                        `const { recentProjectsAtom } = await mod("app/view/agents/projectsstore.ts");
                        const model = agentsModel();
                        globalStore.set(model.newAgentOpenAtom, false);
                        if (${JSON.stringify(ctx.prevScope ?? null)} != null) globalStore.set(model.projectFilterAtom, ${JSON.stringify(ctx.prevScope ?? "all")});
                        if (${JSON.stringify("prevRecent" in ctx)}) globalStore.set(recentProjectsAtom, JSON.parse(${JSON.stringify(ctx.prevRecent ?? "[]")}));
                        return true;`
                    )
                );
                if (ctx.madeProject) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.project }));
                if (ctx.dir) await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 }));
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
