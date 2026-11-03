// jira-settings: Settings > Jira (Task 6 of docs/superpowers/plans/2026-11-03-jira-integration.md; board: Settings).
// Not set up, connected to the fake Jira, refused by it, and a site typed without its scheme.
import { FAKE_JIRA_NAME, connectFakeJira, disconnectJira, startFakeJira } from "./jira-fixtures.mjs";
import { polishNap, polishWaitFor } from "./scenarios-shared.mjs";

const PANE = `document.querySelector('[data-settings-section="jira"]')`;
const LINE = `${PANE}?.querySelector('[data-jira-connection-line]')`;
const TEST_BTN = `${PANE}?.querySelector('[data-jira-test]')`;
const SITE_INPUT = `${PANE}?.querySelector('[data-setting-row="jira.site"] input')`;
const ROWS = ["jira.site", "jira.email", "jira.token", "jira.connection"];
const REFUSED = "Client must be authenticated to access this resource.";
const WAIT_MS = 8000;

// the section reads its token probe and the connection once, on mount, so a state set over RPC shows after a remount
async function openJiraSection(h) {
    await h.goto("cockpit");
    await h.goto("settings");
    await h.ev(`document.querySelector('[data-section="jira"]')?.click()`);
    return polishWaitFor(h, `${PANE} != null && ${LINE} != null`, WAIT_MS);
}

const lineState = (h) =>
    h.ev(`(() => {
        const l = ${LINE};
        const c = ${PANE}?.querySelector('[data-jira-checked]');
        const b = ${TEST_BTN};
        return {
            tone: l?.getAttribute("data-jira-connection-line") ?? null,
            text: (l?.textContent || "").trim(),
            checked: c ? (c.textContent || "").trim() : null,
            button: b ? { label: (b.textContent || "").trim(), disabled: b.disabled } : null,
        };
    })()`);

const clickTest = (h) => h.ev(`${TEST_BTN}?.click()`);

export const jiraSettings = {
    name: "jira-settings",
    surface: "settings",
    async arrange(h) {
        const ctx = { restores: [] };
        try {
            ctx.fake = await startFakeJira();
            ctx.restores.push(await disconnectJira(h));
        } catch (e) {
            await jiraSettings.teardown(h, ctx);
            throw e;
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const { fake } = ctx;

        const opened = await openJiraSection(h);
        const off = await lineState(h);
        const rows = await h.ev(
            `[...${PANE}.querySelectorAll("[data-setting-row]")].map((r) => r.getAttribute("data-setting-row"))`
        );
        rec(
            "1. not set up: the four rows and the not-configured line",
            opened &&
                JSON.stringify(rows) === JSON.stringify(ROWS) &&
                off.tone === "idle" &&
                off.text === "Add your site, account email and API token to connect." &&
                off.checked === null,
            JSON.stringify({ rows, off })
        );
        await polishNap(300);
        await h.shot("cdp-shots/jira-settings-off.png");

        ctx.restores.push(await connectFakeJira(h, fake));
        await openJiraSection(h);
        await polishWaitFor(h, `${PANE}?.querySelector('[data-jira-token-saved]') != null`, WAIT_MS);
        const untouched = fake.state.calls.length;
        await clickTest(h);
        await polishWaitFor(h, `(${LINE}?.textContent || "").includes("Connected as")`, WAIT_MS);
        await polishWaitFor(h, `${PANE}?.querySelector('[data-jira-checked]') != null`, WAIT_MS);
        const ok = await lineState(h);
        const saved = await h.ev(`(${PANE}?.querySelector('[data-jira-token-saved]')?.textContent || "").trim()`);
        rec(
            "2. connected: Connected as <name>, Checked <age>, token Saved, and Jira was called only by Test again",
            untouched === 0 &&
                fake.state.calls.length > 0 &&
                ok.tone === "ok" &&
                ok.text === `Connected as ${FAKE_JIRA_NAME}` &&
                /^Checked /.test(ok.checked ?? "") &&
                saved.startsWith("Saved") &&
                saved.includes("Replace token") &&
                ok.button?.label === "Test again",
            JSON.stringify({ untouched, calls: fake.state.calls, ok, saved })
        );
        await polishNap(300);
        await h.shot("cdp-shots/jira-settings-connected.png");

        fake.state.refuse = { status: 401, message: REFUSED };
        await clickTest(h);
        await polishWaitFor(h, `${LINE}?.getAttribute("data-jira-connection-line") === "error"`, WAIT_MS);
        const refused = await lineState(h);
        rec(
            "3. refused: Jira's own 401 message shows and the button is Test again, not stuck on Testing…",
            refused.tone === "error" &&
                refused.text.includes(REFUSED) &&
                refused.button?.label === "Test again" &&
                refused.button.disabled === false,
            JSON.stringify(refused)
        );
        await polishNap(300);
        await h.shot("cdp-shots/jira-settings-refused.png");
        fake.state.refuse = null;

        // a controlled input only hears the native setter plus an input event; Enter commits what React has
        // rendered by then, so it waits a beat after the input. Enter, not blur: a CDP page without focus
        // never fires blur
        await h.ev(`(() => {
            const el = ${SITE_INPUT};
            el.focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "acme.atlassian.net");
            el.dispatchEvent(new Event("input", { bubbles: true }));
        })()`);
        await polishNap(200);
        await h.ev(
            `${SITE_INPUT}?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`
        );
        await polishWaitFor(h, `${PANE}?.querySelector('[data-jira-site-error]') != null`, WAIT_MS);
        const siteError = await h.ev(`(${PANE}?.querySelector('[data-jira-site-error]')?.textContent || "").trim()`);
        const stored = (await h.rpc("getfullconfig", null))?.settings?.["jira:site"];
        rec(
            "4. a site typed without https:// shows the site error and is not saved",
            siteError.includes("https://<name>.atlassian.net") && stored === fake.url,
            JSON.stringify({ siteError, stored, fake: fake.url })
        );
        await polishNap(300);
        await h.shot("cdp-shots/jira-settings-site-error.png");
        return steps;
    },
    async teardown(h, ctx) {
        // newest first, so the site, email and token end up as they were before the scenario
        for (const restore of [...(ctx.restores ?? [])].reverse()) {
            await restore();
        }
        await ctx.fake?.close();
        await h.goto("cockpit");
    },
};
