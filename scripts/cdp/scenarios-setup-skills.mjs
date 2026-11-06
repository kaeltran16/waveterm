// setup-skills: the Setup surface's Skills tab over the in-page agentsync simulation in setup-fixtures.mjs
// (files under a temp root), never the real agentsync RPCs, vault or harness skills.
// Each step that needs the tab's first read starts from a reloaded page, since the tab's atoms outlive a
// surface switch; a reload drops the simulation, so a fresh one is installed after it.
import {
    arrangeSetupFixture,
    assertSetupFixtureInstalled,
    callSummary,
    controlSetupFixture,
    readSetupFixture,
    teardownSetupFixture,
} from "./setup-fixtures.mjs";
import { polishReload, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "setup-skills";
const WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const PANEL = `document.getElementById("setup-tabpanel")`;
const MATRIX = `document.querySelector('[role="table"][aria-label="Skills by harness"]')`;
const RAIL = `document.querySelector('aside[aria-label="Skill detail"]')`;
const LOAD_FAILED = `document.querySelector("[data-load-failed]")`;
const MANAGE = `[...document.querySelectorAll("[data-surface-toolbar] button")].find((b) => b.textContent.trim().startsWith("Manage "))`;
const SKILLS_FAULT = "agentsync skills unreadable (fixture fault)";
// the fixture's default dataset draws these groups (skillsmatrix.ts groupTitle)
const GROUPS = [
    "Needs a decision",
    "Differs between harnesses",
    "Same copy in 2 harnesses",
    "Only in Codex",
    "Own copy beside the vault",
    "Linked from another folder",
    "Managed by Arc",
];
// the fixture's Pi row (setup-fixtures.mjs status), as the header says it
const PI_LINE = "Pi skills: pi settings do not point at the synced skills";
// identical-copy, codex-only-skill, fm-delta: differs-body waits for a decision, the link and the stray copy never count
const MANAGE_DEFAULT = "Manage 3 skills in Arc";

const q = JSON.stringify;

async function clickSel(h, sel) {
    if (!(await h.ev(`(() => { const b = document.querySelector(${q(sel)}); if (!b) return false; b.click(); return true; })()`))) {
        throw new Error(`nothing to click at ${sel}`);
    }
}

// restores any installed simulation, reloads, installs a fresh one with the given faults, then opens Skills
async function freshSkills(h, ctx, faults = [], metrics = WIDE) {
    if (ctx.fx) {
        const fx = ctx.fx;
        ctx.fx = null;
        await teardownSetupFixture(h, fx);
    }
    await polishReload(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", metrics);
    ctx.fx = await arrangeSetupFixture(h, NAME);
    for (const f of faults) await controlSetupFixture(h, "fail", f);
    await assertSetupFixtureInstalled(h);
    await h.goto("setup");
    // the surface renders its tab strip a moment after the switch
    const tab = "#setup-tab-skills";
    if (!(await polishWaitFor(h, `!!document.querySelector(${q(tab)})`, 10000))) {
        throw new Error(`${tab} never appeared after opening setup`);
    }
    await clickSel(h, tab);
}

const groupTitles = (h) =>
    h.ev(`[...(${MATRIX}?.querySelectorAll('[role="rowgroup"]') ?? [])].map((g) => g.getAttribute("aria-label"))`);

const flatText = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;
const manageLabel = (h) => h.ev(flatText(MANAGE));
const railText = (h) => h.ev(flatText(RAIL));

// the matrix row whose name cell reads name
const rowSel = (name) =>
    `[...(${MATRIX}?.querySelectorAll('[role="row"][tabindex]') ?? [])].find((r) => r.querySelector('[role="cell"]')?.textContent.trim() === ${q(name)})`;

async function pickRow(h, name) {
    if (!(await h.ev(`(() => { const r = ${rowSel(name)}; if (!r) return false; r.click(); return true; })()`))) {
        throw new Error(`no matrix row ${name}`);
    }
    if (!(await polishWaitFor(h, `(${RAIL})?.querySelector(".font-mono")?.textContent.trim() === ${q(name)}`, 5000))) {
        throw new Error(`the rail never showed ${name}`);
    }
}

const rowCells = (h, name) =>
    h.ev(`[...((${rowSel(name)})?.querySelectorAll('[role="cell"]') ?? [])].slice(1).map((c) => ({ text: c.textContent.trim(), title: c.getAttribute("title") }))`);

// the rail radio whose title reads title
async function choose(h, title) {
    const ok = await h.ev(`(() => {
        const l = [...((${RAIL})?.querySelectorAll("label") ?? [])].find((x) => x.querySelector(".font-semibold")?.textContent.trim() === ${q(title)});
        const input = l?.querySelector('input[type="radio"]');
        if (!input) return false;
        input.click();
        return true;
    })()`);
    if (!ok) throw new Error(`no rail choice "${title}"`);
}

async function clickManage(h) {
    if (!(await h.ev(`(() => { const b = ${MANAGE}; if (!b || b.disabled) return false; b.click(); return true; })()`))) {
        throw new Error("Manage is missing or disabled");
    }
}

const infoToast = (h, text) =>
    polishWaitFor(h, `[...document.querySelectorAll('[data-notification-toast="info"]')].some((t) => t.textContent.includes(${q(text)}))`, 8000);

async function lastAdopt(h) {
    return callSummary(await readSetupFixture(h)).lastAdoptApply;
}

// the app's own module instance, as the page imported it
const CODE_PROJECT = `(async () => {
    const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
    const base = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
    const mod = (path) => import(names.filter((n) => n.endsWith("/" + path)).pop() ?? base.replace("app/store/jotaiStore.ts", path));
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { codeProjectAtom } = await mod("app/view/code/codestore.ts");
    return JSON.stringify(globalStore.get(codeProjectAtom));
})()`;

async function setupSkillsArrange(_h) {
    return { fx: null };
}

async function setupSkillsAssert(h, ctx) {
    const steps = [];
    const run = async (step, fn) => {
        try {
            const { ok, detail } = await fn();
            steps.push({ step, ok, detail });
        } catch (e) {
            steps.push({ step, ok: false, detail: String(e?.message ?? e) });
        }
    };

    await run("1. the matrix shows the fixture's groups", async () => {
        await freshSkills(h, ctx);
        const drawn = await polishWaitFor(h, `!!${MATRIX}`, 10000);
        const titles = await groupTitles(h);
        await h.shot("cdp-shots/setup-skills-main.png");
        return { ok: drawn && JSON.stringify(titles) === JSON.stringify(GROUPS), detail: { drawn, titles } };
    });

    await run("2. a failed first skills read shows the error and Retry, never Reading…; Retry draws the matrix", async () => {
        await freshSkills(h, ctx, [{ command: "agentsyncskills", message: SKILLS_FAULT, times: 1 }]);
        const shown = await polishWaitFor(h, `!!${LOAD_FAILED}`, 10000);
        const text = await h.ev(`(${PANEL}?.textContent ?? "")`);
        const retry = await h.ev(`[...${PANEL}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Retry")`);
        await h.shot("cdp-shots/setup-skills-load-failed.png");
        await h.ev(`[...${PANEL}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retry")?.click()`);
        const drawn = await polishWaitFor(h, `!!${MATRIX} && !${LOAD_FAILED}`, 10000);
        const titles = await groupTitles(h);
        return {
            ok:
                shown &&
                text.includes(SKILLS_FAULT) &&
                !text.includes("Reading…") &&
                retry &&
                drawn &&
                JSON.stringify(titles) === JSON.stringify(GROUPS),
            detail: { shown, text: text.slice(0, 300), retry, drawn, titles },
        };
    });

    await run("3. F3: the header says how Pi reaches the skills, in its warn tone; no rail says every harness", async () => {
        await freshSkills(h, ctx);
        await polishWaitFor(h, `!!${MATRIX} && !!document.querySelector("[data-pi-line]")`, 10000);
        const pi = await h.ev(`(() => { const p = document.querySelector("[data-pi-line]"); return p ? { text: p.textContent.trim(), warn: p.className.includes("text-warning-soft") } : null; })()`);
        const names = await h.ev(`[...(${MATRIX}?.querySelectorAll('[role="row"][tabindex]') ?? [])].map((r) => r.querySelector('[role="cell"]').textContent.trim())`);
        const saying = [];
        for (const n of names) {
            await pickRow(h, n);
            if (/every harness/i.test(await railText(h))) saying.push(n);
        }
        // the keep hint of the undecided skill names the present harnesses
        await pickRow(h, "differs-body");
        const rail = await railText(h);
        await h.shot("cdp-shots/setup-skills-pi-line.png");
        return {
            ok: pi?.text === PI_LINE && pi.warn && names.length > 0 && saying.length === 0 && rail.includes("Claude Code and Codex get it"),
            detail: { pi, rows: names.length, saying, rail: rail.slice(0, 400) },
        };
    });

    await run("4. F4: a link from another folder is its own row, its rail says Arc leaves links alone, and Manage does not count it", async () => {
        await freshSkills(h, ctx);
        await polishWaitFor(h, `!!${MATRIX}`, 10000);
        const group = await h.ev(`[...(${MATRIX}?.querySelectorAll('[role="rowgroup"]') ?? [])].find((g) => g.getAttribute("aria-label") === "Linked from another folder")?.querySelector('[role="row"] [role="cell"]')?.textContent.trim() ?? null`);
        const target = ctx.fx.fixture.skills.linked[0].target;
        const cells = await rowCells(h, "linked-tool");
        await pickRow(h, "linked-tool");
        const rail = await railText(h);
        const manage = await manageLabel(h);
        await h.shot("cdp-shots/setup-skills-linked.png");
        return {
            ok:
                group === "linked-tool" &&
                cells[0]?.text === "Link" &&
                cells[0]?.title === target &&
                rail.includes("Arc leaves links alone") &&
                rail.includes("never moves one into the vault") &&
                manage === MANAGE_DEFAULT,
            detail: { group, cells, target, rail: rail.slice(0, 300), manage },
        };
    });

    await run("4b. F4: a vault skill's link reads Link in the warn tone, titled with the link's target", async () => {
        const link = ctx.fx.fixture.skills.linked.find((l) => ctx.fx.fixture.skills.skills.some((k) => k.name === l.name));
        const col = ctx.fx.fixture.skills.columns.findIndex((c) => c.runtime === link.runtime);
        const cell = await h.ev(`(() => {
            const c = [...((${rowSel(link.name)})?.querySelectorAll('[role="cell"]') ?? [])].slice(1)[${col}];
            if (!c) return null;
            return {
                text: c.textContent.trim(),
                title: c.getAttribute("title"),
                warnText: c.classList.contains("text-warning-soft"),
                warnDot: !!c.querySelector(".bg-warning"),
            };
        })()`);
        const groups = await groupTitles(h);
        return {
            ok:
                cell?.text === "Link" &&
                cell.title === link.target &&
                cell.warnText &&
                cell.warnDot &&
                JSON.stringify(groups) === JSON.stringify(GROUPS),
            detail: { link, cell, groups },
        };
    });

    await run("5. F6: a vault skill's own copy has its own group; Replace raises Manage by one and the adopt sends keep vault", async () => {
        await freshSkills(h, ctx);
        await polishWaitFor(h, `!!${MATRIX}`, 10000);
        const group = await h.ev(`[...(${MATRIX}?.querySelectorAll('[role="rowgroup"]') ?? [])].find((g) => g.getAttribute("aria-label") === "Own copy beside the vault")?.querySelector('[role="row"] [role="cell"]')?.textContent.trim() ?? null`);
        await pickRow(h, "commit-helper");
        const before = await manageLabel(h);
        const rail = await railText(h);
        await choose(h, "Replace it with the vault copy");
        const raised = await polishWaitFor(h, `${flatText(MANAGE)} === "Manage 4 skills in Arc"`, 5000);
        await h.shot("cdp-shots/setup-skills-stray.png");
        await assertSetupFixtureInstalled(h);
        await clickManage(h);
        await polishWaitFor(h, `!${MANAGE}?.disabled`, 8000);
        const sent = await lastAdopt(h);
        return {
            ok:
                group === "commit-helper" &&
                before === MANAGE_DEFAULT &&
                rail.includes("Arc vault") &&
                rail.includes("Body text differs") &&
                raised &&
                sent?.keep?.["commit-helper"] === "vault",
            detail: { group, before, raised, rail: rail.slice(0, 300), sent },
        };
    });

    await run("6. F5: Leave it where it is reads Left alone, lowers Manage, is sent in skip, and the toast counts the reply", async () => {
        await freshSkills(h, ctx);
        await polishWaitFor(h, `!!${MATRIX}`, 10000);
        await pickRow(h, "identical-copy");
        await choose(h, "Leave it where it is");
        const lowered = await polishWaitFor(h, `${flatText(MANAGE)} === "Manage 2 skills in Arc"`, 5000);
        const cells = (await rowCells(h, "identical-copy")).map((c) => c.text);
        await assertSetupFixtureInstalled(h);
        await clickManage(h);
        // codex-only-skill and fm-delta move, differs-body waits, identical-copy was skipped
        const toast = await infoToast(h, "Moved 2 skills into the vault · 1 wait for a decision · 1 left alone");
        await h.shot("cdp-shots/setup-skills-left-alone.png");
        const sent = await lastAdopt(h);
        return {
            ok: lowered && cells.slice(0, 2).every((t) => t === "Left alone") && JSON.stringify(sent?.skip) === q(["identical-copy"]) && toast,
            detail: { lowered, cells, sent, toast },
        };
    });

    await run("6b. F5: in a snapshot store the toast says nothing moved and what would have", async () => {
        await freshSkills(h, ctx);
        await polishWaitFor(h, `!!${MATRIX}`, 10000);
        await controlSetupFixture(h, "snapshotStore", { on: true });
        await pickRow(h, "identical-copy");
        await choose(h, "Leave it where it is");
        await assertSetupFixtureInstalled(h);
        await clickManage(h);
        const toast = await infoToast(h, "Snapshot: nothing moved (would move 2)");
        const sent = await lastAdopt(h);
        return { ok: toast && sent?.outcome === "dryrun", detail: { toast, sent } };
    });

    await run("7. F18: Preview SKILL.md shows the file in the rail; Setup stays and Code's project is untouched", async () => {
        await freshSkills(h, ctx);
        await polishWaitFor(h, `!!${MATRIX}`, 10000);
        const surface = await h.activeSurfaceLabel();
        const project = await h.ev(CODE_PROJECT);
        await pickRow(h, "identical-copy");
        await h.ev(`[...(${RAIL})?.querySelectorAll("button") ?? []].find((b) => b.textContent.trim() === "Preview SKILL.md")?.click()`);
        const shown = await polishWaitFor(h, `(${RAIL})?.textContent.includes("identical-copy shared body")`, 8000);
        await h.shot("cdp-shots/setup-skills-preview.png");
        const after = { surface: await h.activeSurfaceLabel(), project: await h.ev(CODE_PROJECT), panel: await h.ev(`!!${PANEL}`) };
        return {
            ok: shown && after.surface === surface && after.project === project && after.panel,
            detail: { shown, surface, project, after },
        };
    });

    await run("8. F22: the vault card keeps the skill file's name at its end", async () => {
        await freshSkills(h, ctx);
        await polishWaitFor(h, `!!${MATRIX}`, 10000);
        await pickRow(h, "vault-drift");
        const card = await h.ev(`(() => {
            const c = (${RAIL})?.querySelector("[data-vault-card]");
            const tail = c?.querySelector("[title] > span:last-child");
            if (!c || !tail) return null;
            const box = c.getBoundingClientRect();
            const r = tail.getBoundingClientRect();
            return { text: c.textContent.trim(), tail: tail.textContent, inside: r.right <= box.right + 0.5 && r.width > 0 };
        })()`);
        return { ok: card?.text.endsWith("SKILL.md") && card.tail === "SKILL.md" && card.inside, detail: card };
    });

    await run("9. at 1000x700 the matrix and the rail still fit, with no horizontal overflow", async () => {
        await freshSkills(h, ctx, [], NARROW);
        await polishWaitFor(h, `!!${MATRIX} && !!${RAIL}`, 10000);
        await pickRow(h, "commit-helper");
        const fit = await h.ev(`(() => {
            const m = ${MATRIX}.getBoundingClientRect();
            const r = ${RAIL}.getBoundingClientRect();
            const p = ${PANEL};
            // the table clips its grid, so a column pushed past its edge is overflow too
            const heads = [...${MATRIX}.querySelectorAll('[role="columnheader"]')];
            const last = heads[heads.length - 1].getBoundingClientRect();
            return {
                vw: window.innerWidth,
                doc: document.documentElement.scrollWidth,
                panel: [p.scrollWidth, p.clientWidth],
                matrix: [Math.round(m.left), Math.round(m.right)],
                lastColumnRight: Math.round(last.right),
                skillColumn: Math.round(heads[0].getBoundingClientRect().width),
                rail: [Math.round(r.left), Math.round(r.right)],
            };
        })()`);
        await h.shot("cdp-shots/setup-skills-narrow.png");
        await h.cdp("Emulation.setDeviceMetricsOverride", WIDE);
        return {
            ok:
                fit.doc <= fit.vw &&
                fit.panel[0] <= fit.panel[1] &&
                fit.lastColumnRight <= fit.matrix[1] &&
                fit.skillColumn > 0 &&
                fit.matrix[1] <= fit.rail[0] + 0.5 &&
                fit.rail[1] <= fit.vw,
            detail: fit,
        };
    });

    return steps;
}

async function setupSkillsTeardown(h, ctx) {
    const failed = [];
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            failed.push(`${what}: ${e?.message ?? e}`);
        }
    };
    if (ctx.fx) await step("restore the setup fixture", () => teardownSetupFixture(h, ctx.fx));
    // the tab's atoms still hold fixture data; a reload drops them
    await step("reload", () => polishReload(h));
    await step("return to the cockpit", () => h.goto("cockpit"));
    if (failed.length > 0) throw new Error(`${NAME} teardown: ${failed.join("; ")}`);
}

export const setupSkills = {
    name: NAME,
    surface: "setup",
    arrange: setupSkillsArrange,
    assert: setupSkillsAssert,
    teardown: setupSkillsTeardown,
};
