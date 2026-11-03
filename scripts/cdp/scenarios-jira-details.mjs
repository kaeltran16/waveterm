// jira-details: the Ticket field looked up in initiative details (Task 11 of docs/superpowers/plans/2026-11-03-jira-integration.md;
// board: EditInitiative, motion moment 6). New initiative against the fake Jira: looking up, found, not found, and
// Jira not connected; then Edit initiative on a seeded PAY-318 initiative, which looks up only after a change.
import { FAKE_JIRA_NAME, connectFakeJira, disconnectJira, motionSamples, seedTicketedInitiative, startFakeJira } from "./jira-fixtures.mjs";
import { lookEval, polishNap, polishWaitFor, releaseRpc, setInputExpr } from "./scenarios-shared.mjs";

const TITLE = "verify jira details initiative";
const KEY = "PAY-318";
const PAY_318_SUMMARY = "Retry webhook delivery when the partner returns 429";
const PAY_311_SUMMARY = "Settlement report drops refunds issued after cutoff";
const WAIT_MS = 8000;

const FIELD = `document.querySelector('[data-effort-field="ticket"]')`;
const LINE = `document.querySelector('[data-jira-lookup]')`;
const DIALOG = `${FIELD}?.closest('[role="dialog"]')`;
const ROW = (title) =>
    `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`;
const flat = (expr) => `(${expr}?.textContent ?? "").replace(/\\s+/g, " ").trim()`;

// React's onBlur listens for focusout, and a CDP page without focus never fires it by itself
const BLUR = `${FIELD}.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))`;
const typeAndBlur = (key) => `${setInputExpr(FIELD, key)}; await new Promise((r) => setTimeout(r, 150)); ${BLUR};`;

