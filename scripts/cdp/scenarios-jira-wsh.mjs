// jira-wsh: wsh jira check and show, and wsh effort show and list with the ticket (Task 5 of
// docs/superpowers/plans/2026-11-03-jira-integration.md; board Elsewhere, terminal half). The real wsh runs in a
// terminal of the dev app (notes-wsh.mjs's runWsh) against the real Go client, which talks to the fake Jira.
// Final judges screenshots only, so the commands' stdout is drawn into an overlay and shot.
import {
    PAY_318_CRITERIA,
    PAY_318_DESCRIPTION,
    connectFakeJira,
    disconnectJira,
    seedTicketedInitiative,
    startFakeJira,
} from "./jira-fixtures.mjs";
import { runWsh } from "./notes-wsh.mjs";

const KEY = "PAY-318";
const OTHER_KEYS = ["PAY-311", "OPS-77", "GROW-12"];
const PROJECT = "payments-api";
const OVERLAY = "[data-jira-wsh-output]";
const SHOT = "cdp-shots/jira-wsh-terminal.png";

const lines = (text) => (text ?? "").replace(/\r\n/g, "\n");
const show = (r) => JSON.stringify(r);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// the commands' stdout in the terminal's own font and the @theme tokens, over the page
const overlayExpr = (blocks) => `(() => {
    document.querySelector(${JSON.stringify(OVERLAY)})?.remove();
    const pre = document.createElement("pre");
    pre.setAttribute("data-jira-wsh-output", "");
    pre.textContent = ${JSON.stringify(blocks)};
    Object.assign(pre.style, {
        position: "fixed", inset: "48px", zIndex: "2147483647", margin: "0", padding: "14px 16px", overflow: "auto",
        borderRadius: "10px", border: "1px solid var(--color-border)", background: "var(--color-surface-code)",
        color: "var(--color-secondary)", fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "1.7",
    });
    document.body.appendChild(pre);
})()`;

async function deleteStampedEfforts(h, stamp) {
    const { efforts } = await h.rpc("effortlist", { includearchived: true });
    for (const e of efforts ?? []) {
        if (e.title.includes(stamp)) await h.rpc("effortdelete", { effortoid: e.oref.replace(/^effort:/, "") });
    }
}

