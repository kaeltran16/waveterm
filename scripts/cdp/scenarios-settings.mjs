// Settings and Setup scenarios, remote access included.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPage } from "./attach.mjs";
import {
    MEMORY_PROJECTS,
    MEMORY_SHARED_REPO,
    buildMemoryFixture,
    memoryBackupDir,
    memoryBackupsUnder,
    memoryStatePath,
    settleMemoryStates,
    sha256File,
    writeMemoryBackups,
    writeMemoryStates,
} from "./memory-fixtures.mjs";
import {
    MIN_FONT_PX,
    floorStep,
    lookEval,
    paintEval,
    polishNap,
    polishReload,
    polishWaitFor,
    setInputExpr,
    skipStep,
    waitForProjectInConfig,
} from "./scenarios-shared.mjs";

// --- settings-headless: Settings > Headless AI has no Radar audit row and no Mid model row ------------------
const HEADLESS_PANE = `document.querySelector('[data-settings-section="headless"]')`;

export const settingsHeadless = {
    name: "settings-headless",
    surface: "settings",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        await h.goto("settings");
        await h.ev(`document.querySelector('[data-section="headless"]')?.click()`);
        const paneUp = await polishWaitFor(h, `${HEADLESS_PANE} != null`, 5000);
        rec("1. Settings opens on the Headless AI section", paneUp, `pane=${paneUp}`);

        const radar = await h.ev(`(() => {
            const pane = ${HEADLESS_PANE};
            if (!pane) return null;
            return {
                row: pane.querySelector('[data-setting-row="headless.radaraudit"]') != null,
                text: /radar/i.test(pane.textContent || ""),
            };
        })()`);
        rec("2. the section has no Radar audit row and no mention of Radar", radar != null && radar.row === false && radar.text === false, JSON.stringify(radar));

        const mid = await h.ev(`(() => {
            const pane = ${HEADLESS_PANE};
            if (!pane) return null;
            return {
                row: pane.querySelector('[data-setting-row="headless.mid"]') != null,
                text: /mid model/i.test(pane.textContent || ""),
                rows: [...pane.querySelectorAll("[data-setting-row]")].map((r) => r.getAttribute("data-setting-row")),
            };
        })()`);
        rec(
            "3. the section has no Mid model row and still lists headless.cheap",
            mid != null && mid.row === false && mid.text === false && mid.rows.includes("headless.cheap"),
            JSON.stringify(mid)
        );
        await h.shot("cdp-shots/settings-headless.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- settings-plan-skill: the Plan skill row on Settings > Run defaults --------------------------------------
// The key is cleared in arrange so step 1 sees the shipped default whatever the dev app had, and put back in
// teardown. The Segmented control has no state attribute, so the selected option is the one carrying the
// accent background class.
const PLAN_SKILL_KEY = "run:planskill";
const PLAN_SKILL_DEFAULT = "plan";
const PLAN_SKILL_PANE = `document.querySelector('[data-settings-section="run"]')`;
const PLAN_SKILL_ROW = `${PLAN_SKILL_PANE}?.querySelector('[data-setting-row="run.planskill"]')`;
const PLAN_SKILL_WAIT_MS = 5000;
const planSkillOptions = (h) =>
    h.ev(`(() => {
        const row = ${PLAN_SKILL_ROW};
        if (!row) return null;
        return [...row.querySelectorAll("button")].map((b) => ({
            label: (b.textContent || "").trim(),
            selected: b.className.includes("bg-accentbg"),
        }));
    })()`);
const planSkillClick = (h, label) =>
    h.ev(`[...(${PLAN_SKILL_ROW}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim() === ${JSON.stringify(label)})?.click()`);
const planSkillStored = async (h) => ((await h.rpc("getfullconfig", null))?.settings ?? {})[PLAN_SKILL_KEY];
async function planSkillWaitStored(h, want) {
    const deadline = Date.now() + PLAN_SKILL_WAIT_MS;
    let value = await planSkillStored(h);
    while (value !== want && Date.now() < deadline) {
        await polishNap(150);
        value = await planSkillStored(h);
    }
    return value;
}

export const settingsPlanSkill = {
    name: "settings-plan-skill",
    surface: "settings",
    async arrange(h) {
        const prior = await planSkillStored(h);
        await h.rpc("setconfig", { [PLAN_SKILL_KEY]: null });
        return { prior };
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        await h.goto("cockpit");
        await h.goto("settings");
        await h.ev(`document.querySelector('[data-section="run"]')?.click()`);
        await polishWaitFor(h, `${PLAN_SKILL_ROW} != null`, PLAN_SKILL_WAIT_MS);
        const initial = await planSkillOptions(h);
        rec(
            "1. Settings > Run defaults shows the Plan skill row with both options and arc:plan selected",
            JSON.stringify(initial) ===
                JSON.stringify([
                    { label: "arc:plan", selected: true },
                    { label: "writing-plans", selected: false },
                ]),
            JSON.stringify(initial)
        );

        await planSkillClick(h, "writing-plans");
        const stored = await planSkillWaitStored(h, "writing-plans");
        await polishNap(200);
        const chosen = await planSkillOptions(h);
        rec(
            "2. choosing writing-plans selects it and the config reads run:planskill = writing-plans",
            stored === "writing-plans" && chosen?.find((o) => o.selected)?.label === "writing-plans",
            JSON.stringify({ stored, chosen })
        );

        await planSkillClick(h, "arc:plan");
        const back = await planSkillWaitStored(h, PLAN_SKILL_DEFAULT);
        await polishNap(200);
        const selected = await planSkillOptions(h);
        rec(
            "3. choosing arc:plan selects it back",
            back === PLAN_SKILL_DEFAULT && selected?.find((o) => o.selected)?.label === "arc:plan",
            JSON.stringify({ back, selected })
        );
        await h.ev(`${PLAN_SKILL_ROW}?.scrollIntoView({ block: "center" })`);
        await polishNap(200);
        await h.shot("cdp-shots/settings-plan-skill.png");
        return steps;
    },
    async teardown(h, ctx) {
        // null drops the override, so the shipped default takes over again
        const restore = ctx.prior === PLAN_SKILL_DEFAULT ? null : (ctx.prior ?? null);
        await h.rpc("setconfig", { [PLAN_SKILL_KEY]: restore });
        await h.goto("cockpit");
    },
};

// --- settings-claude-account: Settings > Claude account lists saved logins -----------------------------
// The dev app reads the real ~/.claude, so the live row is whatever the user has. Two fake saved accounts
// are seeded into the dev app's own secret store (one valid, one expired) to show the other states. It never
// clicks Switch: that would rewrite the real ~/.claude. Remove touches only the secret store. Error notes
// render under the list, so their absence is checked in the whole section pane.
const CLAUDE_ACCT_PANE = `document.querySelector('[data-settings-section="claudeaccount"]')`;
const CLAUDE_ACCT_ERROR = `${CLAUDE_ACCT_PANE}?.querySelector('[data-testid="claude-account-error"]')`;
const CLAUDE_ACCT_CHECK = `${CLAUDE_ACCT_PANE}?.querySelector('[data-testid="claude-account-check"]')`;
const CLAUDE_ACCT_SEEDS = {
    valid: { uuid: "00000000-0000-4000-8000-0000000a0001", email: "seed-valid@example.com", expiresInMs: 86_400_000 },
    expired: { uuid: "00000000-0000-4000-8000-0000000a0002", email: "seed-expired@example.com", expiresInMs: -86_400_000 },
};
// pkg/jarvis claudeAccountSecretName
const claudeAcctSecretName = (uuid) => `claudeacct_${uuid.replaceAll("-", "_")}`;
const claudeAcctRow = (uuid) => `${CLAUDE_ACCT_PANE}?.querySelector('[data-testid="claude-account-row"][data-account-uuid="${uuid}"]')`;
const claudeAcctRowState = (h, uuid) =>
    h.ev(`(() => {
        const r = ${claudeAcctRow(uuid)};
        if (!r) return null;
        const sw = r.querySelector('[data-testid="claude-account-switch"]');
        const rm = r.querySelector('[data-testid="claude-account-remove"]');
        const exp = r.querySelector('[data-testid="claude-account-expired"]');
        return {
            active: r.hasAttribute("data-active"),
            text: (r.textContent || "").trim(),
            switch: sw ? { disabled: sw.disabled } : null,
            remove: rm ? { disabled: rm.disabled } : null,
            expired: exp ? { text: (exp.textContent || "").trim(), color: getComputedStyle(exp).color } : null,
        };
    })()`);

// the setsecrets payload that saves each seed as a Claude.ai login
function claudeAcctSecrets(seeds) {
    const now = Date.now();
    const secrets = {};
    for (const s of seeds) {
        secrets[claudeAcctSecretName(s.uuid)] = JSON.stringify({
            oauth: {
                accessToken: "seed-access",
                refreshToken: "seed-refresh",
                expiresAt: now + s.expiresInMs,
                refreshTokenExpiresAt: now + s.expiresInMs,
                scopes: ["user:inference"],
                subscriptionType: "pro",
            },
            account: { accountUuid: s.uuid, emailAddress: s.email, organizationName: "Seed Org" },
            lastusedts: now - 3 * 3600_000,
        });
    }
    return secrets;
}

export const settingsClaudeAccount = {
    name: "settings-claude-account",
    surface: "settings",
    async arrange(h) {
        const secrets = claudeAcctSecrets(Object.values(CLAUDE_ACCT_SEEDS));
        await h.rpc("setsecrets", secrets);
        return { seedNames: Object.keys(secrets) };
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const { valid, expired } = CLAUDE_ACCT_SEEDS;

        await h.goto("cockpit");
        await h.goto("settings");
        await h.ev(`document.querySelector('[data-section="claudeaccount"]')?.click()`);
        const listed = await polishWaitFor(h, `${claudeAcctRow(valid.uuid)} != null && ${claudeAcctRow(expired.uuid)} != null`, 10_000);
        const top = await h.ev(`(() => {
            const pane = ${CLAUDE_ACCT_PANE};
            if (!pane) return null;
            return {
                active: pane.querySelector('[data-testid="claude-account-row"][data-active]') != null,
                nologin: pane.querySelector('[data-testid="claude-account-nologin"]') != null,
                check: ${CLAUDE_ACCT_CHECK} != null,
                rows: pane.querySelectorAll('[data-testid="claude-account-row"]').length,
                error: (${CLAUDE_ACCT_ERROR}?.textContent || "").trim() || null,
            };
        })()`);
        rec(
            "1. the Accounts row shows an active account or the no-login note, and Check now",
            listed && top != null && (top.active || top.nologin) && top.check,
            JSON.stringify(top)
        );

        const v = await claudeAcctRowState(h, valid.uuid);
        rec(
            "2. the valid seed is not active, shows its last use, and offers Switch and Remove",
            v != null && !v.active && v.text.includes("last used") && v.switch?.disabled === false && v.remove?.disabled === false,
            JSON.stringify(v)
        );

        const e = await claudeAcctRowState(h, expired.uuid);
        const warning = await h.ev(`(() => {
            const probe = document.createElement("span");
            probe.style.color = "var(--color-warning)";
            document.body.appendChild(probe);
            const c = getComputedStyle(probe).color;
            probe.remove();
            return c;
        })()`);
        rec(
            "3. the expired seed shows the expired line in the warning color, a disabled Switch and an enabled Remove",
            e != null &&
                e.expired?.text === "Sign-in expired. Run /login with this account to save it again." &&
                e.expired.color === warning &&
                e.switch?.disabled === true &&
                e.remove?.disabled === false,
            `${JSON.stringify(e)} warning=${warning}`
        );
        await h.ev(`${CLAUDE_ACCT_PANE}?.querySelector('[data-setting-row="claudeaccount.accounts"]')?.scrollIntoView({ block: "center" })`);
        await polishNap(200);
        await h.shot("cdp-shots/settings-claude-account.png");
        const avatars = await paintEval(h, `
            const rows = [...(${CLAUDE_ACCT_PANE}?.querySelectorAll('[data-testid="claude-account-row"]:not([data-active])') ?? [])];
            return rows.map((r) => {
                const bg = getComputedStyle(r.firstElementChild).backgroundColor;
                return { bg, raw: rawOverlay(bg) };
            });
        `);
        rec("3b. an inactive account's avatar has no raw white or black overlay background", avatars.length > 0 && avatars.every((a) => !a.raw), JSON.stringify(avatars));
        steps.push(
            await floorStep(h, `3c. no visible text in the accounts list is under ${MIN_FONT_PX}px`, `${CLAUDE_ACCT_PANE}?.querySelector('[data-setting-row="claudeaccount.accounts"]')`)
        );

        await h.ev(`${CLAUDE_ACCT_CHECK}?.click()`);
        const noNew = await polishWaitFor(h, `${CLAUDE_ACCT_PANE}?.querySelector('[data-testid="claude-account-nonew"]') != null`, 10_000);
        const checkErr = await h.ev(`(${CLAUDE_ACCT_ERROR}?.textContent || "").trim() || null`);
        rec("4. Check now finds no new login and shows no error", noNew && checkErr == null, `nonew=${noNew} error=${checkErr}`);

        for (const [n, seed] of [
            ["5", valid],
            ["6", expired],
        ]) {
            await h.ev(`${claudeAcctRow(seed.uuid)}?.querySelector('[data-testid="claude-account-remove"]')?.click()`);
            const gone = await polishWaitFor(h, `${claudeAcctRow(seed.uuid)} == null`, 10_000);
            const err = await h.ev(`(${CLAUDE_ACCT_ERROR}?.textContent || "").trim() || null`);
            rec(`${n}. Remove takes ${seed.email} off the list with no error`, gone && err == null, `gone=${gone} error=${err}`);
        }

        const rest = await h.ev(`(() => {
            const pane = ${CLAUDE_ACCT_PANE};
            return {
                rows: pane ? pane.querySelectorAll('[data-testid="claude-account-row"]').length : null,
                hint: pane?.querySelector('[data-testid="claude-account-hint"]') != null,
            };
        })()`);
        rec(
            "7. with one account left the one-account hint shows",
            rest.rows !== 1 || rest.hint,
            JSON.stringify(rest)
        );
        await h.ev(`${CLAUDE_ACCT_PANE}?.querySelector('[data-setting-row="claudeaccount.accounts"]')?.scrollIntoView({ block: "center" })`);
        await polishNap(200);
        await h.shot("cdp-shots/settings-claude-account-one.png");
        return steps;
    },
    async teardown(h, ctx) {
        // deleting a missing secret is a no-op, so this is safe after the Remove steps
        await h.rpc("setsecrets", Object.fromEntries((ctx.seedNames ?? []).map((n) => [n, null])));
        await h.goto("cockpit");
    },
};

// --- settings-claude-apikey: the API key row beside the Claude.ai accounts ----------------------------------
// A fake key is seeded straight into the dev app's secret store, so the row shows without a real key. It never
// clicks Switch, which writes the dev app's claude settings.json. Save with a bogus key must fail: the Anthropic
// API refuses it, or cannot be reached, and either way nothing is stored.
const CLAUDE_APIKEY_SECRET = "claudeapikey"; // pkg/jarvis ClaudeApiKeySecretName
const CLAUDE_APIKEY_SEED = "sk-ant-seed-0000abcd";
const CLAUDE_APIKEY_ROW = `${CLAUDE_ACCT_PANE}?.querySelector('[data-testid="claude-apikey-row"]')`;
const CLAUDE_APIKEY_INPUT = `${CLAUDE_ACCT_PANE}?.querySelector('[data-testid="claude-apikey-input"]')`;
const CLAUDE_APIKEY_SAVE = `${CLAUDE_ACCT_PANE}?.querySelector('[data-testid="claude-apikey-save"]')`;
// above the app's 20 s save timeout, so a slow API still lands as its error note
const CLAUDE_APIKEY_SAVE_WAIT_MS = 25_000;
const claudeApiKeyRowState = (h) =>
    h.ev(`(() => {
        const r = ${CLAUDE_APIKEY_ROW};
        if (!r) return null;
        const pane = ${CLAUDE_ACCT_PANE};
        const sw = r.querySelector('[data-testid="claude-apikey-switch"]');
        const rm = r.querySelector('[data-testid="claude-apikey-remove"]');
        const rows = [...pane.querySelectorAll('[data-testid="claude-account-row"], [data-testid="claude-apikey-row"]')];
        const accounts = [...pane.querySelectorAll('[data-testid="claude-account-row"]')];
        return {
            active: r.hasAttribute("data-active"),
            text: (r.textContent || "").replace(/\\s+/g, " ").trim(),
            first: rows[0] === r,
            afterAccounts: accounts.every((a) => a.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING),
            switch: sw ? { disabled: sw.disabled } : null,
            remove: rm ? { disabled: rm.disabled } : null,
        };
    })()`);
const openClaudeAccount = async (h) => {
    await h.goto("cockpit");
    await h.goto("settings");
    await h.ev(`document.querySelector('[data-section="claudeaccount"]')?.click()`);
};

export const settingsClaudeApiKey = {
    name: "settings-claude-apikey",
    surface: "settings",
    async arrange(h) {
        await h.rpc("setsecrets", { [CLAUDE_APIKEY_SECRET]: CLAUDE_APIKEY_SEED });
        // verify.mjs runs teardown only for a defined ctx
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        await openClaudeAccount(h);
        const listed = await polishWaitFor(h, `${CLAUDE_APIKEY_ROW} != null`, 10_000);
        const row = await claudeApiKeyRowState(h);
        rec(
            "1. the API key row reads its last four and pay per token, is not active, sits after every account, and offers Switch and Remove",
            listed &&
                row != null &&
                row.text.includes("API key · ends in …abcd") &&
                row.text.includes("pay per token") &&
                !row.active &&
                row.afterAccounts &&
                row.switch?.disabled === false &&
                row.remove?.disabled === false,
            JSON.stringify(row)
        );

        const field = await h.ev(`(() => {
            const i = ${CLAUDE_APIKEY_INPUT};
            const b = ${CLAUDE_APIKEY_SAVE};
            return { type: i?.type ?? null, value: i?.value ?? null, saveDisabled: b?.disabled ?? null };
        })()`);
        rec("2. the key field is masked, and Save is disabled while it is empty", field.type === "password" && field.value === "" && field.saveDisabled === true, JSON.stringify(field));

        await h.ev(setInputExpr(CLAUDE_APIKEY_INPUT, "sk-ant-bogus"));
        await polishWaitFor(h, `${CLAUDE_APIKEY_SAVE}?.disabled === false`, 2_000);
        await h.ev(`${CLAUDE_APIKEY_SAVE}?.click()`);
        const refused = await polishWaitFor(h, `${CLAUDE_ACCT_ERROR} != null`, CLAUDE_APIKEY_SAVE_WAIT_MS);
        const after = await h.ev(`({
            error: (${CLAUDE_ACCT_ERROR}?.textContent || "").trim() || null,
            row: (${CLAUDE_APIKEY_ROW}?.textContent || "").replace(/\\s+/g, " ").trim(),
        })`);
        rec("3. saving a bogus key shows an error note and keeps the saved key", refused && after.row.includes("ends in …abcd"), JSON.stringify(after));

        await h.ev(`${CLAUDE_ACCT_PANE}?.querySelector('[data-setting-row="claudeaccount.accounts"]')?.scrollIntoView({ block: "center" })`);
        await polishNap(200);
        await h.shot("cdp-shots/settings-claude-apikey.png");
        steps.push(
            await floorStep(h, `4. no visible text in the accounts list is under ${MIN_FONT_PX}px`, `${CLAUDE_ACCT_PANE}?.querySelector('[data-setting-row="claudeaccount.accounts"]')`)
        );

        await h.ev(`${CLAUDE_APIKEY_ROW}?.querySelector('[data-testid="claude-apikey-remove"]')?.click()`);
        const gone = await polishWaitFor(h, `${CLAUDE_APIKEY_ROW} == null`, 10_000);
        const err = await h.ev(`(${CLAUDE_ACCT_ERROR}?.textContent || "").trim() || null`);
        rec("5. Remove takes the API key row off the list with no error", gone && err == null, `gone=${gone} error=${err}`);
        return steps;
    },
    async teardown(h) {
        await h.rpc("setsecrets", { [CLAUDE_APIKEY_SECRET]: null });
        await h.goto("cockpit");
    },
};

// --- settings-claude-apikey-switch: Switch to the API key and back ----------------------------------------
// Switch writes apiKeyHelper into claude's settings.json, so this runs only on a dev app whose CLAUDE_CONFIG_DIR
// is a throwaway dir (Final's --isolate-claude-config, or a dev app started by hand with it set): on the default
// path it would move the user's real claude sessions onto the fake key.
export const settingsClaudeApiKeySwitch = {
    name: "settings-claude-apikey-switch",
    surface: "settings",
    async arrange(h) {
        const listed = await h.rpc("claudeaccounts");
        const path = listed?.apikey?.settingspath ?? "";
        const real = join(homedir(), ".claude", "settings.json");
        if (path === "" || path.toLowerCase() === real.toLowerCase()) {
            throw new Error(
                `refusing: settings.json is the user's real ${path || real}; start the dev app with CLAUDE_CONFIG_DIR set to a temp dir`
            );
        }
        const seed = CLAUDE_ACCT_SEEDS.valid;
        await h.rpc("setsecrets", { [CLAUDE_APIKEY_SECRET]: CLAUDE_APIKEY_SEED, ...claudeAcctSecrets([seed]) });
        await openClaudeAccount(h);
        if (!(await polishWaitFor(h, `${CLAUDE_APIKEY_ROW} != null && ${claudeAcctRow(seed.uuid)} != null`, 10_000))) {
            throw new Error("the API key row or the seeded account never listed");
        }
        await h.ev(`${CLAUDE_APIKEY_ROW}?.querySelector('[data-testid="claude-apikey-switch"]')?.click()`);
        await polishWaitFor(h, `${CLAUDE_APIKEY_ROW}?.hasAttribute("data-active") || ${CLAUDE_ACCT_ERROR} != null`, 10_000);
        return { seed };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const { seed } = ctx;

        // verify.mjs's goto between arrange and assert may have reset the section
        await openClaudeAccount(h);
        await polishWaitFor(h, `${CLAUDE_APIKEY_ROW}?.hasAttribute("data-active") || ${CLAUDE_ACCT_ERROR} != null`, 10_000);
        const row = await claudeApiKeyRowState(h);
        const acct = await claudeAcctRowState(h, seed.uuid);
        const err = await h.ev(`(${CLAUDE_ACCT_ERROR}?.textContent || "").trim() || null`);
        rec(
            "1. the active API key row is first, reads Active with no Remove, and the seeded account offers Switch",
            row != null && row.first && row.active && row.text.includes("Active") && row.remove == null && acct?.switch?.disabled === false && err == null,
            JSON.stringify({ row, acct, err })
        );

        const meter = `document.querySelector('[data-usage-meters] [data-usage-apikey]')`;
        const meterOk = await polishWaitFor(h, `(${meter}?.textContent || "").trim() === "API key"`, 10_000);
        rec("2. the app-bar usage meter reads API key", meterOk, JSON.stringify(await h.ev(`(${meter}?.textContent || "").trim() || null`)));

        await h.goto("usage");
        const card = `document.querySelector('[data-usage-scopes] [data-usage-harness="claude"]')`;
        const cardOk = await polishWaitFor(h, `(${card}?.firstElementChild?.lastElementChild?.textContent || "").trim() === "API key"`, 10_000);
        const cardState = await h.ev(`(() => {
            const c = ${card};
            if (!c) return null;
            return { pill: (c.firstElementChild?.lastElementChild?.textContent || "").trim(), bars: c.querySelectorAll("[data-usage-limit]").length };
        })()`);
        rec("3. the Usage surface's claude card pill reads API key and it shows no quota bars", cardOk && cardState?.bars === 0, JSON.stringify(cardState));

        await openClaudeAccount(h);
        await polishWaitFor(h, `${claudeAcctRow(seed.uuid)} != null`, 10_000);
        await h.ev(`${claudeAcctRow(seed.uuid)}?.querySelector('[data-testid="claude-account-switch"]')?.click()`);
        const back = await polishWaitFor(h, `${CLAUDE_APIKEY_ROW} != null && !${CLAUDE_APIKEY_ROW}.hasAttribute("data-active")`, 10_000);
        const listed = await h.rpc("claudeaccounts");
        const backErr = await h.ev(`(${CLAUDE_ACCT_ERROR}?.textContent || "").trim() || null`);
        rec(
            "4. switching to the seeded account turns the API key off, in the row and in the account list",
            back && listed?.apikey?.active === false && backErr == null,
            JSON.stringify({ back, apikey: listed?.apikey, error: backErr })
        );
        return steps;
    },
    // runs only once arrange passed its refusal, so the settings.json it may switch back is the throwaway one
    async teardown(h, ctx) {
        const { seed } = ctx;
        // a run that failed before step 4 leaves the helper in the throwaway settings.json; switching to the seed
        // removes it, so the dev app's quota displays do not stay on the API key
        try {
            const listed = await h.rpc("claudeaccounts");
            if (listed?.apikey?.active) await h.rpc("claudeaccountswitch", { accountuuid: seed.uuid });
        } catch (e) {
            console.log(`settings-claude-apikey-switch teardown: could not switch off the API key: ${e?.message ?? e}`);
        }
        await h.rpc("setsecrets", { [CLAUDE_APIKEY_SECRET]: null, [claudeAcctSecretName(seed.uuid)]: null });
        await h.goto("cockpit");
    },
};

// --- settings-storage: Settings > Storage over the DEV fixtures (storagedevmock.ts) -----------------------
// Every state is a fixture: in fixture mode no action reaches wavesrv, it lands on window.__storageLastAction, so
// no step deletes or creates a real file. The fixture is set before the section opens, so its auto-scan never
// fires against an empty result. Section content is scoped to its pane, the header's buttons and the index row
// to their own data attributes, and each dialog to its panel's data-testid.
const STORAGE_PANE = `document.querySelector('[data-settings-section="storage"]')`;
const STORAGE_NAV = `document.querySelector('[data-section="storage"]')`;
const STORAGE_CLEAR = `document.querySelector('[data-storage-clear]')`;
const STORAGE_RESCAN = `document.querySelector('[data-storage-rescan]')`;
const STORAGE_CONFIRM = `document.querySelector('[data-testid="storage-confirm"]')`;
const STORAGE_DELETE_CONFIRM = `document.querySelector('[data-testid="storage-delete-confirm"]')`;
// storagefixtures.ts: the paths are the fixture machine's, never this one's
const STORAGE_WT = String.raw`C:\Users\arc\AppData\Local\arc-wt`;
const STORAGE_LEGACY = String.raw`C:\Users\arc\IdeaProjects\waveterm\.waveterm\worktrees`;
const STORAGE_SIEM = String.raw`C:\Users\arc\IdeaProjects\cyber_anomaly_detector`;
const STORAGE_SKIPPED_ID = `legacytree:${STORAGE_LEGACY}\\9e473bf8-e50f-48e2-9a4d-bfb1b79dddcc`;
const STORAGE_SKIPPED_TIP = "ad962fe1b3c4d5e6f708192a3b4c5d6e7f809a1b";
const STORAGE_LIVE_ROW = `runtree:${STORAGE_WT}\\dca34385`;
const STORAGE_LIVE_RUN = "dca34385-7b2e-4c1a-9f3d-2e8b6a1c4d70";
const STORAGE_HELD_ROW = `runtree:${STORAGE_WT}\\3425249d`;
// the run-transcripts rows: one run the fixture store knows, one it does not
const STORAGE_KNOWN_TRANSCRIPTS = "runtranscripts:4b7e2a91";
const STORAGE_KNOWN_TRANSCRIPTS_TITLE = "Clear run-tree transcripts, keep Usage history";
const STORAGE_UNKNOWN_TRANSCRIPTS = "runtranscripts:c03f9e12";
// clearPlan(STORAGE_SCENARIOS.storage).ids
const STORAGE_CLEAR_IDS = [
    ...["bd67b1fe", "3425249d", "009152b3", "866e3b50", "a6cf3f86"].map((k) => `runtree:${STORAGE_WT}\\${k}`),
    `legacygroup:${STORAGE_LEGACY}`,
    `branch:${STORAGE_SIEM}:refs/heads/wave/021cb57c-bf17-4c5c-9f41-ee7373a2cc11`,
    `branch:${STORAGE_SIEM}:refs/heads/wave/f15cd1a3-d509-48b6-b505-2155fee20b96`,
    String.raw`finalout:C:\Users\arc\AppData\Local\Temp\arc-final-*`,
    String.raw`finalout:C:\Users\arc\AppData\Local\arc-final-out-*`,
    STORAGE_KNOWN_TRANSCRIPTS,
    STORAGE_UNKNOWN_TRANSCRIPTS,
];
const STORAGE_RUN_GONE = "That run no longer exists";
const storageRow = (id) =>
    `[...(${STORAGE_PANE}?.querySelectorAll('[data-storage-row]') ?? [])].find((r) => r.getAttribute("data-storage-row") === ${JSON.stringify(id)})`;
// a dialog's button by its label's start; the label is followed by its key hint
const storageDialogButton = (dialog, label) =>
    `[...(${dialog}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim().startsWith(${JSON.stringify(label)}))`;
const storageText = (expr) => `((${expr})?.textContent || "").trim()`;
const storageAction = (h) => h.ev(`window.__storageLastAction ?? null`);
const storageResetAction = (h) => h.ev(`(window.__storageLastAction = undefined, true)`);
const storageSet = (h, name) => h.ev(`(window.__setStorageScenario(${JSON.stringify(name)}), true)`);

export const settingsStorage = {
    name: "settings-storage",
    surface: "settings",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/settings-storage-${n}.png`);
        const settle = () => polishNap(300);

        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("settings");
        const mock = await polishWaitFor(h, `typeof window.__setStorageScenario === "function"`, 10000);
        if (!mock) {
            rec("1. storage: the DEV mock is installed with the Settings surface", false, "window.__setStorageScenario never appeared");
            return steps;
        }
        await storageSet(h, "storage");
        await h.ev(`${STORAGE_NAV}?.click()`);
        await polishWaitFor(h, `${STORAGE_PANE}?.querySelector('[data-storage-group]') != null`, 5000);
        await settle();
        await shot("1-storage");
        const main = await h.ev(`(() => {
            const pane = ${STORAGE_PANE};
            if (!pane) return null;
            return {
                groups: [...pane.querySelectorAll('[data-storage-group]')].map((g) => g.getAttribute("data-storage-group")),
                skippedDelete: (${storageRow(STORAGE_SKIPPED_ID)})?.querySelector('[data-storage-delete]') != null,
                clear: ${storageText(STORAGE_CLEAR)},
                nav: ${storageText(STORAGE_NAV)},
                autoScan: window.__storageLastAction ?? null,
                transcripts: [${JSON.stringify(STORAGE_KNOWN_TRANSCRIPTS)}, ${JSON.stringify(STORAGE_UNKNOWN_TRANSCRIPTS)}].map((id) => {
                    const r = [...(pane.querySelector('[data-storage-group="left"]')?.querySelectorAll('[data-storage-row]') ?? [])]
                        .find((el) => el.getAttribute("data-storage-row") === id);
                    return r ? { owner: (r.children[1]?.firstElementChild?.textContent || "").trim() } : null;
                }),
            };
        })()`);
        rec(
            "1. storage: three groups, the 9e473bf8 row offers Delete anyway, both run-transcripts rows list in Left over (one by run title, one by prefix), Clear reads 326 MB, the index row says left over",
            main != null &&
                JSON.stringify(main.groups) === JSON.stringify(["left", "inuse", "kept"]) &&
                main.skippedDelete &&
                main.transcripts[0]?.owner === STORAGE_KNOWN_TRANSCRIPTS_TITLE &&
                main.transcripts[1]?.owner === "c03f9e12" &&
                main.clear === "Clear 326 MB left over" &&
                main.nav.includes("left over") &&
                main.autoScan == null,
            JSON.stringify(main)
        );
        // the populated pane: the muted tag chips sit on the edge ramp, and nothing in it paints a raw overlay
        const paint = await paintEval(h, `
            const pane = ${STORAGE_PANE};
            const all = pane ? [pane, ...pane.querySelectorAll("*")] : [];
            const muted = all.filter((el) => el.classList.contains("bg-edge-mid") && el.classList.contains("text-ink-mid"));
            const raw = all.filter((el) => rawOverlay(getComputedStyle(el).backgroundColor)).map((el) => String(el.className).slice(0, 60));
            return { muted: muted.length, raw };
        `);
        const storageFloor = await floorStep(h, `1c. no visible text in the populated storage pane is under ${MIN_FONT_PX}px`, STORAGE_PANE);
        rec("1b. the muted tag chips render, and nothing in the pane has a raw white or black overlay background", paint.muted > 0 && paint.raw.length === 0, JSON.stringify(paint));
        steps.push(storageFloor);

        await storageResetAction(h);
        await h.ev(`${STORAGE_CLEAR}?.click()`);
        await polishWaitFor(h, `${STORAGE_CONFIRM} != null`, 3000);
        await settle();
        await shot("2-confirm");
        const confirm = await h.ev(`(() => {
            const d = ${STORAGE_CONFIRM};
            if (!d) return null;
            return { lines: [...d.querySelectorAll("li")].map((l) => l.textContent.trim()), text: d.textContent };
        })()`);
        await h.ev(`${storageDialogButton(STORAGE_CONFIRM, "Cancel")}?.click()`);
        const confirmGone = await polishWaitFor(h, `${STORAGE_CONFIRM} == null`, 3000);
        const afterCancel = await storageAction(h);
        rec(
            "2. confirm: Clear asks with the four kind lines (the run transcripts' says replay is lost and Usage kept), the 9e473bf8 skip and the tail; Cancel closes it and sends nothing",
            confirm != null &&
                confirm.lines.length === 4 &&
                /agent transcript folders.*replay.*keep their Usage/.test(confirm.lines[3]) &&
                confirm.text.includes(String.raw`Skips .waveterm\worktrees\9e473bf8`) &&
                confirm.text.includes("Live runs and kept items are never touched.") &&
                confirmGone &&
                afterCancel == null,
            JSON.stringify({ lines: confirm?.lines, gone: confirmGone, action: afterCancel })
        );

        await storageResetAction(h);
        await h.ev(`${STORAGE_CLEAR}?.click()`);
        await polishWaitFor(h, `${STORAGE_CONFIRM} != null`, 3000);
        await h.ev(`${storageDialogButton(STORAGE_CONFIRM, "Clear left over")}?.click()`);
        const ctaGone = await polishWaitFor(h, `${STORAGE_CONFIRM} == null`, 3000);
        const cleared = await storageAction(h);
        await shot("3-clear-cta");
        rec(
            "3. Clear left over closes the dialog and clears the 12 clearable fixture ids",
            ctaGone &&
                cleared?.kind === "clear" &&
                JSON.stringify([...(cleared.ids ?? [])].sort()) === JSON.stringify([...STORAGE_CLEAR_IDS].sort()),
            JSON.stringify({ gone: ctaGone, action: cleared })
        );

        const openDelete = async () => {
            await h.ev(`(${storageRow(STORAGE_SKIPPED_ID)})?.querySelector('[data-storage-delete]')?.click()`);
            return polishWaitFor(h, `${STORAGE_DELETE_CONFIRM} != null`, 3000);
        };
        await storageResetAction(h);
        await openDelete();
        await settle();
        await shot("4-deleteone");
        const del = await h.ev(`(() => {
            const d = ${STORAGE_DELETE_CONFIRM};
            if (!d) return null;
            return {
                commits: [...d.querySelectorAll("li")].map((l) => l.textContent.trim()),
                cta: ${storageText(storageDialogButton(STORAGE_DELETE_CONFIRM, "Delete and lose"))},
            };
        })()`);
        await h.ev(`${storageDialogButton(STORAGE_DELETE_CONFIRM, "Cancel")}?.click()`);
        const delGone = await polishWaitFor(h, `${STORAGE_DELETE_CONFIRM} == null`, 3000);
        rec(
            "4. deleteone: Delete anyway lists the 2 commits and offers Delete and lose 2 commits; Cancel closes it",
            del != null && del.commits.length === 2 && del.cta.startsWith("Delete and lose 2 commits") && delGone,
            JSON.stringify({ ...del, gone: delGone, action: await storageAction(h) })
        );

        await storageResetAction(h);
        await openDelete();
        await h.ev(`${storageDialogButton(STORAGE_DELETE_CONFIRM, "Delete and lose 2 commits")}?.click()`);
        const deleteGone = await polishWaitFor(h, `${STORAGE_DELETE_CONFIRM} == null`, 3000);
        const deleted = await storageAction(h);
        await shot("5-delete-cta");
        rec(
            "5. Delete and lose 2 commits closes the dialog and deletes the 9e473bf8 row at its tip",
            deleteGone && deleted?.kind === "delete" && deleted.id === STORAGE_SKIPPED_ID && deleted.tip === STORAGE_SKIPPED_TIP,
            JSON.stringify({ gone: deleteGone, action: deleted })
        );

        await storageResetAction(h);
        await h.ev(`${STORAGE_RESCAN}?.click()`);
        await settle();
        const scanned = await storageAction(h);
        await shot("6-rescan");
        rec("6. Rescan starts a scan", scanned?.kind === "scan", JSON.stringify(scanned));

        await storageResetAction(h);
        await h.ev(`(${storageRow(STORAGE_LIVE_ROW)})?.querySelector('[data-storage-run]')?.click()`);
        const toast = await polishWaitFor(
            h,
            `[...document.querySelectorAll('[data-notification-toast]')].some((t) => (t.textContent || "").includes(${JSON.stringify(STORAGE_RUN_GONE)}))`,
            5000
        );
        const opened = await storageAction(h);
        await shot("7-owner-link");
        rec(
            "7. the dca34385 owner link opens its run, which the fixture store lacks: That run no longer exists",
            opened?.kind === "open" && opened.runId === STORAGE_LIVE_RUN && toast,
            JSON.stringify({ action: opened, toast })
        );
        await h.goto("settings");
        await storageSet(h, "storage");
        await h.ev(`${STORAGE_NAV}?.click()`);
        await polishWaitFor(h, `${STORAGE_PANE}?.querySelector('[data-storage-group]') != null`, 5000);

        await storageSet(h, "clearing");
        await settle();
        await shot("8-clearing");
        const clearing = await h.ev(`(() => {
            const pane = ${STORAGE_PANE};
            if (!pane) return null;
            return {
                clear: ${storageText(STORAGE_CLEAR)},
                clearDisabled: ${STORAGE_CLEAR}?.disabled ?? null,
                rescanDisabled: ${STORAGE_RESCAN}?.disabled ?? null,
                text: pane.textContent,
                deletes: pane.querySelectorAll('[data-storage-delete]').length,
            };
        })()`);
        rec(
            "8. clearing: Clear reads Clearing 7 of 12… and is disabled, Rescan too; rows say Cleared and Clearing…; no Delete anyway",
            clearing != null &&
                clearing.clear === "Clearing 7 of 12…" &&
                clearing.clearDisabled === true &&
                clearing.rescanDisabled === true &&
                clearing.text.includes("Cleared") &&
                clearing.text.includes("Clearing…") &&
                clearing.deletes === 0,
            JSON.stringify({ ...clearing, text: undefined })
        );

        await storageSet(h, "cleared");
        await settle();
        await shot("9-cleared");
        const done = await h.ev(`(() => ({
            result: ${storageText(`${STORAGE_PANE}?.querySelector('[data-storage-result]')`)},
            held: ${storageText(storageRow(STORAGE_HELD_ROW))},
            clear: ${storageText(STORAGE_CLEAR)},
        }))()`);
        rec(
            "9. cleared: the result names the held folder, its row reads In use by a process, Clear reads Clear again",
            done.result.includes(String.raw`arc-wt\3425249d`) &&
                done.held.includes("In use by a process") &&
                done.clear === "Clear again",
            JSON.stringify(done)
        );

        await storageSet(h, "scanning");
        await settle();
        await shot("10-scanning");
        const scanning = await h.ev(`(() => {
            const pane = ${STORAGE_PANE};
            if (!pane) return null;
            return {
                skeleton: pane.querySelector('[data-storage-skeleton]') != null,
                stats: [...pane.querySelectorAll('[data-storage-stat]')].map((s) => s.children[1]?.textContent.trim()),
                clear: ${STORAGE_CLEAR} != null,
            };
        })()`);
        rec(
            "10. scanning: the skeleton shows, the stats read …, and there is no Clear",
            scanning != null &&
                scanning.skeleton &&
                JSON.stringify(scanning.stats) === JSON.stringify(["…", "…", "…"]) &&
                !scanning.clear,
            JSON.stringify(scanning)
        );

        await storageSet(h, "error");
        await settle();
        await shot("11-error");
        const errored = await h.ev(`(() => {
            const pane = ${STORAGE_PANE};
            if (!pane) return null;
            return {
                banner: ${storageText(`${STORAGE_PANE}?.querySelector('[data-storage-error]')`)},
                rows: [...pane.querySelectorAll('[data-storage-row]')]
                    .filter((r) => (r.getAttribute("data-storage-row") + r.textContent).includes("cyber_anomaly_detector")).length,
            };
        })()`);
        rec(
            "11. error: the banner names cyber_anomaly_detector and none of its rows list",
            errored != null && errored.banner.includes("cyber_anomaly_detector") && errored.rows === 0,
            JSON.stringify(errored)
        );

        await storageSet(h, "clean");
        await settle();
        await shot("12-clean");
        const clean = await h.ev(`({
            empty: ${STORAGE_PANE}?.querySelector('[data-storage-empty]') != null,
            clear: ${STORAGE_CLEAR} != null,
        })`);
        rec("12. clean: Left over says nothing is left over, and there is no Clear", clean.empty && !clean.clear, JSON.stringify(clean));
        return steps;
    },
    async teardown(h) {
        await h.ev(`window.__setStorageScenario?.("live")`).catch(() => {});
        await h.goto("cockpit");
    },
};

// --- remote-switch: Settings > Remote and the footer's remote chip ----------------------------------------------
// Step 1 reads the dev store's real status (no remote setup). The rest are fixtures set into remoteStatusAtom
// through the app's own store module; nothing reaches wavesrv but step 7's switch click, which the real
// RemoteOnCommand refuses because the dev store has no setup, and step 9's bad team, which the real
// RemoteSetupCommand refuses before storing anything. Teardown reloads the real status.
const REMOTE_PANE = `document.querySelector('[data-settings-section="remote"]')`;
const REMOTE_PILL = `document.querySelector('[data-remote-pill]')`;
const REMOTE_HOST = "arc.example.com";
const REMOTE_TUNNEL_ERROR = "failed to dial edge: connection refused";
const REMOTE_SET_UP = {
    on: false,
    team: "acme",
    aud: "aud-tag",
    email: "me@example.com",
    hostname: REMOTE_HOST,
    port: 8765,
    tunnel: "off",
    subscriptions: 0,
};
// a full host name where Setup wants the bare team name, so the real RemoteSetupCommand refuses it and stores nothing
const REMOTE_BAD_TEAM = "acme.cloudflareaccess.com";
const REMOTE_FIELDS = `(() => {
    const pane = ${REMOTE_PANE};
    const input = (id) => pane?.querySelector(\`[data-setting-row="remote.\${id}"] input\`);
    return {
        ...Object.fromEntries(["hostname", "port", "team", "aud", "email"].map((id) => [id, input(id)?.value ?? null])),
        token: input("tunneltoken")?.getAttribute("placeholder") ?? null,
    };
})()`;
const REMOTE_FIXTURES = {
    up: { ...REMOTE_SET_UP, on: true, tunnel: "up", subscriptions: 1 },
    down: { ...REMOTE_SET_UP, on: true, tunnel: "down", tunnelerror: REMOTE_TUNNEL_ERROR, subscriptions: 1 },
    nocloudflared: { ...REMOTE_SET_UP, cloudflaredmissing: true },
    off: REMOTE_SET_UP,
};
const remoteSetStatus = (h, name) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { remoteStatusAtom } = await mod("app/view/agents/remotestore.ts");
        globalStore.set(remoteStatusAtom, ${JSON.stringify(REMOTE_FIXTURES[name])});
        return true;
    `);
const remoteReload = (h) =>
    lookEval(h, `
        await (await mod("app/view/agents/remotestore.ts")).loadRemoteStatus();
        return true;
    `);
const REMOTE_READ = `(() => {
    const pane = ${REMOTE_PANE};
    const sw = pane?.querySelector('[role="switch"]');
    const text = (el) => (el?.textContent || "").trim();
    return {
        pane: pane != null,
        pill: ${REMOTE_PILL} != null,
        pillTone: ${REMOTE_PILL}?.getAttribute("data-remote-pill") ?? null,
        pillText: (${REMOTE_PILL}?.textContent || "").trim(),
        switchOn: sw?.getAttribute("aria-checked") === "true",
        switchDisabled: sw?.disabled ?? null,
        note: text(pane?.querySelector('[data-testid="remote-switch-note"]')),
        error: text(pane?.querySelector('[data-testid="remote-error"]')),
        lines: Object.fromEntries([...(pane?.querySelectorAll('[data-remote-line]') ?? [])].map((l) => [l.getAttribute("data-remote-line"), text(l)])),
    };
})()`;

export const remoteSwitchScenario = {
    name: "remote-switch",
    surface: "settings",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/remote-switch-${n}.png`);
        const settle = () => polishNap(300);

        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("settings");
        await remoteReload(h);
        await h.ev(`document.querySelector('[data-section="remote"]')?.click()`);
        await polishWaitFor(h, `${REMOTE_PANE}?.querySelector('[data-remote-line]') != null`, 5000);
        await settle();
        await shot("1-unset");
        const unset = await h.ev(REMOTE_READ);
        rec(
            "1. with no setup the switch is disabled, says to run wsh remote setup, and no pill shows",
            unset.pane && unset.switchDisabled === true && !unset.switchOn && unset.note.includes("wsh remote setup") && !unset.pill && /^Setup incomplete/.test(unset.lines.setup ?? ""),
            JSON.stringify(unset)
        );

        await remoteSetStatus(h, "up");
        await polishWaitFor(h, `${REMOTE_PILL} != null`, 3000);
        await settle();
        await shot("2-up");
        const up = await h.ev(REMOTE_READ);
        const pillText = await h.ev(`(${REMOTE_PILL}?.textContent || "").trim()`);
        rec(
            "2. on with the tunnel up: the pill shows, the section shows on, the address and subscribed",
            up.pill && pillText === "Remote on" && up.switchOn && up.switchDisabled === false && up.lines.tunnel === "Tunnel up" && up.lines.address === `https://${REMOTE_HOST}` && up.lines.phone === "Phone subscribed",
            JSON.stringify({ ...up, pillText })
        );

        await h.goto("agent");
        await settle();
        await h.ev(`${REMOTE_PILL}?.click()`);
        const opened = await polishWaitFor(h, `${REMOTE_PANE} != null`, 5000);
        await settle();
        await shot("3-pill-opens");
        const selected = await h.ev(`document.querySelector('[data-section="remote"]')?.className.includes("border-accent") ?? false`);
        rec("3. clicking the pill on the Agent surface opens Settings > Remote", opened && selected, JSON.stringify({ opened, selected }));

        await remoteSetStatus(h, "down");
        await settle();
        await shot("4-down");
        const down = await h.ev(REMOTE_READ);
        rec(
            "4. on with the tunnel down: the section shows the down line with its error, and the chip reads down",
            down.lines.tunnel === `Tunnel down: ${REMOTE_TUNNEL_ERROR}` && down.switchOn && down.pillTone === "down",
            JSON.stringify(down)
        );

        await remoteSetStatus(h, "nocloudflared");
        await settle();
        await shot("5-no-cloudflared");
        const nocf = await h.ev(REMOTE_READ);
        rec(
            "5. set up but cloudflared missing: the switch is disabled with the winget line",
            nocf.switchDisabled === true && nocf.note.includes("winget install --id Cloudflare.cloudflared") && !nocf.pill && nocf.lines.setup === "Setup complete",
            JSON.stringify(nocf)
        );

        await remoteSetStatus(h, "off");
        await settle();
        await shot("6-off");
        const off = await h.ev(REMOTE_READ);
        rec("6. set up and off: the chip reads Remote off", off.pillTone === "off" && off.pillText === "Remote off", JSON.stringify(off));
        await h.ev(`${REMOTE_PANE}?.querySelector('[role="switch"]')?.click()`);
        await polishWaitFor(h, `${REMOTE_PANE}?.querySelector('[data-testid="remote-error"]') != null`, 20000);
        await settle();
        await shot("7-refused");
        const refused = await h.ev(REMOTE_READ);
        rec(
            "7. set up and off: the switch's real RemoteOnCommand refuses, and the section shows the error inline",
            refused.error !== "" && !refused.switchOn && !refused.pill,
            JSON.stringify(refused)
        );

        // step 7's refusal published the dev store's real status, so the set-up fixture goes back in
        await remoteSetStatus(h, "off");
        await settle();
        await shot("8-fields");
        const fields = await h.ev(REMOTE_FIELDS);
        rec(
            "8. set up: the setup rows show the stored values, and the token row says one is stored without showing it",
            fields.hostname === REMOTE_HOST && fields.port === "8765" && fields.team === "acme" && fields.aud === "aud-tag" && fields.email === "me@example.com" && /^Stored/.test(fields.token ?? ""),
            JSON.stringify(fields)
        );

        await h.ev(`(() => {
            const input = ${REMOTE_PANE}?.querySelector('[data-setting-row="remote.team"] input');
            if (!input) return false;
            // Enter commits through the blur it causes (1c5483194), and only a focused field blurs
            input.focus();
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(REMOTE_BAD_TEAM)});
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
            return true;
        })()`);
        await polishWaitFor(h, `/bare team name/.test(${REMOTE_PANE}?.querySelector('[data-testid="remote-error"]')?.textContent || "")`, 10000);
        await settle();
        await shot("9-bad-team");
        const bad = await h.ev(REMOTE_READ);
        // the field keeps the refused text for correcting, so what got stored is read from wavesrv
        const stored = await lookEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
            return (await RpcApi.RemoteStatusCommand(TabRpcClient)).team ?? "";
        `);
        rec(
            "9. a bad team goes to the real RemoteSetupCommand, which refuses it inline and stores nothing",
            /bare team name/.test(bad.error) && stored === "",
            JSON.stringify({ error: bad.error, storedTeam: stored })
        );
        return steps;
    },
    async teardown(h) {
        await remoteReload(h).catch(() => {});
        await h.goto("cockpit");
    },
};

// --- remote-phone: the phone page, served by cmd/remotepreview, in a phone-sized headless browser ---------------
// Needs no dev app: the preview serves the real page and handler with fixture data and an Access check that lets
// everything through, and prints a line for each answer, subscribe and off it gets. The browser is its own
// headless Edge or Chrome on its own CDP port; its shots join the run's. Restarts reuse the first port, since the
// page's origin, service worker and last-reached time all hang on it.
const PHONE_REPO = fileURLToPath(new URL("../..", import.meta.url));
// "REMOTEPREVIEW <url>" once listening, then "REMOTEPREVIEW <what> <json>" per answer, subscribe and off
const PHONE_LINE = /^REMOTEPREVIEW (\S+)(?: (.*))?$/;
const PHONE_ENDPOINT = "https://push.example.test/arc-remote-phone";
const PHONE_WAIT_MS = 15_000;
const PHONE_GONE_TEXT = "already answered or withdrawn";
// headless chrome has no push service: the grant and the subscription are stubbed before any page script runs, and
// the grant outlives a reload as a real one would
const PHONE_GRANT_KEY = "arc-remote-phone.granted";
const PHONE_STUB = `(() => {
    Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => (localStorage.getItem(${JSON.stringify(PHONE_GRANT_KEY)}) ? "granted" : "default"),
    });
    Notification.requestPermission = async () => {
        localStorage.setItem(${JSON.stringify(PHONE_GRANT_KEY)}, "1");
        return "granted";
    };
    PushManager.prototype.subscribe = async () => ({
        endpoint: ${JSON.stringify(PHONE_ENDPOINT)},
        expirationTime: null,
        keys: { p256dh: "BFakeP256dhKeyForTheRemotePhoneScenario", auth: "fakeAuthSecret" },
    });
})()`;

function phoneBrowserPath() {
    if (process.env.CHROME) return process.env.CHROME;
    const found = [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ].find((p) => existsSync(p));
    if (!found) throw new Error("no Chrome or Edge found; set CHROME=<path to chrome or msedge>");
    return found;
}

// resolves once the preview prints its url; every later record line lands in ctx.records
function phoneStartPreview(ctx, fixture) {
    const args = ["--fixture", fixture, ...(ctx.port ? ["--port", String(ctx.port)] : [])];
    const child = spawn(ctx.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    ctx.preview = child;
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    return new Promise((resolveUrl, reject) => {
        const timer = setTimeout(() => reject(new Error(`remotepreview did not start in ${PHONE_WAIT_MS}ms: ${stderr}`)), PHONE_WAIT_MS);
        let buf = "";
        child.stdout.on("data", (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                const m = line.match(PHONE_LINE);
                if (!m) continue;
                if (m[1].startsWith("http")) {
                    clearTimeout(timer);
                    ctx.url = m[1];
                    ctx.port = Number(new URL(m[1]).port);
                    resolveUrl(m[1]);
                } else {
                    ctx.records.push({ what: m[1], data: m[2] ? JSON.parse(m[2]) : null });
                }
            }
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`remotepreview exited (${code}) before it listened: ${stderr}`));
        });
    });
}

async function phoneStopPreview(ctx) {
    const child = ctx.preview;
    ctx.preview = null;
    if (!child || child.exitCode != null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
}

async function phoneLaunchBrowser(ctx, shots) {
    const profile = join(ctx.dir, "profile");
    ctx.browser = spawn(
        phoneBrowserPath(),
        [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=0",
            "about:blank",
        ],
        { stdio: "ignore" }
    );
    const portFile = join(profile, "DevToolsActivePort");
    let port = 0;
    for (const start = Date.now(); !port && Date.now() - start < PHONE_WAIT_MS; await polishNap(200)) {
        if (existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    }
    if (!port) throw new Error(`the headless browser wrote no DevToolsActivePort in ${PHONE_WAIT_MS}ms`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.type === "page");
    if (!target) throw new Error(`the headless browser on :${port} has no page target`);
    const page = await openPage(target, shots);
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: PHONE_STUB });
    return page;
}

// a navigation or reload, then the first draw of #app
async function phoneLoad(page, url) {
    await page.ev(`(() => { window.__phoneReloading = true; location.href = ${JSON.stringify(url)}; })()`).catch(() => {});
    await polishWaitFor(page, `!window.__phoneReloading && document.querySelector("#app")?.childElementCount > 0`, PHONE_WAIT_MS);
}

const PHONE_READ = `(() => {
    const text = (el) => (el?.textContent || "").trim();
    const buttons = [...document.querySelectorAll("button")].map(text);
    return {
        chip: text(document.querySelector(".chip")),
        sub: text(document.querySelector(".head-sub")),
        sections: [...document.querySelectorAll("section h2")].map(text),
        cards: [...document.querySelectorAll(".card .meta-agent")].map(text),
        held: document.querySelectorAll(".shown").length,
        notice: text(document.querySelector(".notice")),
        blank: text(document.querySelector(".blank-title")),
        notifications: buttons.includes("Turn on notifications"),
        off: buttons.includes("Turn off remote mode"),
        answering: document.querySelector(".qblock") != null,
        sent: text(document.querySelector(".sent")),
        handed: [...document.querySelectorAll("[data-handed-row]")].map((r) => ({
            tab: r.dataset.handedRow,
            name: text(r.querySelector(".meta-agent")),
            state: r.querySelector(".state-chip")?.dataset.state ?? "",
            chip: text(r.querySelector(".state-chip")),
            line: text(r.querySelector(".agent-line")),
        })),
        foot: text(document.querySelector(".foot-text")),
    };
})()`;

// the boards' copy, verbatim
const PHONE_OFF_FOOT = "This page goes offline, every handed-over agent goes back to the desk, and the PC may sleep again.";
const PHONE_TAKEN_TEXT =
    "phone-chat was taken back, here or at the desk, so it no longer takes messages from the phone. Hand it over again from the Agent surface.";
// fx-exited is on no list, so the page has no name for it
const PHONE_EXITED_TEXT = "The agent exited, so it is off the phone.";
const PHONE_EXITED_TAB = "fx-exited";

const PHONE_CHAT_READ = `(() => {
    const text = (el) => (el?.textContent || "").trim();
    const q = (s) => document.querySelector(s);
    const box = q("#chat-msg");
    const stop = q("[data-chat-stop]");
    const note = q("[data-chat-note]");
    return {
        name: text(q(".chat-name")),
        state: text(q("[data-chat-state]")),
        users: [...document.querySelectorAll("[data-chat-user]")].map(text),
        actions: [...document.querySelectorAll("[data-chat-action]")].map((a) => ({
            mark: a.dataset.mark,
            verb: text(a.querySelector(".act-verb")),
            target: text(a.querySelector(".act-target")),
            tail: text(a.querySelector(".act-tail")),
            live: a.classList.contains("live"),
        })),
        replies: [...document.querySelectorAll("[data-chat-reply]")].map(text),
        md: [...document.querySelectorAll("[data-chat-reply]")].map((r) => {
            const prose = r.cloneNode(true);
            prose.querySelectorAll("pre").forEach((p) => p.remove());
            return {
                strong: [...r.querySelectorAll("strong")].map(text),
                em: [...r.querySelectorAll("em")].map(text),
                code: [...r.querySelectorAll(":not(pre) > code")].map((c) => ({ text: text(c), mono: /mono/i.test(getComputedStyle(c).fontFamily) })),
                items: [...r.querySelectorAll("ul > li")].map(text),
                links: [...r.querySelectorAll("a")].map((a) => ({ text: text(a), href: a.getAttribute("href"), target: a.target, rel: a.rel })),
                marks: [...r.querySelectorAll("mark")].map(text),
                prose: prose.textContent,
            };
        }),
        code: [...document.querySelectorAll("[data-chat-reply] pre.reply-code")].map((p) => ({
            text: p.textContent,
            mono: /mono/i.test(getComputedStyle(p).fontFamily),
        })),
        label: text(q('label[for="chat-msg"]')),
        placeholder: box?.placeholder ?? "",
        boxDisabled: box?.disabled ?? null,
        stop: stop && !stop.hidden ? text(stop) : "",
        note: note && !note.hidden ? text(note) : "",
        permission: q("[data-chat-permission]")
            ? { tool: text(q(".perm-tool")), ask: text(q(".perm-ask")), target: text(q(".perm-target")), note: text(q(".perm-note")) }
            : null,
        approve: q("[data-chat-approve]") != null,
        deny: q("[data-chat-deny]") != null,
        error: text(q(".send-error")),
        ended: q("[data-chat-ended]")?.dataset.chatEnded ?? "",
        endedTitle: text(q("[data-chat-ended] .blank-title")),
        endedText: text(q("[data-chat-ended] .blank-text")),
    };
})()`;

// Send stays disabled until an input event says the box holds text
const phoneType = (text) =>
    `(() => { const b = document.querySelector("#chat-msg"); if (!b) return false; b.value = ${JSON.stringify(text)}; b.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
const phoneClick = (selector) => `(() => { const b = document.querySelector(${JSON.stringify(selector)}); b?.click(); return !!b; })()`;
const phoneOpenChat = (tab) => phoneClick(`[data-handed-row="${tab}"]`);
// the stream's backlog has drawn once the transcript's first message shows
const PHONE_CHAT_DRAWN = `document.querySelector("[data-chat-user]") != null`;

const phoneClickButton = (label) =>
    `(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === ${JSON.stringify(label)}); b?.click(); return !!b; })()`;
const phoneOpenCard = (source) =>
    `(() => { const c = [...document.querySelectorAll(".card")].find((x) => x.querySelector(".meta-agent")?.textContent === ${JSON.stringify(source)}); c?.click(); return !!c; })()`;
const phonePick = (qi, oi) => `document.querySelectorAll(".qblock")[${qi}]?.querySelectorAll(".option")[${oi}]?.click()`;
const PHONE_SEND_DISABLED = `document.querySelector(".btn-primary")?.disabled ?? null`;

export const remotePhone = {
    name: "remote-phone",
    surface: "cockpit",
    async arrange() {
        const dir = mkdtempSync(join(tmpdir(), "verify-remote-phone-"));
        const bin = join(dir, `remotepreview${process.platform === "win32" ? ".exe" : ""}`);
        // a built binary, not go run: killing go run on Windows leaves its child serving
        execFileSync("go", ["build", "-o", bin, "./cmd/remotepreview"], { cwd: PHONE_REPO, stdio: "pipe" });
        return { dir, bin, records: [], port: 0 };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const records = (what) => ctx.records.filter((r) => r.what === what);
        const recorded = async (what, n) => {
            for (const start = Date.now(); records(what).length < n && Date.now() - start < PHONE_WAIT_MS; ) await polishNap(200);
            return records(what).length >= n;
        };

        await phoneStartPreview(ctx, "main");
        const page = (ctx.page = await phoneLaunchBrowser(ctx, h.shots));
        const shot = (n) => page.shot(`cdp-shots/remote-phone-${n}.png`);
        const shotScrolled = async (n) => {
            await page.ev(`document.querySelector(".main")?.scrollTo(0, 1e6)`);
            await polishNap(200);
            await shot(n);
            await page.ev(`document.querySelector(".main")?.scrollTo(0, 0)`);
        };
        const read = () => page.ev(PHONE_READ);
        const list = await (await fetch(`${ctx.url}api/waiting`)).json();
        const [portQ, checksQ, withdrawnQ] = list.questions;

        // 1. Main
        await phoneLoad(page, ctx.url);
        await polishWaitFor(page, `document.querySelectorAll(".card").length === 3`, PHONE_WAIT_MS);
        // the service worker must hold the shell before step 6 can draw Unreachable offline
        const sw = await page.ev(`Promise.race([
            navigator.serviceWorker.ready.then(() => caches.match("/")).then((r) => !!r),
            new Promise((r) => setTimeout(() => r(false), ${PHONE_WAIT_MS})),
        ])`);
        await polishNap(300);
        // the Handed over section sits under the three questions, below a phone's fold
        await page.ev(`document.querySelector('section[aria-label="Handed over"]')?.scrollIntoView({ block: "end" })`);
        await polishNap(200);
        await shot("1-main");
        await page.ev(`document.querySelector(".main")?.scrollTo(0, 0)`);
        await shotScrolled("1-main-held");
        const main = await read();
        const rowOf = (a) => ({ tab: a.tab, name: a.name, state: a.state, line: a.line });
        const wantHanded = list.handed.map(rowOf);
        const chipsOk =
            main.handed.length === 3 &&
            main.handed[0].chip === "needs approval" &&
            main.handed[1].chip.startsWith("working ") &&
            main.handed[2].chip.startsWith("idle ");
        rec(
            "1. Main: questions, the three hand-overs with their state chips, held runs, the counts line, the off footer and Turn on notifications",
            main.chip === "Remote on" &&
                main.sub === "3 questions to answer · 3 agents handed over · 2 runs held" &&
                JSON.stringify(main.sections) === JSON.stringify(["Questions", "Handed over", "Held runs"]) &&
                JSON.stringify(main.cards) === JSON.stringify(list.questions.map((q) => q.source)) &&
                JSON.stringify(main.handed.map(rowOf)) === JSON.stringify(wantHanded) &&
                JSON.stringify(wantHanded.map((a) => [a.name, a.state])) ===
                    JSON.stringify([
                        ["siem-deploy", "permission"],
                        ["phone-chat", "working"],
                        ["vault-sync", "idle"],
                    ]) &&
                chipsOk &&
                main.held === 2 &&
                main.off &&
                main.foot === PHONE_OFF_FOOT &&
                main.notifications &&
                sw === true,
            JSON.stringify({ ...main, sw })
        );

        // 1b. Turn on notifications
        await page.ev(phoneClickButton("Turn on notifications"));
        const subscribed = await recorded("subscribe", 1);
        await polishWaitFor(page, `![...document.querySelectorAll("button")].some((b) => /^Turn(ing)? on notifications/.test(b.textContent.trim()))`, PHONE_WAIT_MS);
        await shot("1b-notifications-on");
        const afterSub = await read();
        rec(
            "1b. tapping Turn on notifications: the preview recorded the stub's subscription and the button is gone",
            subscribed && records("subscribe")[0].data.endpoint === PHONE_ENDPOINT && !afterSub.notifications && afterSub.notice === "",
            JSON.stringify({ subscribe: records("subscribe"), notice: afterSub.notice, button: afterSub.notifications })
        );

        // 2. Answer
        await page.ev(phoneOpenCard(portQ.source));
        await polishWaitFor(page, `document.querySelector(".qblock") != null`, PHONE_WAIT_MS);
        await page.ev(`(() => { const d = document.querySelector("details.fold"); if (d) d.open = true; })()`);
        await polishNap(300);
        await shot("2-answer");
        await shotScrolled("2-answer-end");
        const pq = portQ.questions[0];
        const answer = await page.ev(`(() => {
            const text = (el) => (el?.textContent || "").trim();
            const block = document.querySelector(".qblock");
            return {
                question: text(block?.querySelector("h1")),
                fold: block?.querySelector("details.fold")?.open ?? false,
                preview: block?.querySelector(".fold-text")?.textContent ?? "",
                nums: [...(block?.querySelectorAll(".option-num") ?? [])].map(text),
                rec: [...(block?.querySelectorAll(".option") ?? [])].findIndex((o) => o.querySelector(".rec-mark")),
                own: block?.querySelector("input[type=text]") != null,
                send: text(document.querySelector(".btn-primary")),
                sendDisabled: document.querySelector(".btn-primary")?.disabled ?? null,
            };
        })()`);
        const recIndex = pq.options.findIndex((o) => /\(Recommended\)$/.test(o.label));
        rec(
            "2. Answer: the full question, the fold open on the preview, numbered rows with the recommended mark, own answer, Send",
            answer.question === pq.question &&
                answer.fold &&
                answer.preview === pq.options[recIndex].preview &&
                JSON.stringify(answer.nums) === JSON.stringify(pq.options.map((_, i) => String(i + 1))) &&
                answer.rec === recIndex &&
                answer.own &&
                answer.send === "Send answer" &&
                answer.sendDisabled === true,
            JSON.stringify(answer)
        );

        // 3. Answered
        await page.ev(phonePick(0, recIndex));
        await page.ev(phoneClickButton("Send answer"));
        await polishWaitFor(page, `document.querySelector(".sent") != null`, PHONE_WAIT_MS);
        const answered = await recorded("answer", 1);
        await polishNap(300);
        await shot("3-answered");
        const sent = await read();
        const first = records("answer")[0]?.data;
        rec(
            "3. pick and send: Answered with what was sent, and the preview recorded the answer",
            sent.sent.startsWith("Answered") &&
                sent.sent.includes(`Sent to ${portQ.source}: 8765`) &&
                answered &&
                first.oref === portQ.oref &&
                first.askid === portQ.askid &&
                JSON.stringify(first.answers) === JSON.stringify([{ selectedindexes: [recIndex] }]),
            JSON.stringify({ sent: sent.sent, record: first })
        );

        // 4. a two-question ask: Send waits for both
        await page.ev(phoneClickButton("Back to what is waiting"));
        await polishWaitFor(page, `document.querySelectorAll(".card").length === 2`, PHONE_WAIT_MS);
        await page.ev(phoneOpenCard(checksQ.source));
        await polishWaitFor(page, `document.querySelectorAll(".qblock").length === 2`, PHONE_WAIT_MS);
        await page.ev(phonePick(0, 1));
        const halfDisabled = await page.ev(PHONE_SEND_DISABLED);
        await polishNap(200);
        await shot("4-half-answered");
        await page.ev(phonePick(1, 0));
        await page.ev(phonePick(1, 2));
        const fullDisabled = await page.ev(PHONE_SEND_DISABLED);
        const multiChecked = await page.ev(
            `[...document.querySelectorAll(".qblock")[1].querySelectorAll(".option")].map((o) => o.getAttribute("aria-checked"))`
        );
        await shotScrolled("4-both-answered");
        await page.ev(phoneClickButton("Send answer"));
        await polishWaitFor(page, `document.querySelector(".sent") != null`, PHONE_WAIT_MS);
        const second = (await recorded("answer", 2)) ? records("answer")[1].data : null;
        await polishNap(300);
        await shot("4-answered");
        rec(
            "4. a two-question ask: Send stays disabled with one answered, then sends both, the second multi-select",
            halfDisabled === true &&
                fullDisabled === false &&
                JSON.stringify(multiChecked) === JSON.stringify(["true", "false", "true"]) &&
                second?.oref === checksQ.oref &&
                JSON.stringify(second?.answers) === JSON.stringify([{ selectedindexes: [1] }, { selectedindexes: [0, 2] }]),
            JSON.stringify({ halfDisabled, fullDisabled, multiChecked, record: second })
        );

        // 4b. a question answered at the desk meanwhile
        await page.ev(phoneClickButton("Back to what is waiting"));
        await polishWaitFor(page, `document.querySelectorAll(".card").length === 1`, PHONE_WAIT_MS);
        await page.ev(phoneOpenCard(withdrawnQ.source));
        await polishWaitFor(page, `document.querySelector(".qblock") != null`, PHONE_WAIT_MS);
        await page.ev(phonePick(0, 0));
        await page.ev(phoneClickButton("Send answer"));
        await polishWaitFor(page, `document.querySelector(".notice") != null && !document.querySelector(".qblock")`, PHONE_WAIT_MS);
        await polishNap(300);
        await shot("4b-gone");
        const gone = await read();
        rec(
            "4b. the withdrawn question: the page says it was already answered or withdrawn and is back on the list",
            gone.notice.includes(PHONE_GONE_TEXT) && !gone.answering && gone.cards.length === 1 && records("answer").length === 2,
            JSON.stringify({ notice: gone.notice, cards: gone.cards, answers: records("answer").length })
        );

        // 5. Empty
        await phoneStopPreview(ctx);
        await phoneStartPreview(ctx, "empty");
        await phoneLoad(page, ctx.url);
        await polishWaitFor(page, `document.querySelector(".blank-title") != null`, PHONE_WAIT_MS);
        await polishNap(300);
        await shot("5-empty");
        const empty = await read();
        rec(
            "5. the empty fixture: Empty, still on, with the off button",
            empty.blank === "Nothing is waiting on you." && empty.chip === "Remote on" && empty.sub === "Nothing waiting" && empty.off,
            JSON.stringify(empty)
        );

        // 6. Unreachable
        await phoneStopPreview(ctx);
        await phoneLoad(page, ctx.url);
        await polishWaitFor(page, `document.querySelector(".chip-off") != null`, PHONE_WAIT_MS);
        await polishNap(300);
        await shot("6-unreachable");
        const down = await read();
        rec(
            "6. the preview stopped and the page reloaded: Unreachable with Last reached",
            down.chip === "Not reachable" && down.sub.startsWith("Last reached") && down.blank === "Arc is not reachable.",
            JSON.stringify(down)
        );

        // 7. turn off from the phone
        await phoneStartPreview(ctx, "main");
        await phoneLoad(page, ctx.url);
        await polishWaitFor(page, `document.querySelector(".chip-on") != null && document.querySelectorAll(".card").length > 0`, PHONE_WAIT_MS);
        await page.ev(phoneClickButton("Turn off remote mode"));
        await polishNap(200);
        await shot("7-confirm-off");
        await page.ev(phoneClickButton("Turn off now"));
        const off = await recorded("off", 1);
        await polishWaitFor(page, `document.querySelector(".chip-off") != null`, PHONE_WAIT_MS);
        await polishNap(300);
        await shot("7-off");
        const after = await read();
        rec(
            "7. Turn off remote mode, confirmed: the preview recorded Off and the page shows Unreachable",
            off && after.chip === "Not reachable" && after.blank === "Arc is not reachable.",
            JSON.stringify({ ...after, offRecords: records("off").length })
        );

        // the chats: a fresh main fixture, each chat opened from its Handed over row
        const inputs = () => records("input").map((r) => r.data);
        const chatRead = () => page.ev(PHONE_CHAT_READ);
        const restartOn = async (fixture) => {
            await phoneStopPreview(ctx);
            await phoneStartPreview(ctx, fixture);
            await phoneLoad(page, ctx.url);
            await polishWaitFor(page, `document.querySelectorAll("[data-handed-row]").length > 0`, PHONE_WAIT_MS);
        };
        const openChat = async (tab) => {
            await page.ev(phoneOpenChat(tab));
            await polishWaitFor(page, PHONE_CHAT_DRAWN, PHONE_WAIT_MS);
            await polishNap(300);
        };

        // 8. Chat: vault-sync, idle
        await restartOn("main");
        await openChat("fx-vault-sync");
        await shot("8-chat");
        const chat = await chatRead();
        // the first reply's markdown (vault-sync.jsonl a3) draws as elements, with no mark left as text
        const md = chat.md[0] ?? {};
        const mdOk =
            JSON.stringify(md.strong) === JSON.stringify(["stale"]) &&
            JSON.stringify(md.em) === JSON.stringify(["why"]) &&
            md.code?.length === 4 &&
            md.code[0].text === "git mv" &&
            md.code.every((c) => c.mono) &&
            md.items?.length === 3 &&
            md.items[0] === "inbox/2026-08-12 tunnel notes.md" &&
            JSON.stringify(md.links) ===
                JSON.stringify([{ text: "git mv", href: "https://git-scm.com/docs/git-mv", target: "_blank", rel: "noopener noreferrer" }]) &&
            JSON.stringify(md.marks) === JSON.stringify(["Moving them with git mv keeps their history."]) &&
            !/\*\*|`|==|\[git mv\]/.test(md.prose ?? "*");
        await page.ev(phoneType("archive the drafts folder too"));
        await page.ev(phoneClick("[data-chat-send]"));
        const sentOk = await recorded("input", 1);
        const cleared = await polishWaitFor(page, `document.querySelector("#chat-msg")?.value === ""`, PHONE_WAIT_MS);
        await shot("8-chat-sent");
        rec(
            "8. Chat (vault-sync, idle): the user bubble, the action lines, the reply's markdown (bold, italic, inline code, list, link, highlight; no raw marks) and its mono code block, Message vault-sync; Send is recorded",
            chat.name === "vault-sync" &&
                chat.state.startsWith("idle") &&
                JSON.stringify(chat.users) === JSON.stringify(["archive the inbox notes marked stale and push"]) &&
                JSON.stringify(chat.actions.map((a) => a.verb)) === JSON.stringify(["Grep", "Read", "Ran", "Ran"]) &&
                chat.actions[3]?.target === "git push" &&
                chat.actions[3]?.mark === "ok" &&
                chat.replies.length === 2 &&
                chat.replies[1] === "Moved the 3 stale notes to archive/ and pushed. Anything else?" &&
                chat.code.length === 1 &&
                chat.code[0].text.startsWith("git mv") &&
                chat.code[0].mono &&
                mdOk &&
                chat.label === "Message vault-sync" &&
                chat.placeholder === "Message vault-sync" &&
                chat.boxDisabled === false &&
                chat.stop === "" &&
                chat.permission === null &&
                sentOk &&
                cleared &&
                JSON.stringify(inputs()[0]) === JSON.stringify({ tab: "fx-vault-sync", action: "send", text: "archive the drafts folder too" }),
            JSON.stringify({ chat, cleared, inputs: inputs() })
        );

        // 9. ChatWorking: phone-chat
        await page.ev(`(location.hash = "#agent/fx-phone-chat", true)`);
        await polishWaitFor(page, `document.querySelector(".chat-name")?.textContent === "phone-chat" && ${PHONE_CHAT_DRAWN}`, PHONE_WAIT_MS);
        await polishNap(300);
        await shot("9-chat-working");
        const working = await chatRead();
        await page.ev(phoneClick("[data-chat-stop]"));
        const stopped = await recorded("input", 2);
        const live = working.actions.at(-1);
        rec(
            "9. ChatWorking (phone-chat): working, the live Running line with its elapsed, Add to this turn and Stop in the header; Stop is recorded",
            working.state.startsWith("working") &&
                live?.live === true &&
                live.verb === "Running" &&
                live.target === "node scripts/cdp/verify.mjs remote-phone" &&
                /^\d+[hms]/.test(live.tail) &&
                working.label === "Add to this turn" &&
                working.placeholder === "Add to this turn" &&
                working.stop === "Stop" &&
                working.code.length === 1 &&
                stopped &&
                JSON.stringify(inputs()[1]) === JSON.stringify({ tab: "fx-phone-chat", action: "stop", text: "" }),
            JSON.stringify({ working, inputs: inputs() })
        );

        // 10. ChatPermission: siem-deploy
        await page.ev(`(location.hash = "#agent/fx-siem-deploy", true)`);
        await polishWaitFor(page, `document.querySelector("[data-chat-permission]") != null`, PHONE_WAIT_MS);
        await polishNap(300);
        await shot("10-chat-permission");
        const perm = await chatRead();
        await page.ev(phoneClick("[data-chat-approve]"));
        const approved = await recorded("input", 3);
        await polishWaitFor(page, `document.querySelector("[data-chat-approve]")?.disabled === false`, PHONE_WAIT_MS);
        const reason = "restart it after 18:00, the night shift is still ingesting";
        await page.ev(phoneType(reason));
        await page.ev(phoneClick("[data-chat-send]"));
        const denied = await recorded("input", 4);
        await polishNap(200);
        await shot("10-chat-denied");
        const restartCmd = "ssh deploy@siem-236 'sudo systemctl restart ingest'";
        rec(
            "10. ChatPermission (siem-deploy): the card with Bash, the whole command, Approve and Deny, the deny box; Approve then a typed deny are recorded",
            perm.permission?.tool === "Bash" &&
                perm.permission.ask === "Wants to run a command" &&
                perm.permission.target === restartCmd &&
                perm.permission.note === "The agent is paused until you choose." &&
                perm.approve &&
                perm.deny &&
                !perm.actions.some((a) => a.target === restartCmd) &&
                perm.placeholder === "Deny and say what to do instead" &&
                perm.label === "Deny and tell siem-deploy why" &&
                approved &&
                denied &&
                JSON.stringify(inputs().slice(2)) ===
                    JSON.stringify([
                        { tab: "fx-siem-deploy", action: "approve", text: "" },
                        { tab: "fx-siem-deploy", action: "deny", text: reason },
                    ]),
            JSON.stringify({ perm, inputs: inputs() })
        );

        // 11. Needs input: docs-worker, alone in the input fixture
        await restartOn("input");
        await openChat("fx-docs-worker");
        await shot("11-needs-input");
        const needs = await chatRead();
        rec(
            "11. Needs input (docs-worker): the desk note, the box disabled, no Approve or Deny, no Stop",
            needs.name === "docs-worker" &&
                needs.note === "Needs input · answer it at the desk" &&
                needs.boxDisabled === true &&
                !needs.approve &&
                !needs.deny &&
                needs.stop === "" &&
                needs.replies.length === 1,
            JSON.stringify(needs)
        );

        // 12. ChatEnded taken: Take back on phone-chat
        await restartOn("main");
        await openChat("fx-phone-chat");
        await page.ev(phoneClick("[data-chat-takeback]"));
        const tookBack = await recorded("takeback", 1);
        await polishWaitFor(page, `document.querySelector('[data-chat-ended="taken"]') != null`, PHONE_WAIT_MS);
        await polishNap(300);
        await shot("12-ended-taken");
        const taken = await chatRead();
        await page.ev(phoneClickButton("Back to the list"));
        await polishWaitFor(page, `document.querySelectorAll("[data-handed-row]").length === 2`, PHONE_WAIT_MS);
        const afterTake = await read();
        rec(
            "12. ChatEnded taken: Take back is recorded, Back at the desk with the taken string, and the list drops phone-chat",
            tookBack &&
                JSON.stringify(records("takeback")[0].data) === JSON.stringify({ tab: "fx-phone-chat" }) &&
                taken.ended === "taken" &&
                taken.endedTitle === "Back at the desk" &&
                taken.endedText === PHONE_TAKEN_TEXT &&
                JSON.stringify(afterTake.handed.map((a) => a.name)) === JSON.stringify(["siem-deploy", "vault-sync"]),
            JSON.stringify({ taken, handed: afterTake.handed.map((a) => a.name) })
        );

        // 12b. ChatEnded exited: a tab whose agent exited, opened by its address
        await page.ev(`(location.hash = "#agent/${PHONE_EXITED_TAB}", true)`);
        await polishWaitFor(page, `document.querySelector('[data-chat-ended="exited"]') != null`, PHONE_WAIT_MS);
        await polishNap(300);
        await shot("12b-ended-exited");
        const exited = await chatRead();
        rec(
            "12b. ChatEnded exited: #agent/fx-exited draws Back at the desk with the exited string",
            exited.ended === "exited" && exited.endedTitle === "Back at the desk" && exited.endedText === PHONE_EXITED_TEXT,
            JSON.stringify(exited)
        );
        return steps;
    },
    async teardown(_h, ctx) {
        ctx.page?.close();
        await phoneStopPreview(ctx).catch(() => {});
        if (ctx.browser && ctx.browser.exitCode == null) {
            const exited = new Promise((r) => ctx.browser.once("exit", r));
            ctx.browser.kill();
            await exited;
        }
        rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
};

// --- setup memory: the Memory tab over fixture states in temp folders -----------------------------
// Arranged for real, with no test hook: createproject registers the fixture projects on temp git repos, and
// memory-fixtures.mjs writes their state files and backups into the dev store with real hashes, naming memory
// folders under the same temp root. Applies and undos then touch only those folders. No step runs a check, which
// calls a model. Copy is the memory-tab-redesign Prototype's boards, one step per board plus keys; a step that
// changes the state rebuilds the fixture first.
const MEMORY_FIXTURE_NAMES = Object.values(MEMORY_PROJECTS);
const MEMORY_WAIT_MS = 10000;
// a split's Apply and its Undo go one change at a time, each in its own state write
const MEMORY_APPLY_WAIT_MS = 120000;

function setupMemoryWrite(ctx, states) {
    writeMemoryStates(ctx.dataDir, states ?? ctx.fx.states);
    writeMemoryBackups(ctx.dataDir, ctx.fx.backups);
}

async function setupMemoryArrange(h) {
    const ctx = { root: mkdtempSync(join(tmpdir(), "verify-setup-memory-")), registered: [] };
    try {
        ctx.fx = buildMemoryFixture(ctx.root);
        ctx.dataDir = (await h.rpc("waveinfo", null)).datadir;
        for (const { name, path } of ctx.fx.projects) {
            await h.rpc("createproject", { name, path });
            ctx.registered.push({ name, path });
        }
        for (const { name } of ctx.fx.projects) await waitForProjectInConfig(h, name);
        setupMemoryWrite(ctx);
        await polishReload(h);
    } catch (e) {
        await setupMemoryTeardown(h, ctx).catch(() => {});
        throw e;
    }
    return ctx;
}

async function setupMemoryAssert(h, ctx) {
    const steps = [];
    const P = MEMORY_PROJECTS;
    const q = (s) => JSON.stringify(s);
    const has = (sel) => `!!document.querySelector(${q(sel)})`;
    const waitFor = (expr, ms = MEMORY_WAIT_MS) => polishWaitFor(h, expr, ms);
    const text = (sel) => h.ev(`(document.querySelector(${q(sel)})?.textContent ?? "").replace(/\\s+/g, " ").trim()`);
    const texts = (sel) =>
        h.ev(`[...document.querySelectorAll(${q(sel)})].map((e) => e.textContent.replace(/\\s+/g, " ").trim())`);
    const count = (sel) => h.ev(`document.querySelectorAll(${q(sel)}).length`);
    const click = async (sel) => {
        if (!(await h.ev(`(() => { const b = document.querySelector(${q(sel)}); if (!b) return false; b.click(); return true; })()`))) {
            throw new Error(`nothing to click at ${sel}`);
        }
    };
    // the list's rows and lines; the detail pane shows the selected one, its actions in its header
    const LIST = "nav[data-memory-list]";
    const D = "main[data-memory-detail]";
    const rowSel = (key) => `${LIST} [data-memory-row=${q(key)}]`;
    const lineSel = (key) => `${LIST} [data-memory-line=${q(key)}]`;
    const inD = (sel) => `${D} ${sel}`;
    const sub = (sel) => text(`${sel} [data-memory-sub]`);
    // a box's text without its buttons' labels
    const ownText = (sel) =>
        h.ev(`(() => {
            const el = document.querySelector(${q(sel)});
            if (!el) return "";
            const c = el.cloneNode(true);
            c.querySelectorAll("button").forEach((b) => b.remove());
            return c.textContent.replace(/\\s+/g, " ").trim();
        })()`);
    const shown = () => h.ev(`document.querySelector(${q(D)})?.getAttribute("data-memory-detail") ?? null`);
    const current = () =>
        h.ev(`[...document.querySelectorAll(${q(`${LIST} [aria-current="true"]`)})].map((e) => e.getAttribute("data-memory-row") ?? e.getAttribute("data-memory-line"))`);
    const select = async (sel, key) => {
        await click(sel);
        return waitFor(`document.querySelector(${q(D)})?.getAttribute("data-memory-detail") === ${q(key)}`);
    };
    const selectRow = (key) => select(rowSel(key), key);
    const selectLine = (key) => select(lineSel(key), key);
    const toolbar = () =>
        h.ev(`(document.getElementById("setup-tab-memory")?.closest("[data-surface-toolbar]")?.lastElementChild?.textContent ?? "").trim()`);
    const keysIn = (attr) => h.ev(`[...document.querySelectorAll(${q(`${LIST} [${attr}]`)})].map((e) => e.getAttribute(${q(attr)}))`);
    const rowProject = (key) => key.split("/")[1];
    const lineProject = (key) => key.split("/")[0];
    const monthDay = (ts) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const press = (key) =>
        h.ev(
            `document.dispatchEvent(new KeyboardEvent("keydown", { key: ${q(key)}, code: ${q(key.length === 1 ? `Key${key.toUpperCase()}` : key)}, bubbles: true }))`
        );
    const selected = () =>
        lookEval(h, `const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { memorySelectedAtom } = await mod("app/view/agents/memorystore.ts");
            return globalStore.get(memorySelectedAtom);`);
    // a did line's changes still applied, from the backend's own list
    const appliedIn = async (project, batchId) => {
        const p = (await h.rpc("listmemoryhygiene", null)).projects.find((x) => x.project === project);
        const b = p?.batches?.find((x) => x.id === batchId);
        return (b?.changeids ?? []).filter((id) => p.changes.find((c) => c.id === id)?.status === "applied").length;
    };
    // name -> sha256 ("dir" for a folder) of each entry in the dirs, and of each file given
    const snapshot = (dirs, files = []) => {
        const out = {};
        for (const d of dirs) {
            if (!existsSync(d)) continue;
            for (const n of readdirSync(d)) {
                const p = join(d, n);
                out[p] = statSync(p).isDirectory() ? "dir" : sha256File(p);
            }
        }
        for (const f of files) out[f] = sha256File(f);
        return out;
    };
    const snapDiff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
    const openTab = async () => {
        await h.goto("setup");
        await click("#setup-tab-memory");
        return waitFor(`${has("[data-memory-waiting]")} || ${has("[data-memory-empty]")}`);
    };
    // a fresh fixture, and a reload, so no row result or opened row from an earlier step carries over
    const reset = async (states) => {
        ctx.fx = buildMemoryFixture(ctx.root);
        setupMemoryWrite(ctx, states?.(ctx.fx));
        await polishReload(h);
        if (!(await openTab())) throw new Error("the Memory tab did not list after the reset");
    };
    const run = async (step, shot, fn) => {
        try {
            const r = await fn();
            steps.push(r.skip ? skipStep(step, r.detail) : { step, ok: r.ok, detail: r.detail });
        } catch (e) {
            steps.push({ step, ok: false, detail: String(e?.message ?? e) });
        }
        await h.shot(`cdp-shots/setup-memory-${shot}.png`).catch(() => {});
    };
    const fx = () => ctx.fx;
    const splitKey = (p) => `split/${p}`;
    const repo = MEMORY_SHARED_REPO;
    // the fixture's waiting rows and this week's did lines, in board order
    const boardRows = () => [
        splitKey(P.splitA),
        splitKey(P.splitB),
        `cleanup/${P.former}`,
        ...fx().docs.map((c) => `doc/${P.former}/${c.id}`),
        `failed/${P.former}`,
    ];
    const boardLines = () => [
        `${P.own}/${fx().batches.ownRoutine}`,
        `${P.former}/${fx().batches.formerCleanup}`,
        `${P.splitC}/${fx().batches.splitC}`,
        `${P.former}/${fx().batches.formerRoutine}`,
    ];
    const splitA = fx().splitA;
    const total = splitA.moves.length + splitA.copies.length;
    const stay = () => fx().states[P.splitA].memories - total;
    const openSub = () => `${total} come over: ${splitA.moves.length} move, ${splitA.copies.length} copy · ${stay()} stay in ${repo}’s`;
    const settingsA = () => fx().splitA.settings.op.settingspath;
    // a split's Apply from the detail header, with the row selected first; resolves once its stop or its did line shows
    const applySplit = async (until) => {
        await selectRow(splitKey(P.splitA));
        await click(inD("[data-memory-apply]"));
        return waitFor(until, MEMORY_APPLY_WAIT_MS);
    };
    const stopSel = (kind) => inD(`[data-memory-stop=${q(kind)}]`);
    // a stop box holds its text only; Undo the N and Check now sit in the detail header
    const stopRead = async (kind) => ({
        text: await text(stopSel(kind)),
        inBox: await count(`${stopSel(kind)} button`),
        undo: await text(inD('[data-memory-undo="split"]')),
        check: await text(inD("[data-memory-check]")),
    });

    await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    if (!(await openTab())) throw new Error("the Memory tab did not list");

    await run(
        "1. memory-page (FlowAuto): list rows in board order with 20px icon boxes and <chip> · <sub> subs, the toolbar count, this week's did lines, the split selected with every item, Keep sharing and Apply and switch over",
        "page",
        async () => {
            const rows = await keysIn("data-memory-row");
            const failed = rows.filter((k) => k.startsWith("failed/")).length;
            const wantToolbar = `${rows.length} waiting for you${failed > 0 ? ` · ${failed} check${failed === 1 ? "" : "s"} failed` : ""}`;
            const key = splitKey(P.splitA);
            const selectedOk = await selectRow(key);
            const chips = { split: "Own memory", cleanup: "Clear", doc: "Move to CLAUDE.md", failed: "Check failed" };
            const fixtureRows = rows.filter((k) => MEMORY_FIXTURE_NAMES.includes(rowProject(k)));
            const fixtureLines = (await keysIn("data-memory-line")).filter((k) => MEMORY_FIXTURE_NAMES.includes(lineProject(k)));
            const badSubs = [];
            for (const k of fixtureRows) {
                const s = await sub(rowSel(k));
                if (!s.startsWith(`${chips[k.split("/")[0]]} · `)) badSubs.push({ k, s });
            }
            for (const k of fixtureLines) {
                const s = await sub(lineSel(k));
                if (!s.startsWith("Applied · ")) badSubs.push({ k, s });
            }
            const items = (sel) => h.ev(`[...document.querySelectorAll(${q(sel)})].map((e) => e.getAttribute("data-memory-item"))`);
            const got = {
                rows: fixtureRows,
                toolbar: await toolbar(),
                head: await text("[data-memory-waiting] > :first-child"),
                lines: fixtureLines,
                // every list row and line holds a 20px box with its icon
                noIcon: await h.ev(`[...document.querySelectorAll(${q(`${LIST} [data-memory-row], ${LIST} [data-memory-line]`)})]
                    .filter((b) => ![...b.querySelectorAll("*")].some((e) => {
                        const r = e.getBoundingClientRect();
                        return Math.round(r.width) === 20 && Math.round(r.height) === 20 && !!e.querySelector("svg");
                    }))
                    .map((b) => b.getAttribute("data-memory-row") ?? b.getAttribute("data-memory-line"))`),
                badSubs,
                selectedOk,
                current: await current(),
                listSub: await sub(rowSel(key)),
                title: await text(inD("[data-memory-title]")),
                sub: await text(inD("[data-memory-sub]")),
                groups: await texts(inD("[data-memory-split] [data-memory-group]")),
                items: await items(inD("[data-memory-split] [data-memory-item]")),
                leaveOuts: await count(inD("[data-memory-split] [data-memory-item] [data-memory-leaveout]")),
                showAll: await count("[data-memory-showall], [data-memory-below]"),
                keep: await text(inD("[data-memory-keep]")),
                apply: await text(inD("[data-memory-apply]")),
                intro: await h.ev(has(inD("[data-memory-intro]"))),
            };
            const wantItems = [...splitA.moves, ...splitA.copies].map((c) => c.id).sort();
            return {
                ok:
                    q(got.rows) === q(boardRows()) &&
                    got.toolbar === wantToolbar &&
                    got.head === `Waiting for you · ${rows.length}` &&
                    q(got.lines) === q(boardLines()) &&
                    got.noIcon.length === 0 &&
                    got.badSubs.length === 0 &&
                    selectedOk &&
                    q(got.current) === q([key]) &&
                    got.listSub === `Own memory · ${openSub()}` &&
                    got.title === `Give ${P.splitA} its own memory` &&
                    got.sub === openSub() &&
                    got.groups.length === 2 &&
                    got.groups[0].startsWith(`Move here · ${splitA.moves.length}`) &&
                    got.groups[1].startsWith(`Copy here · ${splitA.copies.length}`) &&
                    q([...got.items].sort()) === q(wantItems) &&
                    got.leaveOuts === total &&
                    got.showAll === 0 &&
                    got.keep === "Keep sharing" &&
                    got.apply === "Apply and switch over" &&
                    got.intro,
                detail: JSON.stringify(got),
            };
        }
    );

    await run(
        "2. split-all-left-out (AutoAll): every item in the box; Leave out one and it reads muted Left out with Bring back, the counts following; Bring back restores them",
        "split-all-left-out",
        async () => {
            const key = splitKey(P.splitA);
            const moved = splitA.moves[0];
            const item = inD(`[data-memory-split] [data-memory-item=${q(moved.id)}]`);
            await selectRow(key);
            const all = await count(inD("[data-memory-split] [data-memory-item]"));
            // the color of the item's title, found by its text
            const titleColor = () =>
                h.ev(`(() => {
                    const el = [...(document.querySelector(${q(item)})?.querySelectorAll("*") ?? [])].find((e) => e.textContent.trim() === ${q(moved.title)});
                    return el ? getComputedStyle(el).color : null;
                })()`);
            const colorBefore = await titleColor();
            await click(`${item} [data-memory-leaveout]`);
            const leftSub = `${total - 1} come over · 1 left out · ${stay() + 1} stay in ${repo}’s`;
            const left = await waitFor(`(document.querySelector(${q(inD("[data-memory-sub]"))})?.textContent ?? "").trim() === ${q(leftSub)}`);
            const leftOut = {
                sub: await text(inD("[data-memory-sub]")),
                listSub: await sub(rowSel(key)),
                item: await ownText(item),
                button: await text(`${item} [data-memory-leaveout]`),
                color: await titleColor(),
                items: await count(inD("[data-memory-split] [data-memory-item]")),
            };
            await h.shot("cdp-shots/setup-memory-split-left-out.png");
            await click(`${item} [data-memory-leaveout]`);
            const back = await waitFor(`(document.querySelector(${q(inD("[data-memory-sub]"))})?.textContent ?? "").trim() === ${q(openSub())}`);
            const got = {
                all,
                colorBefore,
                left,
                leftOut,
                back,
                listSub: await sub(rowSel(key)),
                button: await text(`${item} [data-memory-leaveout]`),
                color: await titleColor(),
            };
            return {
                ok:
                    all === total &&
                    left &&
                    leftOut.listSub === `Own memory · ${leftSub}` &&
                    leftOut.item.includes("Left out") &&
                    leftOut.button === "Bring back" &&
                    colorBefore != null &&
                    leftOut.color !== colorBefore &&
                    leftOut.items === total &&
                    back &&
                    got.listSub === `Own memory · ${openSub()}` &&
                    got.button === "Leave out" &&
                    got.color === colorBefore,
                detail: JSON.stringify(got),
            };
        }
    );

    // the observer goes in before Apply is clicked, so the progress line is seen however briefly it shows. A frame
    // sampler goes in with it: the did section must never sit under a waiting list row while rows move (the leaving
    // row, lifted out by popLayout, travels into its did line by design and is not counted)
    await run(
        "3. split-applying (AutoApplying): while Apply runs the detail shows Bringing over N of M through counts in between, seen by a MutationObserver installed before the click, and no waiting list row overlaps Arc did this week in any frame",
        "split-applying",
        async () => {
            ctx.splitBefore = snapshot([fx().paths.shared, fx().paths.ownA], [settingsA()]);
            await selectRow(splitKey(P.splitA));
            const clicked = await h.ev(`(() => {
                const log = (window.__memoryProgress = []);
                const read = () => {
                    const el = document.querySelector("[data-memory-progress]");
                    if (!el) return;
                    const t = (el.firstElementChild?.textContent ?? "").trim();
                    const w = el.querySelector("span > span")?.style.width ?? "";
                    const last = log[log.length - 1];
                    if (!last || last.text !== t || last.width !== w) log.push({ text: t, width: w });
                };
                window.__memoryProgressObserver?.disconnect();
                window.__memoryProgressObserver = new MutationObserver(read);
                window.__memoryProgressObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style"] });
                const frames = (window.__memoryFrames = { n: 0, overlaps: [], stop: false });
                const sample = () => {
                    if (frames.stop) return;
                    frames.n++;
                    const did = document.querySelector(${q(`${LIST} [data-memory-did]`)})?.getBoundingClientRect();
                    if (did) {
                        for (const el of document.querySelectorAll(${q(`${LIST} [data-memory-row]`)})) {
                            // popLayout lifts the leaving row, or the motion wrapper around it, out of the flow
                            let lifted = false;
                            for (let a = el; a && !a.matches("[data-memory-waiting]"); a = a.parentElement) {
                                if (getComputedStyle(a).position === "absolute") lifted = true;
                            }
                            if (lifted) continue;
                            const r = el.getBoundingClientRect();
                            if (r.bottom > did.top + 0.5 && r.top < did.bottom - 0.5 && frames.overlaps.length < 5) {
                                frames.overlaps.push({ frame: frames.n, row: el.getAttribute("data-memory-row"), rowBottom: r.bottom, didTop: did.top });
                            }
                        }
                    }
                    requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
                const b = document.querySelector(${q(inD("[data-memory-apply]"))});
                if (!b) return false;
                b.click();
                return true;
            })()`);
            await h.shot("cdp-shots/setup-memory-split-applying-live.png");
            const done = await waitFor(`!${has(rowSel(splitKey(P.splitA)))} && ${has(`[data-memory-line^="${P.splitA}/"]`)}`, MEMORY_APPLY_WAIT_MS);
            // past the row's exit and the rows' reflow, so the frames cover them settling
            await polishNap(1000);
            const frames = await h.ev(`(() => { const f = window.__memoryFrames ?? { n: 0, overlaps: [] }; f.stop = true; return { n: f.n, overlaps: f.overlaps }; })()`);
            const log = await h.ev(`(window.__memoryProgressObserver?.disconnect(), window.__memoryProgress ?? [])`);
            const re = new RegExp(`^Bringing over (\\d+) of ${total}, then switching over…$`);
            const counts = [...new Set(log.filter((e) => re.test(e.text)).map((e) => Number(re.exec(e.text)[1])))];
            return {
                ok: clicked && done && counts.some((n) => n > 0 && n < total) && frames.n > 0 && frames.overlaps.length === 0,
                detail: JSON.stringify({ clicked, done, progress: log.length, first: log[0], last: log[log.length - 1], counts, frames }),
            };
        }
    );

    await run(
        "4. split-applied (AutoApplied): the applied split leaves the waiting list for a did line and the detail follows it there, with Undo all N and no See toggle; Undo all restores the files, the row returns and the detail shows it again",
        "split-applied",
        async () => {
            const key = splitKey(P.splitA);
            const lineKey = (await keysIn("data-memory-line")).find((k) => k.startsWith(`${P.splitA}/`));
            if (lineKey == null) return { ok: false, detail: "no did line for the split: step 3 did not apply it" };
            const line = lineSel(lineKey);
            const n = await appliedIn(P.splitA, lineKey.slice(P.splitA.length + 1));
            const textRe = `Own memory since (today|yesterday) at \\d\\d:\\d\\d · ${total} came over · switched over`;
            const applied = {
                row: await h.ev(has(rowSel(key))),
                shown: await shown(),
                current: await current(),
                listSub: await sub(line),
                sub: await text(inD("[data-memory-sub]")),
                see: await count("[data-memory-see]"),
                undoAll: await text(inD('[data-memory-undo="all"]')),
                n,
                switched: existsSync(settingsA()) && readFileSync(settingsA(), "utf8").includes("autoMemoryDirectory"),
            };
            await h.shot("cdp-shots/setup-memory-split-applied-line.png");
            await click(inD('[data-memory-undo="all"]'));
            const back = await waitFor(`${has(rowSel(key))} && !${has(line)}`, MEMORY_APPLY_WAIT_MS);
            const diff = snapDiff(ctx.splitBefore ?? {}, snapshot([fx().paths.shared, fx().paths.ownA], [settingsA()]));
            const got = {
                applied,
                back,
                shown: await shown(),
                sub: await text(inD("[data-memory-sub]")),
                changedFiles: diff,
                error: await text("[data-memory-error]"),
            };
            return {
                ok:
                    applied.row === false &&
                    applied.shown === lineKey &&
                    q(applied.current) === q([lineKey]) &&
                    new RegExp(`^Applied · ${textRe}$`).test(applied.listSub) &&
                    new RegExp(`^${textRe}$`).test(applied.sub) &&
                    applied.see === 0 &&
                    n > 0 &&
                    applied.undoAll === `Undo all ${n}` &&
                    applied.switched &&
                    back &&
                    got.shown === key &&
                    got.sub === openSub() &&
                    ctx.splitBefore != null &&
                    diff.length === 0 &&
                    got.error === "",
                detail: JSON.stringify(got),
            };
        }
    );

    await run(
        "5. split-changed (AutoChanged): a memory edited on disk after the check stops Apply before switching, with Undo the N and Check now, and the settings file is unchanged",
        "split-changed",
        async () => {
            await reset();
            const edited = fx().splitA.moves[5];
            const path = join(fx().paths.shared, edited.op.memories[0]);
            writeFileSync(path, `${readFileSync(path, "utf8")}Edited after the check.\n`);
            const stopped = await applySplit(has(stopSel("changed")));
            const here = total - 1;
            const want =
                `${here} of ${total} already here. 1 memory changed on disk after the ${monthDay(fx().states[P.splitA].checkedat)} check, ` +
                `so Arc left it in ${repo}’s memory and has not switched over. Check again to sort it; Apply then brings it over and switches.`;
            const got = { stopped, ...(await stopRead("changed")), settings: existsSync(settingsA()) };
            return {
                ok:
                    stopped &&
                    got.text === want &&
                    got.inBox === 0 &&
                    got.undo === `Undo the ${here}` &&
                    got.check === "Check now" &&
                    got.settings === false,
                detail: JSON.stringify(got),
            };
        }
    );

    await run(
        "6. split-newer (AutoNewer): a memory written to the shared folder after the check stops Apply before switching",
        "split-newer",
        async () => {
            await reset();
            writeFileSync(join(fx().paths.shared, "written-after-check.md"), "---\nname: Written after the check\ndescription: new\n---\n\nNew.\n");
            const stopped = await applySplit(has(stopSel("newer")));
            const want =
                `${total} of ${total} already here, not switched over. 1 memory was written to ${repo}’s memory after the check and has no ` +
                `sort yet; switching now would leave it out of ${P.splitA}’s sessions. Check again, then Apply switches over.`;
            const got = { stopped, ...(await stopRead("newer")), settings: existsSync(settingsA()) };
            return {
                ok:
                    stopped &&
                    got.text === want &&
                    got.inBox === 0 &&
                    got.undo === `Undo the ${total}` &&
                    got.check === "Check now" &&
                    got.settings === false,
                detail: JSON.stringify(got),
            };
        }
    );

    await run(
        "7. split-failed (AutoFailed): a copy made to fail stops Apply naming it, with Try again",
        "split-failed",
        async () => {
            await reset();
            const { failAt, moves } = fx().splitA;
            const blocked = moves[failAt];
            // a folder where the copy goes: hashing the destination errors, which is an apply error, not a conflict
            mkdirSync(join(fx().paths.ownA, blocked.op.memories[0]), { recursive: true });
            const stopped = await applySplit(has(stopSel("failed")));
            const got = {
                stopped,
                ...(await stopRead("failed")),
                retry: await text(inD("[data-memory-apply]")),
                tag: await text(inD("[data-memory-tag]")),
                listTag: await text(`${rowSel(splitKey(P.splitA))} [data-memory-tag]`),
                settings: existsSync(settingsA()),
            };
            return {
                ok:
                    stopped &&
                    got.text.startsWith(`Stopped at ${failAt + 1} of ${total}. “${blocked.title}” did not move: `) &&
                    got.text.endsWith(`. ${P.splitA} is not switched over; the ${failAt} already here stay.`) &&
                    got.inBox === 0 &&
                    got.retry === "Try again" &&
                    got.undo === `Undo the ${failAt}` &&
                    got.tag === `${failAt} of ${total} here` &&
                    got.listTag === got.tag &&
                    got.settings === false,
                detail: JSON.stringify(got),
            };
        }
    );

    await run(
        "8. undo-refused (AutoUndoRefused): Undo all on the split a cleanup took from shows the refusal in the detail, settled inside the pane, with Undo the cleanup, and no file changes",
        "undo-refused",
        async () => {
            await reset();
            const key = `${P.splitC}/${fx().batches.splitC}`;
            const watched = () => snapshot([fx().paths.shared, fx().paths.ownC], [fx().paths.settingsC]);
            const before = watched();
            const selectedOk = await selectLine(key);
            await click(inD('[data-memory-undo="all"]'));
            const refused = inD("[data-memory-undo-refused]");
            const shownOk = await waitFor(has(refused));
            await polishNap(1000);
            // the settled box lies wholly inside the detail pane
            const inside = await h.ev(`(() => {
                const box = document.querySelector(${q(refused)})?.getBoundingClientRect();
                const pane = document.querySelector(${q(D)})?.getBoundingClientRect();
                return !!box && !!pane && box.height > 0 && box.top >= pane.top - 0.5 && box.bottom <= pane.bottom + 0.5 && box.left >= pane.left - 0.5 && box.right <= pane.right + 0.5;
            })()`);
            const cleanupAt = fx().states[P.former].batches.find((b) => b.id === fx().batches.formerCleanup).at;
            const want =
                `Can’t undo yet. Clearing ${repo}’s memory on ${monthDay(cleanupAt)} removed 1 memory this split brought over; ` +
                `undoing the split now would leave ${P.splitC}’s sessions without it. Undo that cleanup first.`;
            // the backend refuses the same undo, so the CLI can't undo past it either
            const backend = await h
                .rpc("undomemorybatch", { project: P.splitC, batchid: fx().batches.splitC, changeid: "" })
                .then(() => "undone", (e) => String(e?.message ?? e));
            const got = {
                selectedOk,
                shownOk,
                inside,
                text: await ownText(refused),
                undoCleanup: await text(inD('[data-memory-undo="cleanup"]')),
                backend,
                changedFiles: snapDiff(before, watched()),
            };
            return {
                ok:
                    selectedOk &&
                    shownOk &&
                    inside &&
                    got.text === want &&
                    got.undoCleanup === "Undo the cleanup" &&
                    backend.includes(`can't undo the split of ${P.splitC}`) &&
                    got.changedFiles.length === 0,
                detail: JSON.stringify(got),
            };
        }
    );

    await run(
        "9. cleanup-open (AutoCleanup): the cleanup selected with its list, Leave out on each, Keep them and Clear N in the header",
        "cleanup-open",
        async () => {
            await reset();
            const key = `cleanup/${P.former}`;
            const opened = await selectRow(key);
            const open = fx().states[P.former].changes.filter((c) => c.kind === "remove-shared" && c.status === "open");
            const switchedAt = fx().states[P.former].switchedat;
            const got = {
                opened,
                title: await text(inD("[data-memory-title]")),
                sub: await text(inD("[data-memory-sub]")),
                body: await text(inD("[data-memory-body]")),
                items: await count(inD("[data-memory-item]")),
                leaveOut: await count(inD("[data-memory-item] [data-memory-leaveout]")),
                keep: await text(inD("[data-memory-keep]")),
                apply: await text(inD("[data-memory-apply]")),
            };
            return {
                ok:
                    opened &&
                    got.title === `Clear ${open.length} memories no project loads from ${repo}’s memory` &&
                    got.sub === `${P.former} took them on ${monthDay(switchedAt)}; no other project loads them` &&
                    got.body ===
                        `These stay in ${P.former}’s own memory. Clearing them only takes them out of ${repo}’s, which ${P.splitA} and ${P.splitB} load.` &&
                    got.items === open.length &&
                    got.leaveOut === open.length &&
                    got.keep === "Keep them" &&
                    got.apply === `Clear ${open.length}`,
                detail: JSON.stringify(got),
            };
        }
    );

    await run("10. doc-open: a doc move selected with its evidence, two diffs, Keep and Move to CLAUDE.md", "doc-open", async () => {
        const doc = fx().docs[0];
        const key = `doc/${P.former}/${doc.id}`;
        const opened = await selectRow(key);
        const got = {
            opened,
            current: await current(),
            title: await text(inD("[data-memory-title]")),
            evidence: await count(inD("[data-memory-evidence]")),
            diffs: await texts(inD("[data-memory-diff]")),
            keep: await text(inD("[data-memory-keep]")),
            apply: await text(inD("[data-memory-apply]")),
        };
        return {
            ok:
                opened &&
                q(got.current) === q([key]) &&
                got.title === doc.title &&
                got.evidence > 0 &&
                got.evidence === doc.evidence.length &&
                got.diffs.length === 2 &&
                got.diffs[0].includes(doc.op.docpassage) &&
                got.keep === "Keep" &&
                got.apply === "Move to CLAUDE.md",
            detail: JSON.stringify(got),
        };
    });

    await run(
        "11. digest-open (AutoDigest): a selected did line shows per-change Undo, the index line and Undo all N in the header, with no See toggle; one change's Undo takes it out of the counts",
        "digest-open",
        async () => {
            const key = `${P.own}/${fx().batches.ownRoutine}`;
            const line = lineSel(key);
            const routine = fx().states[P.own].batches.find((b) => b.id === fx().batches.ownRoutine);
            const n = routine.changeids.length;
            const opened = await selectLine(key);
            const ix = (s) => `${s.lines} lines, ${(s.bytes / 1000).toFixed(1)} KB`;
            const before = {
                opened,
                listText: await sub(line),
                text: await text(inD("[data-memory-sub]")),
                see: await count("[data-memory-see]"),
                items: await count(inD("[data-memory-item]")),
                undos: await count(inD('[data-memory-undo="change"]')),
                index: await text(inD("[data-memory-index]")),
                undoAll: await text(inD('[data-memory-undo="all"]')),
            };
            await h.shot("cdp-shots/setup-memory-digest-opened.png");
            const trim = fx().trims[0];
            await click(inD(`[data-memory-item=${q(trim.change.id)}] [data-memory-undo="change"]`));
            const undone = await waitFor(`(document.querySelector(${q(inD('[data-memory-undo="all"]'))})?.textContent ?? "").trim() === ${q(`Undo all ${n - 1}`)}`);
            const after = {
                undone,
                listText: await sub(line),
                text: await text(inD("[data-memory-sub]")),
                items: await count(inD("[data-memory-item]")),
                restored: readFileSync(trim.path, "utf8") === trim.pre,
                error: await text("[data-memory-error]"),
            };
            const when = "(today|yesterday) at \\d\\d:\\d\\d";
            const textRe = (m, trims) => `${m} changes ${when} · ${trims} trims, 1 delete · 1 trim skipped: changed after the check`;
            return {
                ok:
                    opened &&
                    new RegExp(`^${textRe(n, 3)}$`).test(before.text) &&
                    new RegExp(`^Applied · ${textRe(n, 3)}$`).test(before.listText) &&
                    before.see === 0 &&
                    before.items === n &&
                    before.undos === n &&
                    before.index === `${P.own}’s MEMORY.md: ${ix(routine.indexafter)} after these, from ${ix(routine.indexbefore)}` &&
                    before.undoAll === `Undo all ${n}` &&
                    undone &&
                    new RegExp(`^${textRe(n - 1, 2)}$`).test(after.text) &&
                    new RegExp(`^Applied · ${textRe(n - 1, 2)}$`).test(after.listText) &&
                    after.items === n - 1 &&
                    after.restored &&
                    after.error === "",
                detail: JSON.stringify({ before, after }),
            };
        }
    );

    await run("12. empty (AutoEmpty): with nothing waiting, the list reads Nothing waits for you and the next check's day, and the detail shows the first did line", "empty", async () => {
        await reset((built) => settleMemoryStates(built.states));
        const others = (await keysIn("data-memory-row")).filter((k) => !MEMORY_FIXTURE_NAMES.includes(rowProject(k)));
        if (others.length > 0) {
            return { skip: true, detail: `this store's own projects have rows waiting: ${others.join(", ")}` };
        }
        const listed = (await h.rpc("listmemoryhygiene", null)).projects;
        const next = Math.min(...listed.map((p) => p.nextcheckat).filter((t) => t > 0));
        const day = new Date(next).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
        const lines = await keysIn("data-memory-line");
        const got = {
            empty: await text(`${LIST} [data-memory-empty]`),
            waiting: await h.ev(has("[data-memory-waiting]")),
            did: await h.ev(has(`${LIST} [data-memory-did]`)),
            toolbar: await toolbar(),
            lines: lines.filter((k) => MEMORY_FIXTURE_NAMES.includes(lineProject(k))).length,
            first: lines[0] ?? null,
            shown: await shown(),
            current: await current(),
            intro: await h.ev(has(inD("[data-memory-intro]"))),
        };
        return {
            ok:
                got.empty === `Nothing waits for you. The next check runs ${day}.` &&
                got.waiting === false &&
                got.did &&
                got.toolbar === "Nothing waits for you" &&
                got.lines > 0 &&
                got.shown === got.first &&
                q(got.current) === q([got.first]) &&
                got.intro,
            detail: JSON.stringify(got),
        };
    });

    await run("13. keys: j, j, k move the selection through the list and the detail follows each", "keys", async () => {
        await reset();
        const rows = await keysIn("data-memory-row");
        if (rows.length < 3) return { ok: false, detail: `three rows needed, got ${q(rows)}` };
        // a stored start, so the steps don't hang on where an unset selection steps from
        const start = await selectRow(rows[0]);
        await h.ev(`document.activeElement?.blur?.()`);
        const trail = [];
        for (const k of ["j", "j", "k"]) {
            await press(k);
            await polishNap(150);
            trail.push({ selected: await selected(), shown: await shown(), current: (await current())[0] ?? null });
        }
        const want = [rows[1], rows[2], rows[1]].map((k) => ({ selected: k, shown: k, current: k }));
        return {
            ok: start && q(trail) === q(want),
            detail: JSON.stringify({ rows: rows.slice(0, 3), start, trail }),
        };
    });

    return steps;
}

async function setupMemoryTeardown(h, ctx) {
    const failed = [];
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            failed.push(`${what}: ${e?.message ?? e}`);
        }
    };
    const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const paths = new Set(ctx.registered.map((r) => norm(r.path)));
    for (const { name } of ctx.registered) await step(`delete project ${name}`, () => h.rpc("deleteproject", { name }));
    // createproject made a channel at each path, which deleteproject leaves
    await step("delete the projects' channels", async () => {
        const channels = (await h.rpc("getchannels", null))?.channels ?? [];
        for (const c of channels.filter((c) => paths.has(norm(c.projectpath)))) {
            await h.rpc("deletechannel", { channelid: c.oid });
        }
    });
    if (ctx.dataDir) {
        for (const name of MEMORY_FIXTURE_NAMES) {
            await step(`remove the state of ${name}`, () => rmSync(memoryStatePath(ctx.dataDir, name), { force: true }));
        }
        // the fixture's backups, and each one an apply in a step made of the fixture's files
        await step("remove the fixture's backups", () => {
            for (const id of memoryBackupsUnder(ctx.dataDir, ctx.root)) {
                rmSync(memoryBackupDir(ctx.dataDir, id), { recursive: true, force: true });
            }
        });
    }
    await step("remove the temp root", () => rmSync(ctx.root, { recursive: true, force: true, maxRetries: 3 }));
    await step("reload", () => polishReload(h));
    await step("return to the cockpit", () => h.goto("cockpit"));
    if (failed.length > 0) throw new Error(`setup-memory teardown: ${failed.join("; ")}`);
}

export const setupMemory = {
    name: "setup-memory",
    surface: "setup",
    arrange: setupMemoryArrange,
    assert: setupMemoryAssert,
    teardown: setupMemoryTeardown,
};