// holds the lookup until released, then lets the real call through: holdRpc's reply never comes, so it could not be released
const gateLookup = (h) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const real = (window.__heldRpc ??= {}).JiraShowCommand ??= RpcApi.JiraShowCommand;
        window.__jiraGate = new Promise((open) => (window.__jiraOpen = open));
        RpcApi.JiraShowCommand = async function (...args) {
            await window.__jiraGate;
            return real.apply(this, args);
        };
    `);
async function openGate(h) {
    await h.ev(`window.__jiraOpen?.()`);
    await releaseRpc(h, "JiraShowCommand");
}

const lookupState = (h) =>
    h.ev(`(() => {
        const l = ${LINE};
        const f = ${FIELD};
        return {
            kind: l?.getAttribute("data-jira-lookup") ?? null,
            text: ${flat("l")},
            field: f?.value ?? null,
            border: f ? getComputedStyle(f).borderTopColor : null,
        };
    })()`);

async function openNewInitiative(h) {
    await h.goto("jarvis");
    await polishWaitFor(h, `document.querySelector('[data-jarvis-new-initiative]') != null`, WAIT_MS);
    await h.ev(`document.querySelector('[data-jarvis-new-initiative]')?.click()`);
    return polishWaitFor(h, `${FIELD} != null`, WAIT_MS);
}

async function closeForm(h) {
    await h.ev(
        `[...(${DIALOG}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim() === "Cancel")?.click()`
    );
    await polishWaitFor(h, `${FIELD} == null`, WAIT_MS);
}

const issueCalls = (fake, key) => fake.state.calls.filter((c) => c === `GET /rest/api/3/issue/${key}`).length;
const faded = (frames) => frames.some((f) => f.present && Number(f.opacity) > 0 && Number(f.opacity) < 1);

export const jiraDetails = {
    name: "jira-details",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { restores: [] };
        try {
            ctx.fake = await startFakeJira();
            ctx.restores.push(await connectFakeJira(h, ctx.fake));
            ctx.effortoid = await seedTicketedInitiative(h, { title: TITLE, key: KEY, chunks: ["Retry"] });
        } catch (e) {
            await jiraDetails.teardown(h, ctx);
            throw e;
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const { fake } = ctx;

        const opened = await openNewInitiative(h);
        await gateLookup(h);
        const frames = await motionSamples(h, {
            selector: "[data-jira-lookup]",
            props: ["opacity"],
            ms: 700,
            trigger: typeAndBlur("pay-318"),
        });
        const looking = await lookupState(h);
        rec(
            "1. a changed key shows 'Looking up PAY-318 in Jira…' fading in, and the field keeps the normalized key",
            opened &&
                looking.kind === "looking" &&
                looking.text === "Looking up PAY-318 in Jira…" &&
                looking.field === KEY &&
                faded(frames),
            JSON.stringify({ opened, looking, frames: frames.filter((f) => f.present).slice(0, 12) })
        );
        await h.shot("cdp-shots/jira-details-looking.png");

        await openGate(h);
        await polishWaitFor(h, `${LINE}?.getAttribute("data-jira-lookup") === "found"`, WAIT_MS);
        const found = await lookupState(h);
        rec(
            "2. released, the found row names the summary and 'Story · To Do'",
            found.kind === "found" && found.text.includes(PAY_318_SUMMARY) && found.text.includes("Story · To Do"),
            JSON.stringify(found)
        );
        await polishNap(300);
        await h.shot("cdp-shots/jira-details-found.png");

        await h.ev(`(async () => { ${typeAndBlur("PAY-381")} })()`);
        await polishWaitFor(h, `${LINE}?.getAttribute("data-jira-lookup") === "notfound"`, WAIT_MS);
        const missing = await lookupState(h);
        // the token as the browser resolves it (oklab, not rgb), taken from the class the field uses
        const errorBorder = await h.ev(`(() => {
            const probe = document.createElement("div");
            probe.className = "border border-error/60";
            document.body.append(probe);
            const color = getComputedStyle(probe).borderTopColor;
            probe.remove();
            return color;
        })()`);
        rec(
            "3. a key Jira has no copy of shows the not-found text and the field's error border",
            missing.kind === "notfound" &&
                missing.text === "Jira has no PAY-381, or your account can't see it. Saving keeps it as text." &&
                missing.border === errorBorder,
            JSON.stringify({ missing, errorBorder })
        );
        await polishNap(300);
        await h.shot("cdp-shots/jira-details-notfound.png");

        await closeForm(h);
        ctx.restores.push(await disconnectJira(h));
        await openNewInitiative(h);
        await h.ev(`(async () => { ${typeAndBlur("PAY-318")} })()`);
        await polishWaitFor(h, `${LINE}?.getAttribute("data-jira-lookup") === "off"`, WAIT_MS);
        const off = await lookupState(h);
        const hasConnect = await h.ev(`document.querySelector("[data-jira-connect]") != null`);
        await polishNap(300);
        await h.shot("cdp-shots/jira-details-off.png");
        await h.ev(`document.querySelector("[data-jira-connect]")?.click()`);
        const onSettings = await polishWaitFor(
            h,
            `document.querySelector('[data-settings-section="jira"]') != null && ${FIELD} == null`,
            WAIT_MS
        );
        rec(
            "4. Jira not connected: the saved-as-text line, and Connect Jira lands on Settings > Jira",
            off.kind === "off" &&
                off.text === "Saved as text; Arc can't check it until Jira is connected. Connect Jira" &&
                hasConnect &&
                onSettings,
            JSON.stringify({ off, hasConnect, onSettings })
        );

        ctx.restores.push(await connectFakeJira(h, fake));
        await h.goto("jarvis");
        await polishWaitFor(h, `${ROW(TITLE)} != null`, WAIT_MS);
        await h.ev(`${ROW(TITLE)}?.click()`);
        await polishWaitFor(
            h,
            `${ROW(TITLE)}?.parentElement?.querySelector('[data-jarvis-initiative-action="details"]') != null`,
            WAIT_MS
        );
        await h.ev(`${ROW(TITLE)}.parentElement.querySelector('[data-jarvis-initiative-action="details"]').click()`);
        const editing = await polishWaitFor(h, `${FIELD} != null`, WAIT_MS);
        const before = issueCalls(fake, KEY);
        const filled = await h.ev(`${FIELD}?.value`);
        await h.ev(BLUR);
        await polishNap(600);
        const untouched = await lookupState(h);
        const afterBlur = issueCalls(fake, KEY);
        await h.ev(`(async () => { ${typeAndBlur("pay-311")} })()`);
        await polishWaitFor(h, `${LINE}?.getAttribute("data-jira-lookup") === "found"`, WAIT_MS);
        const changed = await lookupState(h);
        const afterChange = issueCalls(fake, "PAY-311");
        await h.ev(BLUR);
        await polishNap(600);
        const again = issueCalls(fake, "PAY-311");
        rec(
            "5. Edit initiative shows the saved ticket, looks up on blur only after a change, and once per key",
            editing &&
                filled === KEY &&
                untouched.kind === null &&
                afterBlur === before &&
                changed.text.includes(PAY_311_SUMMARY) &&
                changed.text.includes("Bug · In Progress") &&
                afterChange === 1 &&
                again === 1,
            JSON.stringify({ editing, filled, untouched, before, afterBlur, changed, afterChange, again, as: FAKE_JIRA_NAME })
        );
        await polishNap(300);
        await h.shot("cdp-shots/jira-details-edit.png");
        await closeForm(h);
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(`window.__jiraOpen?.()`).catch(() => {});
        await releaseRpc(h, "JiraShowCommand").catch(() => {});
        if (ctx.effortoid != null) {
            await h.rpc("effortdelete", { effortoid: ctx.effortoid }).catch(() => {});
        }
        // newest first, so the site, email and token end up as they were before the scenario
        for (const restore of [...(ctx.restores ?? [])].reverse()) {
            await restore();
        }
        await ctx.fake?.close();
        await h.goto("cockpit");
    },
};