export const jiraWsh = {
    name: "jira-wsh",
    surface: "agent",
    async arrange(h) {
        const stamp = Date.now().toString(36);
        const ctx = { stamp, title: `verify jira-wsh ${stamp}` };
        // a throw past this point still returns ctx, so teardown undoes whatever was already done
        try {
            ctx.fake = await startFakeJira();
            ctx.restore = await connectFakeJira(h, ctx.fake);
            ctx.effortoid = await seedTicketedInitiative(h, {
                title: ctx.title,
                project: PROJECT,
                key: KEY,
                chunks: [
                    { label: "Retry with backoff", status: "done" },
                    { label: "Give up after 6 attempts", status: "active" },
                    { label: "Failed state on the partner dashboard" },
                ],
            });
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.launchError != null) return [{ step: "the fake Jira and the ticketed initiative were set up", ok: false, detail: ctx.launchError }];
        const steps = [];
        const NOT_A_KEY = "not-a-key!";
        const argvList = [
            ["effort", "show", ctx.effortoid],
            ["jira", "show", KEY],
            ["jira", "check"],
            ["jira", "show", KEY.toLowerCase()],
            ["effort", "list"],
            ["jira", "show", NOT_A_KEY],
        ];
        const [effortShow, jiraShow, check, lower, effortList, notKey] = await runWsh(h, argvList);

        const effortOut = lines(effortShow.stdout);
        const seen = new RegExp(`^ticket {3}${KEY} {2}Story · To Do \\(seen \\d{2}-\\d{2} \\d{2}:\\d{2}\\)$`, "m");
        steps.push({
            step: "1. wsh effort show prints the ticket line and where to read it",
            ok: effortShow.code === 0 && seen.test(effortOut) && effortOut.includes(`\n         read it: wsh jira show ${KEY}\n`),
            detail: show(effortShow),
        });
        steps.push({
            step: "2. wsh effort show prints the project line",
            ok: effortOut.split("\n").includes(`project  ${PROJECT}`),
            detail: show(effortShow),
        });

        const listRow = lines(effortList.stdout)
            .split("\n")
            .find((l) => l.startsWith(`effort:${ctx.effortoid}\t`));
        steps.push({
            step: "3. wsh effort list ends the initiative's row with the ticket, type and status",
            ok: effortList.code === 0 && listRow?.endsWith(`\t${KEY} Story · To Do`) === true,
            detail: `row ${show(listRow ?? null)} in ${show(effortList)}`,
        });

        const showOut = lines(jiraShow.stdout);
        steps.push({
            step: "4. wsh jira show prints the title, status, description, criteria and the project line",
            ok:
                jiraShow.code === 0 &&
                showOut.startsWith("Retry webhook delivery when the partner returns 429\nStory · To Do\n") &&
                showOut.includes(`\n\n${PAY_318_DESCRIPTION}\n`) &&
                showOut.includes(`\nAcceptance criteria\n${PAY_318_CRITERIA.map((c) => `- ${c}`).join("\n")}\n`) &&
                /^project (unsure|\S+)/m.test(showOut),
            detail: show(jiraShow),
        });

        const checkOut = lines(check.stdout);
        const rowKeys = checkOut
            .split("\n")
            .filter((l) => l.includes("\t"))
            .map((l) => l.split("\t")[0]);
        steps.push({
            step: "5. wsh jira check leaves out the ticket that has an initiative and lists the other three",
            ok:
                check.code === 0 &&
                rowKeys.length === OTHER_KEYS.length &&
                OTHER_KEYS.every((k) => rowKeys.includes(k)) &&
                !rowKeys.includes(KEY) &&
                new RegExp(`^${escapeRe("1 more assigned ticket already has an initiative.")}$`, "m").test(checkOut),
            detail: show(check),
        });

        steps.push({
            step: "6. a lowercase key is normalized: same output, and Jira is asked for PAY-318",
            ok: lower.code === 0 && lines(lower.stdout) === showOut && !ctx.fake.state.calls.some((c) => c.includes("/pay-318")),
            detail: `calls ${show(ctx.fake.state.calls)} lower ${show(lower)}`,
        });

        steps.push({
            step: "7. a string that is not a key is refused by wsh and never sent to Jira",
            ok:
                notKey.code !== 0 &&
                `${notKey.stdout}${notKey.stderr}`.includes("PAY-318") &&
                !ctx.fake.state.calls.some((c) => c.toLowerCase().includes("not-a-key")),
            detail: show(notKey),
        });

        // the shot comes before the disconnect, which clears the fixture's token
        await h.ev(
            overlayExpr(
                [
                    `$ wsh effort show ${ctx.effortoid}`,
                    effortOut,
                    `$ wsh jira show ${KEY}`,
                    showOut,
                ].join("\n")
            )
        );
        await h.shot(SHOT);

        await disconnectJira(h);
        const [off] = await runWsh(h, [["jira", "check"]]);
        steps.push({
            step: "8. without Jira set up, wsh jira check exits nonzero and points at Settings > Jira",
            ok: off.code !== 0 && `${off.stdout}${off.stderr}`.includes("Settings > Jira"),
            detail: show(off),
        });
        return steps;
    },
    async teardown(h, ctx) {
        const failed = [];
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                failed.push(`${what}: ${e?.message ?? e}`);
            }
        };
        await step("remove the output overlay", () => h.ev(`document.querySelector(${JSON.stringify(OVERLAY)})?.remove()`));
        await step("delete the initiative this run made", () => deleteStampedEfforts(h, ctx.stamp));
        if (ctx.restore) await step("restore the Jira settings", () => ctx.restore());
        if (ctx.fake) await step("stop the fake Jira", () => ctx.fake.close());
        if (failed.length > 0) throw new Error(failed.join("; "));
    },
};
