// Settings and Setup scenarios, remote access included.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACE_LABEL, openPage } from "./attach.mjs";
import {
    MEMORY_FAILED_ERROR,
    MEMORY_PROJECTS,
    MEMORY_SHARED_REPO,
    buildMemoryFixture,
    memoryBackupDir,
    memoryStatePath,
    settleMemoryStates,
    writeMemoryStates,
} from "./memory-fixtures.mjs";
import {
    MIN_FONT_PX,
    floorStep,
    git,
    lookEval,
    paintEval,
    polishNap,
    polishReload,
    polishWaitFor,
    setFinderQuery,
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

// --- settings-vault-sync: the Sync now button on Settings > Vault's Sync remote row ---------------------
// The dev app is pointed at a throwaway vault (wavevault opens the configured root on every call), first with
// no remote, then with a bare temp remote, then with a remote that does not exist. The configured vault is
// never touched: under a plain `task dev` it may be the user's real one. The error note renders as a sibling
// after the row, so its absence is checked in the whole section pane.
const VAULT_PANE = `document.querySelector('[data-settings-section="memory"]')`;
const VAULT_ROW = `${VAULT_PANE}?.querySelector('[data-setting-row="memory.remote"]')`;
const VAULT_SYNC_BTN = `${VAULT_PANE}?.querySelector('[data-testid="vault-sync-now"]')`;
const VAULT_SYNC_STATUS = `${VAULT_PANE}?.querySelector('[data-testid="vault-sync-status"]')`;
const VAULT_SYNC_ERROR = `${VAULT_PANE}?.querySelector('[data-testid="vault-sync-error"]')`;
// a first push to an empty bare remote is quick; a sync that takes longer is a failure worth seeing
const VAULT_SYNC_WAIT_MS = 30_000;
const vaultSyncState = (h) =>
    h.ev(`(() => {
        const b = ${VAULT_SYNC_BTN};
        const s = ${VAULT_SYNC_STATUS};
        return {
            button: b ? { label: (b.textContent || "").trim(), disabled: b.disabled } : null,
            status: s ? (s.textContent || "").trim() : null,
            note: ${VAULT_SYNC_ERROR} != null,
        };
    })()`);

// the section loads the vault status once, on mount, so a remote set over RPC shows only after a remount
async function openVaultSection(h) {
    await h.goto("cockpit");
    await h.goto("settings");
    await h.ev(`document.querySelector('[data-section="memory"]')?.click()`);
    return polishWaitFor(h, `${VAULT_ROW} != null && ${VAULT_SYNC_STATUS} != null`, 5000);
}

async function teardownVaultSync(h, ctx) {
    if (ctx.vaultConfigured) {
        await h.rpc("vaultsetremote", { url: "" });
        await h.rpc("setconfig", { "memory:vaultpath": ctx.prevVaultPath });
    }
    for (const dir of [ctx.vault, ctx.remote]) {
        if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
}

export const settingsVaultSync = {
    name: "settings-vault-sync",
    surface: "settings",
    async arrange(h) {
        const settings = (await h.rpc("getfullconfig", null))?.settings ?? {};
        const ctx = { prevVaultPath: settings["memory:vaultpath"] ?? null };
        try {
            ctx.vault = mkdtempSync(join(tmpdir(), "verify-vault-"));
            ctx.remote = mkdtempSync(join(tmpdir(), "verify-vault-remote-"));
            execFileSync("git", ["init", "--bare", ctx.remote], { stdio: "ignore" });
            await h.rpc("setconfig", { "memory:vaultpath": ctx.vault });
            ctx.vaultConfigured = true;
        } catch (e) {
            await teardownVaultSync(h, ctx);
            throw e;
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        const opened = await openVaultSection(h);
        await polishWaitFor(h, `(${VAULT_SYNC_STATUS}?.textContent || "").includes("Sync off")`, 5000);
        const off = await vaultSyncState(h);
        rec(
            "1. with no remote the Sync now button is disabled and the status reads Sync off",
            opened &&
                off.button?.label === "Sync now" &&
                off.button.disabled === true &&
                off.status === "Sync off — no remote",
            JSON.stringify(off)
        );
        await h.ev(`${VAULT_ROW}?.scrollIntoView({ block: "center" })`);
        await polishNap(200);
        await h.shot("cdp-shots/settings-vault-sync-off.png");

        await h.rpc("vaultsetremote", { url: ctx.remote });
        await openVaultSection(h);
        await polishWaitFor(h, `${VAULT_SYNC_BTN}?.disabled === false`, 5000);
        const idle = await vaultSyncState(h);
        rec(
            "2. with a remote the Sync now button is enabled",
            idle.button?.label === "Sync now" && idle.button.disabled === false,
            JSON.stringify(idle)
        );
        await h.ev(`${VAULT_ROW}?.scrollIntoView({ block: "center" })`);
        await polishNap(200);
        await h.shot("cdp-shots/settings-vault-sync-idle.png");

        // the local in-flight flag renders before the rpc returns, so one frame after the click shows it
        const clicked = await h.ev(`(async () => {
            const b = ${VAULT_SYNC_BTN};
            if (!b) return null;
            b.click();
            await new Promise((r) => requestAnimationFrame(() => r()));
            const n = ${VAULT_SYNC_BTN};
            return { label: (n?.textContent || "").trim(), disabled: n?.disabled ?? null };
        })()`);
        rec(
            "3. a click marks the button Syncing… and disables it at once",
            clicked?.label === "Syncing…" && clicked.disabled === true,
            JSON.stringify(clicked)
        );
        await h.shot("cdp-shots/settings-vault-sync-syncing.png");

        await polishWaitFor(
            h,
            `(${VAULT_SYNC_STATUS}?.textContent || "").trim() === "Last synced just now" && ${VAULT_SYNC_BTN}?.disabled === false`,
            VAULT_SYNC_WAIT_MS
        );
        const synced = await vaultSyncState(h);
        rec(
            "4. the sync lands: Last synced just now, the button enabled, no error note",
            synced.status === "Last synced just now" && synced.button?.disabled === false && synced.note === false,
            JSON.stringify(synced)
        );

        await h.rpc("vaultsetremote", { url: join(ctx.remote, "missing") });
        await h.ev(`${VAULT_SYNC_BTN}?.click()`);
        await polishWaitFor(
            h,
            `(${VAULT_SYNC_STATUS}?.textContent || "").startsWith("Sync failed:") && ${VAULT_SYNC_BTN}?.disabled === false`,
            VAULT_SYNC_WAIT_MS
        );
        const failed = await vaultSyncState(h);
        const colors = await h.ev(`(() => {
            const s = ${VAULT_SYNC_STATUS};
            const probe = document.createElement("span");
            probe.style.color = "var(--color-error)";
            document.body.appendChild(probe);
            const token = getComputedStyle(probe).color;
            probe.remove();
            return { status: s ? getComputedStyle(s).color : null, token };
        })()`);
        rec(
            "5. a failed sync shows once, in the status line in the error color, and the button allows a retry",
            failed.status?.startsWith("Sync failed:") === true &&
                colors.status === colors.token &&
                failed.button?.label === "Sync now" &&
                failed.button.disabled === false &&
                failed.note === false,
            `${JSON.stringify(failed)} colors=${JSON.stringify(colors)}`
        );
        await h.ev(`${VAULT_ROW}?.scrollIntoView({ block: "center" })`);
        await polishNap(200);
        await h.shot("cdp-shots/settings-vault-sync-failed.png");
        return steps;
    },
    async teardown(h, ctx) {
        await teardownVaultSync(h, ctx);
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

export const settingsClaudeAccount = {
    name: "settings-claude-account",
    surface: "settings",
    async arrange(h) {
        const now = Date.now();
        const secrets = {};
        for (const s of Object.values(CLAUDE_ACCT_SEEDS)) {
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
// clearPlan(STORAGE_SCENARIOS.storage).ids
const STORAGE_CLEAR_IDS = [
    ...["bd67b1fe", "3425249d", "009152b3", "866e3b50", "a6cf3f86"].map((k) => `runtree:${STORAGE_WT}\\${k}`),
    `legacygroup:${STORAGE_LEGACY}`,
    `branch:${STORAGE_SIEM}:refs/heads/wave/021cb57c-bf17-4c5c-9f41-ee7373a2cc11`,
    `branch:${STORAGE_SIEM}:refs/heads/wave/f15cd1a3-d509-48b6-b505-2155fee20b96`,
    String.raw`finalout:C:\Users\arc\AppData\Local\Temp\arc-final-*`,
    String.raw`finalout:C:\Users\arc\AppData\Local\arc-final-out-*`,
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
            };
        })()`);
        rec(
            "1. storage: three groups, the 9e473bf8 row offers Delete anyway, Clear reads 314 MB, the index row says left over",
            main != null &&
                JSON.stringify(main.groups) === JSON.stringify(["left", "inuse", "kept"]) &&
                main.skippedDelete &&
                main.clear === "Clear 314 MB left over" &&
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
            "2. confirm: Clear asks with the three kind lines, the 9e473bf8 skip and the tail; Cancel closes it and sends nothing",
            confirm != null &&
                confirm.lines.length === 3 &&
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
            "3. Clear left over closes the dialog and clears the 10 clearable fixture ids",
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
            "8. clearing: Clear reads Clearing 7 of 10… and is disabled, Rescan too; rows say Cleared and Clearing…; no Delete anyway",
            clearing != null &&
                clearing.clear === "Clearing 7 of 10…" &&
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
            "9. ChatWorking (phone-chat): working, the live Running line with its elapsed, Add to this turn and Stop this turn; Stop is recorded",
            working.state.startsWith("working") &&
                live?.live === true &&
                live.verb === "Running" &&
                live.target === "node scripts/cdp/verify.mjs remote-phone" &&
                /^\d+[hms]/.test(live.tail) &&
                working.label === "Add to this turn" &&
                working.placeholder === "Add to this turn" &&
                working.stop === "Stop this turn" &&
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

// --- motion-controls: a chevron turns instead of flipping, and a copy cross-fades to its outcome ---------------
// The route picker's chevron stands for every disclosure chevron (they share turnTransition), and the Code path
// bar's copy for every copy affordance (they share useCopyFeedback and CrossFade). Samplers run in-page on every
// frame; the clipboard is stubbed so the copied and failed outcomes are both driven on purpose. The last step
// turns the chevron under prefers-reduced-motion, where it must snap.
const MOTION_CONTROLS_CHEVRON = `document.querySelector('[data-testid="route-picker"] svg.lucide-chevron-down')`;
const MOTION_CONTROLS_COPY = `document.querySelector('button[aria-label="Copy absolute path"]')`;
// COPY_HOLD_MS in frontend/app/element/copyfeedback.ts
const MOTION_CONTROLS_HOLD_MS = 1400;
// each distinct rotation seen over the frames (Tailwind 4 turns with the `rotate` property, not `transform`), plus
// the transition the chevron is styled with
const motionControlsTurn = `(async () => {
    const svg = ${MOTION_CONTROLS_CHEVRON};
    if (!svg) return null;
    const cs = getComputedStyle(svg);
    const out = { duration: cs.transitionDuration, property: cs.transitionProperty, transforms: [] };
    document.querySelector('[data-testid="route-picker"]').click();
    const t0 = performance.now();
    await new Promise((done) => {
        const tick = () => {
            const t = getComputedStyle(svg).rotate;
            if (out.transforms.at(-1) !== t) out.transforms.push(t);
            if (performance.now() - t0 < 500) requestAnimationFrame(tick); else done();
        };
        requestAnimationFrame(tick);
    });
    return out;
})()`;
const motionControlsCloseRoute = `(async () => {
    const b = document.querySelector('[data-testid="route-picker"]');
    if (b?.getAttribute('aria-expanded') === 'true') b.click();
    await new Promise((r) => setTimeout(r, 400));
    return b?.getAttribute('aria-expanded') ?? null;
})()`;
// clicks copy with writeText stubbed to `outcome`, and samples the button's cross-fade spans for `ms`
const motionControlsCopy = (outcome, ms) => `(async () => {
    const btn = ${MOTION_CONTROLS_COPY};
    if (!btn) return null;
    const clip = navigator.clipboard;
    const orig = clip.writeText;
    Object.defineProperty(clip, 'writeText', {
        configurable: true,
        value: () => ${outcome === "copied" ? "Promise.resolve()" : 'Promise.reject(new Error("motion-controls: refused"))'},
    });
    const out = { labels: [], midFade: [] };
    btn.click();
    const t0 = performance.now();
    await new Promise((done) => {
        const tick = () => {
            const label = (btn.innerText || '').trim();
            if (out.labels.at(-1) !== label) out.labels.push(label);
            for (const s of btn.querySelectorAll('[data-crossfade]')) {
                const o = parseFloat(getComputedStyle(s).opacity);
                const key = s.getAttribute('data-crossfade');
                if (o > 0.01 && o < 0.99 && !out.midFade.includes(key)) out.midFade.push(key);
            }
            if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else done();
        };
        requestAnimationFrame(tick);
    });
    delete clip.writeText;
    if (clip.writeText !== orig) Object.defineProperty(clip, 'writeText', { configurable: true, value: orig });
    out.end = (btn.innerText || '').trim();
    return out;
})()`;
const motionControlsReduce = (on) => ({
    features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }],
});

const MOTION_CONTROLS_PROJECT = "verify-motion-controls";

export const motionControls = {
    name: "motion-controls",
    surface: "settings",
    // Final runs on a fresh, empty store, so the copy steps register their own repo holding a README
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        const ctx = { name: MOTION_CONTROLS_PROJECT };
        try {
            ctx.dir = mkdtempSync(join(tmpdir(), "verify-motion-controls-"));
            git(ctx.dir, "init", "-q", "--initial-branch=main");
            writeFileSync(join(ctx.dir, "README.md"), "# motion controls\n");
            git(ctx.dir, "add", ".");
            git(ctx.dir, "commit", "-q", "-m", "seed the copy fixture");
            await h.rpc("createproject", { name: ctx.name, path: ctx.dir });
            ctx.madeProject = true;
            await waitForProjectInConfig(h, ctx.name);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: JSON.stringify(detail) });
        const openRouteSection = async () => {
            await h.goto("settings");
            await h.ev(`document.querySelector('[data-section="run"]')?.click()`);
            await polishWaitFor(h, `!!${MOTION_CONTROLS_CHEVRON}`, 8000);
            await h.ev(`document.querySelector('[data-testid="route-picker"]')?.scrollIntoView({ block: "center" })`);
            await polishNap(300);
        };
        const openCodeFile = async () => {
            if (ctx.arrangeError != null) return false;
            await h.goto("code");
            const row = `document.querySelector('[data-code-picker-row=${JSON.stringify(ctx.name)}]')`;
            if (!(await h.ev(`!!${row}`))) await h.ev(`document.querySelector('[data-code-project-picker]')?.click()`);
            if (!(await polishWaitFor(h, `!!${row}`, 5000))) return false;
            await h.ev(`${row}.click()`);
            await polishNap(1200);
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
            );
            await polishNap(300);
            await setFinderQuery(h, "README.md");
            return polishWaitFor(h, `!!${MOTION_CONTROLS_COPY}`, 8000);
        };
        // a turn shows at least one frame between the start and end rotations
        const turned = (t) => t != null && t.transforms.length >= 3 && t.transforms[0] !== t.transforms.at(-1);

        // 1. the chevron turns on the token timing
        await openRouteSection();
        const turn = await h.ev(motionControlsTurn);
        await h.shot("cdp-shots/motion-controls-chevron-open.png");
        await h.ev(motionControlsCloseRoute);
        rec(
            "1. opening the route picker turns its chevron over frames, on the micro token (0.14s)",
            turned(turn) && turn.duration === "0.14s" && turn.property.includes("rotate"),
            turn
        );

        // 2. copy -> Copied cross-fades in, then returns to Copy path after the hold
        const fileOpen = await openCodeFile();
        const copied = fileOpen ? await h.ev(motionControlsCopy("copied", 600)) : null;
        await h.shot("cdp-shots/motion-controls-copied.png");
        await polishNap(MOTION_CONTROLS_HOLD_MS);
        const back = await h.ev(`(${MOTION_CONTROLS_COPY}?.innerText || '').trim()`);
        rec(
            "2. the path bar's copy cross-fades to Copied and returns to Copy path after the hold",
            fileOpen &&
                copied?.labels.includes("Copied") &&
                copied.midFade.includes("copied") &&
                copied.end === "Copied" &&
                back === "Copy path",
            ctx.arrangeError ?? { fileOpen, copied, back }
        );

        // 3. a refused write reads as a failure, never as Copied
        const failed = fileOpen ? await h.ev(motionControlsCopy("failed", 500)) : null;
        await h.shot("cdp-shots/motion-controls-copy-failed.png");
        await polishNap(MOTION_CONTROLS_HOLD_MS);
        rec(
            "3. a refused clipboard write shows Copy failed and never Copied",
            failed?.end === "Copy failed" && !failed.labels.includes("Copied"),
            failed
        );

        // 4. reduced motion: the turn snaps. The cross-fade is opacity only, which MotionConfig reducedMotion="user" keeps.
        await h.cdp("Emulation.setEmulatedMedia", motionControlsReduce(true));
        await openRouteSection();
        const snapTurn = await h.ev(motionControlsTurn);
        await h.ev(motionControlsCloseRoute);
        rec(
            "4. under reduced motion the chevron flips with no in-between frame",
            snapTurn != null &&
                snapTurn.property === "none" &&
                snapTurn.transforms.at(-1) === "180deg" &&
                snapTurn.transforms.every((r) => r === "0deg" || r === "180deg"),
            snapTurn
        );
        await h.cdp("Emulation.setEmulatedMedia", motionControlsReduce(false));
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", motionControlsReduce(false)).catch(() => {});
        if (ctx.madeProject) {
            try {
                await h.rpc("deleteproject", { name: ctx.name });
            } catch (e) {
                console.error(`motion-controls teardown: delete the project failed: ${e?.message ?? e}`);
            }
        }
        if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
    },
};

// --- setup memory: the Memory tab over fixture states in temp folders -----------------------------
// Arranged for real, with no test hook: createproject registers the fixture projects on temp git repos,
// and memory-fixtures.mjs writes their state files into the dev store with real hashes, naming memory
// folders under the same temp root. Apply and undo then touch only those folders. It never clicks Check now
// (or Check again), which would run a model check. Copy and layout are the memory-hygiene mockup's boards.
const MEMORY_FIXTURE_NAMES = Object.values(MEMORY_PROJECTS);

async function setupMemoryArrange(h) {
    const ctx = { root: mkdtempSync(join(tmpdir(), "verify-setup-memory-")), registered: [], applyIds: [] };
    try {
        ctx.fx = buildMemoryFixture(ctx.root);
        ctx.dataDir = (await h.rpc("waveinfo", null)).datadir;
        for (const { name, path } of ctx.fx.projects) {
            await h.rpc("createproject", { name, path });
            ctx.registered.push({ name, path });
        }
        for (const { name } of ctx.fx.projects) await waitForProjectInConfig(h, name);
        writeMemoryStates(ctx.dataDir, ctx.fx.states);
        await polishReload(h);
    } catch (e) {
        await setupMemoryTeardown(h, ctx).catch(() => {});
        throw e;
    }
    return ctx;
}

async function setupMemoryAssert(h, ctx) {
    const steps = [];
    const rec = (step, ok, detail) => steps.push({ step, ok, detail });
    const { fx } = ctx;
    const own = fx.ownChanges;
    const split = fx.splitChanges;
    const q = (sel) => JSON.stringify(sel);
    const projectSel = (name) => `[data-memory-project=${q(name)}]`;
    const changeSel = (id) => `[data-memory-change=${q(id)}]`;
    const text = (sel) => h.ev(`(document.querySelector(${q(sel)})?.textContent ?? "").trim()`);
    const disabled = (sel) => h.ev(`document.querySelector(${q(sel)})?.disabled ?? null`);
    const click = async (sel) => {
        if (
            !(await h.ev(
                `(() => { const b = document.querySelector(${q(sel)}); if (!b) return false; b.click(); return true; })()`
            ))
        ) {
            throw new Error(`nothing to click at ${sel}`);
        }
    };
    const toolbarStatus = () =>
        h.ev(
            `(document.getElementById("setup-tab-memory")?.closest("[data-surface-toolbar]")?.lastElementChild?.textContent ?? "").trim()`
        );
    // the check line sits under the project name, beside Check now
    const checkLine = () =>
        h.ev(
            `(document.querySelector("[data-memory-check]")?.parentElement?.firstElementChild?.lastElementChild?.textContent ?? "").trim()`
        );
    const railStatus = (name) =>
        h.ev(`(document.querySelector(${q(projectSel(name))})?.lastElementChild?.textContent ?? "").trim()`);
    const rowStatus = (id) =>
        h.ev(`(document.querySelector(${q(changeSel(id))})?.lastElementChild?.textContent ?? "").trim()`);
    const selectProject = async (name) => {
        if (!(await polishWaitFor(h, `!!document.querySelector(${q(projectSel(name))})`, 10000))) {
            throw new Error(`${name} is not in the Memory tab's project rail`);
        }
        await click(projectSel(name));
        await polishWaitFor(
            h,
            `document.querySelector(${q(projectSel(name))})?.getAttribute("aria-pressed") === "true"`,
            5000
        );
    };
    const selectChange = async (id) => {
        await click(changeSel(id));
        await polishWaitFor(
            h,
            `document.querySelector(${q(changeSel(id))})?.getAttribute("aria-selected") === "true"`,
            5000
        );
    };
    // teardown removes each apply's backup by its id
    const recordApplyId = async (changeId, project = MEMORY_PROJECTS.own) => {
        const listed = await h.rpc("listmemoryhygiene", null);
        const id = listed.projects
            .find((p) => p.project === project)
            ?.changes.find((c) => c.id === changeId)?.applyid;
        if (id) ctx.applyIds.push(id);
        return id;
    };
    // the tab's keys run off a window capture listener, which a keydown dispatched on the document reaches
    const press = (key) =>
        h.ev(
            `document.dispatchEvent(new KeyboardEvent("keydown", { key: ${q(key)}, code: ${q(`Key${key.toUpperCase()}`)}, bubbles: true }))`
        );
    const selectedChange = () =>
        h.ev(`document.querySelector('[data-memory-change][aria-selected="true"]')?.getAttribute("data-memory-change") ?? null`);
    const waitSelected = (id) =>
        polishWaitFor(h, `document.querySelector(${q(changeSel(id))})?.getAttribute("aria-selected") === "true"`, 5000);
    // a verdict moves the selection on, so its closed state is read by going back to the row
    const reselectWhen = async (id, status) => {
        const decided = await polishWaitFor(
            h,
            `(document.querySelector(${q(changeSel(id))})?.lastElementChild?.textContent ?? "").trim() === ${q(status)}`,
            10000
        );
        await selectChange(id);
        return decided;
    };
    const bytes = (path) => (existsSync(path) ? readFileSync(path) : null);
    const same = (a, b) => a != null && b != null && Buffer.compare(a, b) === 0;
    const run = async (step, fn) => {
        try {
            const { ok, detail } = await fn();
            rec(step, ok, detail);
        } catch (e) {
            rec(step, false, String(e?.message ?? e));
        }
    };

    await h.cdp("Emulation.setDeviceMetricsOverride", {
        width: 1600,
        height: 950,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await h.goto("setup");
    await click("#setup-tab-memory");
    await polishWaitFor(h, `!!document.querySelector("[data-memory-project]")`, 10000);

    await run(
        "1. Main: the own project with the toolbar status, a meter, one index card, five rows and a trim's detail",
        async () => {
            await selectProject(MEMORY_PROJECTS.own);
            await selectChange(own.trim.id);
            const ix = fx.states[MEMORY_PROJECTS.own].index;
            const meter = `${ix.lines} lines · ${(ix.bytes / 1000).toFixed(1)} of 25 KB`;
            const got = {
                toolbar: await toolbarStatus(),
                rail: await text(projectSel(MEMORY_PROJECTS.own)),
                cards: await h.ev(`document.querySelectorAll("[data-memory-card]").length`),
                rows: await h.ev(`document.querySelectorAll("[data-memory-change]").length`),
                detail: await text("[data-memory-detail]"),
                keep: await disabled("[data-memory-keep]"),
                apply: await disabled("[data-memory-apply]"),
                applyLabel: await text("[data-memory-apply]"),
            };
            await h.shot("cdp-shots/setup-memory-main.png");
            const toReview = Number(/^(\d+) projects? to review$/.exec(got.toolbar)?.[1] ?? 0);
            return {
                ok:
                    toReview >= 3 &&
                    got.rail.includes(meter) &&
                    got.cards === 1 &&
                    got.rows === 5 &&
                    got.detail.includes("Why") &&
                    got.detail.includes("Change") &&
                    got.detail.includes(own.trim.title) &&
                    got.keep === false &&
                    got.apply === false &&
                    got.applyLabel === "Apply trim",
                detail: JSON.stringify({ ...got, detail: got.detail.slice(0, 160), meter }),
            };
        }
    );

    await run(
        "2. Split: split-a shows the split text, two index cards, three labelled groups and a move-here",
        async () => {
            await selectProject(MEMORY_PROJECTS.splitA);
            await selectChange(split.moveBuild.id);
            const got = {
                rail: await text(projectSel(MEMORY_PROJECTS.splitA)),
                body: await h.ev(`(document.querySelector("[data-memory-check]")?.closest("main")?.textContent ?? "")`),
                cards: await h.ev(`document.querySelectorAll("[data-memory-card]").length`),
                groups: await h.ev(
                    `[...document.querySelectorAll('[role="rowgroup"][aria-label]')].map((g) => g.getAttribute("aria-label"))`
                ),
                detail: await text("[data-memory-detail]"),
            };
            await h.shot("cdp-shots/setup-memory-split.png");
            const repo = MEMORY_SHARED_REPO;
            return {
                ok:
                    got.rail.includes(`Shares ${repo}’s memory`) &&
                    got.body.includes(
                        `Claude Code gives a git repo one memory, so ${MEMORY_PROJECTS.splitA} sessions load ${repo}’s MEMORY.md`
                    ) &&
                    got.cards === 2 &&
                    JSON.stringify(got.groups) ===
                        JSON.stringify([`From ${repo}’s memory`, "Already in its own folder", "Switch over"]) &&
                    got.detail.startsWith("Move here"),
                detail: JSON.stringify({ ...got, body: got.body.slice(0, 200), detail: got.detail.slice(0, 120) }),
            };
        }
    );

    await run("3. SplitGate: the settings change is held while shared changes are still to review", async () => {
        await selectChange(split.settings.id);
        const got = {
            apply: await disabled("[data-memory-apply]"),
            applyLabel: await text("[data-memory-apply]"),
            gate: await text("[data-memory-gate]"),
        };
        await h.shot("cdp-shots/setup-memory-split-gate.png");
        return {
            ok:
                got.apply === true &&
                got.applyLabel === "Switch memory" &&
                got.gate ===
                    `Review the 3 changes from ${MEMORY_SHARED_REPO}’s memory first. Switching now would drop those memories from ${MEMORY_PROJECTS.splitA} sessions.`,
            detail: JSON.stringify(got),
        };
    });

    await run(
        "4. Applied with Undo: the trim writes the trimmed bytes, reads Applied and moves on to the next change, and Undo restores the original",
        async () => {
            const original = bytes(fx.paths.trim);
            const trimmed = Buffer.from(original.toString("utf8").replace(fx.trim.old, fx.trim.new), "utf8");
            await selectProject(MEMORY_PROJECTS.own);
            await selectChange(own.trim.id);
            await click("[data-memory-apply]");
            const advanced = await waitSelected(own.delete.id);
            await reselectWhen(own.trim.id, "Applied");
            const appliedShown = await polishWaitFor(h, `!!document.querySelector("[data-memory-undo]")`, 10000);
            await recordApplyId(own.trim.id);
            const applied = {
                file: same(bytes(fx.paths.trim), trimmed),
                detail: await text("[data-memory-detail]"),
                undo: await text("[data-memory-undo]"),
                row: await rowStatus(own.trim.id),
            };
            await h.shot("cdp-shots/setup-memory-applied.png");
            await click("[data-memory-undo]");
            const reopened = await polishWaitFor(h, `!!document.querySelector("[data-memory-apply]")`, 10000);
            const restored = same(bytes(fx.paths.trim), original);
            const row = await rowStatus(own.trim.id);
            return {
                ok:
                    advanced &&
                    appliedShown &&
                    applied.file &&
                    /Applied at \d/.test(applied.detail) &&
                    applied.undo === "Undo" &&
                    applied.row === "Applied" &&
                    reopened &&
                    restored &&
                    row === "To review",
                detail: JSON.stringify({
                    advanced,
                    ...applied,
                    detail: applied.detail.slice(-160),
                    reopened,
                    restored,
                    rowAfterUndo: row,
                }),
            };
        }
    );

    await run("5. ChangedOnDisk: a file edited after the check stops the apply with the conflict alert", async () => {
        const edited = Buffer.from(`${readFileSync(fx.paths.delete, "utf8")}Edited after the check.\n`, "utf8");
        writeFileSync(fx.paths.delete, edited);
        const index = bytes(fx.paths.ownIndex);
        await selectChange(own.delete.id);
        await click("[data-memory-apply]");
        const shown = await polishWaitFor(h, `!!document.querySelector("[data-memory-conflict]")`, 10000);
        const got = {
            alert: await text("[data-memory-conflict]"),
            checkAgain: await text("[data-memory-conflict] button"),
            apply: await disabled("[data-memory-apply]"),
            row: await rowStatus(own.delete.id),
            file: same(bytes(fx.paths.delete), edited),
            index: same(bytes(fx.paths.ownIndex), index),
        };
        await h.shot("cdp-shots/setup-memory-changed-on-disk.png");
        return {
            ok:
                shown &&
                got.alert.includes("Changed on disk since the check.") &&
                got.alert.includes("flaky-retry-test.md") &&
                got.checkAgain === "Check again" &&
                got.apply === true &&
                got.row === "Changed on disk" &&
                got.file &&
                got.index,
            detail: JSON.stringify({ ...got, alert: got.alert.slice(0, 160) }),
        };
    });

    await run("6. Keep / Review again: a kept change reads Kept as is, and Review again opens it again", async () => {
        await selectChange(own.merge.id);
        await click("[data-memory-keep]");
        await reselectWhen(own.merge.id, "Kept");
        const kept = await polishWaitFor(h, `!!document.querySelector("[data-memory-undo]")`, 10000);
        const got = {
            detail: await text("[data-memory-detail]"),
            button: await text("[data-memory-undo]"),
            row: await rowStatus(own.merge.id),
        };
        await h.shot("cdp-shots/setup-memory-kept.png");
        await click("[data-memory-undo]");
        const reopened = await polishWaitFor(h, `!!document.querySelector("[data-memory-apply]")`, 10000);
        const row = await rowStatus(own.merge.id);
        return {
            ok:
                kept &&
                got.detail.includes("Kept as is. The next check skips it unless the memory changes.") &&
                got.button === "Review again" &&
                got.row === "Kept" &&
                reopened &&
                row === "To review",
            detail: JSON.stringify({ ...got, detail: got.detail.slice(-120), reopened, rowAfter: row }),
        };
    });

    await run("7. Check states: never checked, a failed check over its last result, and a check running", async () => {
        const got = {};
        for (const [key, name] of [
            ["fresh", MEMORY_PROJECTS.fresh],
            ["failed", MEMORY_PROJECTS.failed],
            ["checking", MEMORY_PROJECTS.checking],
        ]) {
            await selectProject(name);
            got[key] = {
                rail: await railStatus(name),
                line: await checkLine(),
                rows: await h.ev(`document.querySelectorAll("[data-memory-change]").length`),
                checkNow: await disabled("[data-memory-check]"),
                checkLabel: await h.ev(`(document.querySelector("[data-memory-check]")?.textContent ?? "").trim()`),
            };
            await h.shot(`cdp-shots/setup-memory-${key}.png`);
        }
        return {
            ok:
                got.fresh.rail === "Not checked yet" &&
                got.fresh.line === "Not checked yet" &&
                got.failed.rail === "Last check failed" &&
                got.failed.line.endsWith(`Last check failed: ${MEMORY_FAILED_ERROR}`) &&
                got.failed.rows === 1 &&
                got.checking.rail === "Checking…" &&
                got.checking.line === "Checking…" &&
                got.checking.checkNow === true &&
                got.checking.checkLabel === "Checking…" &&
                got.fresh.checkLabel === "Check now",
            detail: JSON.stringify(got),
        };
    });

    await run(
        "8. Error alert: an undo whose backup is gone shows the backend's message and writes nothing",
        async () => {
            const before = { index: bytes(fx.paths.ownIndex), note: bytes(fx.paths.harvested) };
            await selectProject(MEMORY_PROJECTS.own);
            await selectChange(own.addToIndex.id);
            await click("[data-memory-apply]");
            await reselectWhen(own.addToIndex.id, "Applied");
            if (!(await polishWaitFor(h, `!!document.querySelector("[data-memory-undo]")`, 10000))) {
                return { ok: false, detail: `the add-to-index did not apply: ${await text("[data-memory-error]")}` };
            }
            const applied = { index: bytes(fx.paths.ownIndex), note: bytes(fx.paths.harvested) };
            const applyId = await recordApplyId(own.addToIndex.id);
            if (!applyId) return { ok: false, detail: "the applied change has no apply id" };
            rmSync(memoryBackupDir(ctx.dataDir, applyId), { recursive: true, force: true });
            await click("[data-memory-undo]");
            const shown = await polishWaitFor(h, `!!document.querySelector("[data-memory-error]")`, 10000);
            const got = {
                alert: await text("[data-memory-error]"),
                row: await rowStatus(own.addToIndex.id),
                changed: !same(applied.index, before.index) && !same(applied.note, before.note),
                kept: same(bytes(fx.paths.ownIndex), applied.index) && same(bytes(fx.paths.harvested), applied.note),
            };
            await h.shot("cdp-shots/setup-memory-error.png");
            return {
                ok:
                    shown &&
                    got.alert.startsWith(`Could not undo the change in ${MEMORY_PROJECTS.own}: `) &&
                    got.alert.includes("backup manifest") &&
                    got.row === "Applied" &&
                    got.changed &&
                    got.kept,
                detail: JSON.stringify(got),
            };
        }
    );

    await run(
        "9. Keys and Apply all: projects to review lead the rail, j k x u drive the table, and Apply all clears a split group",
        async () => {
            // a row's status is its last line; no project with nothing to review may sit above one with some
            const railOrdered = await h.ev(`(() => {
                const toReview = [...document.querySelectorAll("[data-memory-project]")].map((b) =>
                    /to review$/.test((b.lastElementChild?.textContent ?? "").trim())
                );
                return toReview.indexOf(false) < 0 || !toReview.slice(toReview.indexOf(false)).includes(true);
            })()`);
            await selectProject(MEMORY_PROJECTS.own);
            await selectChange(own.trim.id);
            await press("j");
            const down = await waitSelected(own.delete.id);
            await press("k");
            const up = await waitSelected(own.trim.id);
            await press("x");
            const keptMoved = await waitSelected(own.delete.id);
            const kept = await reselectWhen(own.trim.id, "Kept");
            await press("u");
            const reopened = await polishWaitFor(
                h,
                `(document.querySelector(${q(changeSel(own.trim.id))})?.lastElementChild?.textContent ?? "").trim() === "To review"`,
                10000
            );

            await selectProject(MEMORY_PROJECTS.splitA);
            const ids = [split.moveBuild.id, split.moveDeploy.id, split.copyLint.id];
            const allSel = `[data-memory-apply-all="shared"]`;
            const offered = await text(allSel);
            await click(allSel);
            const armed = await text(allSel);
            await h.shot("cdp-shots/setup-memory-apply-all.png");
            await click(allSel);
            const allApplied = await polishWaitFor(
                h,
                `${JSON.stringify(ids.map(changeSel))}.every((s) => (document.querySelector(s)?.lastElementChild?.textContent ?? "").trim() === "Applied")`,
                20000
            );
            for (const id of ids) await recordApplyId(id, MEMORY_PROJECTS.splitA);
            await selectChange(split.settings.id);
            const got = {
                railOrdered,
                down,
                up,
                keptMoved,
                kept,
                reopened,
                offered,
                armed,
                allApplied,
                gone: await h.ev(`!document.querySelector(${q(allSel)})`),
                switchOpen: (await disabled("[data-memory-apply]")) === false,
                selected: await selectedChange(),
                error: await text("[data-memory-error]"),
            };
            await h.shot("cdp-shots/setup-memory-applied-all.png");
            return {
                ok:
                    railOrdered &&
                    down &&
                    up &&
                    keptMoved &&
                    kept &&
                    reopened &&
                    offered === "Apply all 3" &&
                    armed === "Apply 3 changes" &&
                    allApplied &&
                    got.gone &&
                    got.switchOpen &&
                    got.error === "",
                detail: JSON.stringify(got),
            };
        }
    );

    await run("10. Every project checked: with no change left open the toolbar says so", async () => {
        writeMemoryStates(ctx.dataDir, settleMemoryStates(fx.states));
        await polishReload(h);
        await h.goto("setup");
        await click("#setup-tab-memory");
        await polishWaitFor(h, `!!document.querySelector("[data-memory-project]")`, 10000);
        // a dev store with real projects may have changes of its own to review, which the fixture can't settle
        const listed = await h.rpc("listmemoryhygiene", null);
        const others = listed.projects
            .filter((p) => !MEMORY_FIXTURE_NAMES.includes(p.project))
            .filter((p) => p.changes.some((c) => c.status !== "applied" && c.status !== "kept"))
            .map((p) => p.project);
        const toolbar = await toolbarStatus();
        await h.shot("cdp-shots/setup-memory-all-checked.png");
        if (others.length > 0) {
            return {
                ok: toolbar === `${others.length} project${others.length === 1 ? "" : "s"} to review`,
                detail: `toolbar="${toolbar}"; this store's own projects to review: ${others.join(", ")}`,
            };
        }
        return { ok: toolbar === "Every project checked", detail: `toolbar="${toolbar}"` };
    });

    await run("11. Landing: memhygiene:<project> opens Setup → Memory with the project selected", async () => {
        await h.goto("cockpit");
        await polishWaitFor(h, `typeof window.__openAddress === "function"`, 5000);
        await h.ev(`window.__openAddress(${q(`memhygiene:${MEMORY_PROJECTS.splitA}`)})`);
        const landed = await polishWaitFor(
            h,
            `document.querySelector(${q(projectSel(MEMORY_PROJECTS.splitA))})?.getAttribute("aria-pressed") === "true"`,
            10000
        );
        const got = {
            surface: await h.activeSurfaceLabel(),
            tab: await h.ev(`document.getElementById("setup-tab-memory")?.getAttribute("aria-selected")`),
            pressed: landed,
        };
        await h.shot("cdp-shots/setup-memory-landing.png");
        return { ok: got.surface === SURFACE_LABEL.setup && got.tab === "true" && landed, detail: JSON.stringify(got) };
    });

    // the fresh project has no memory folder, so its check ends at once with no model call
    await run("12. Check now: a check that ends at once says what it found beside the button", async () => {
        await h.goto("setup");
        await click("#setup-tab-memory");
        await selectProject(MEMORY_PROJECTS.fresh);
        await click("[data-memory-check]");
        const shown = await polishWaitFor(h, `!!document.querySelector("[data-memory-check-result]")`, 10000);
        const got = {
            result: await text("[data-memory-check-result]"),
            line: await checkLine(),
            label: await h.ev(`(document.querySelector("[data-memory-check]")?.textContent ?? "").trim()`),
            error: await text("[data-memory-error]"),
            // checked with no memory folder, so the rail draws it on one line
            empty: await polishWaitFor(
                h,
                `document.querySelector(${q(projectSel(MEMORY_PROJECTS.fresh))})?.hasAttribute("data-memory-empty") === true`,
                5000
            ),
        };
        await h.shot("cdp-shots/setup-memory-check-result.png");
        return {
            ok:
                shown &&
                got.empty &&
                got.result === "Checked · nothing to review" &&
                got.line.startsWith("Checked ") &&
                got.label === "Check now",
            detail: JSON.stringify(got),
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
            await step(`remove the state of ${name}`, () =>
                rmSync(memoryStatePath(ctx.dataDir, name), { force: true })
            );
        }
        // undo keeps a backup until the sweep prunes it, so the applies' backups go here
        await step("remove the fixture's backups", () => {
            for (const id of ctx.applyIds) rmSync(memoryBackupDir(ctx.dataDir, id), { recursive: true, force: true });
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
