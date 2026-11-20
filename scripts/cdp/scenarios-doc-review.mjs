// Doc review scenarios: reviewing a spec or plan, and its notes.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_MOD, TREE_RAIL_FIXTURE, arrangeFixtureRun, teardownFixtureRun } from "./scenarios-shared.mjs";
import { DOC_REVIEW_LEAD_ID, DOC_REVIEW_PANEL } from "./scenarios-cockpit.mjs";

// A lead's Plan review ask opens as the review dialog over whatever agent is focused (git show a4b5bd4f:
// docs/superpowers/plans/2026-09-30-doc-review-dialog.md). Same setup as agent-tree-rail, with a roster of a working agent and a lead
// asking a Plan review whose plan the scenario writes. The working agent comes in through its Cockpit card, so
// the Agent surface never defaults onto the lead and spends its one auto-open before step 4. Nothing is answered:
// the fixture ask has no live block.
const DOC_REVIEW_LEAD = "doc-review lead";
const DOC_REVIEW_WORKER = "doc-review worker";
const DOC_REVIEW_WORKER_ID = "fx-doc-worker";
const DOC_REVIEW_HEADING = "Doc review fixture plan";
const DOC_REVIEW_DECISIONS = [
    "The dialog opens over any focused agent",
    "Esc hides it and the ask stays open",
    "It auto-opens once on the lead",
];
// a section line the doc-review ask carries between its second and third finding
const DOC_REVIEW_SECTION = "Findings I would not accept:";
const DOC_REVIEW_SECTION_AFTER = 2;
const DOC_REVIEW_NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const DOC_REVIEW_WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const DOC_REVIEW_TAG_TITLE = "Open the plan review";
const DOC_REVIEW_CHIP = "Plan review";
// the lead's own approve option, when it proposes keeping the plan rather than fixing it (D19)
const DOC_REVIEW_KEEP_LABEL = "Keep the plan";
const DOC_REVIEW_PROPOSAL_TITLE = "The plan review failed twice. Proceed as the lead proposes?";
function docReviewRoster(
    runId,
    docPath,
    decisions = DOC_REVIEW_DECISIONS,
    header = DOC_REVIEW_CHIP,
    sectionAfter = null,
    approveLabel = "Approve"
) {
    const lines = decisions.map((d) => `- ${d}`);
    if (sectionAfter != null) lines.splice(sectionAfter, 0, DOC_REVIEW_SECTION);
    return [
        {
            id: DOC_REVIEW_WORKER_ID,
            name: DOC_REVIEW_WORKER,
            project: "waveterm",
            task: "keep working",
            state: "working",
            agent: "claude",
            model: "opus",
            activeMs: 90_000,
            blockId: "fx-blk-doc-worker",
            // gives the card a feed, not the "Waiting in its terminal" body an agent with nothing to show gets
            previousInfo: [{ kind: "message", text: "Working through the fixture task." }],
        },
        {
            id: DOC_REVIEW_LEAD_ID,
            name: DOC_REVIEW_LEAD,
            project: "waveterm",
            task: "verify doc review",
            state: "asking",
            agent: "claude",
            model: "opus",
            blockedMs: 60_000,
            runId,
            blockId: "fx-blk-doc-lead",
            ask: {
                askId: `fx-doc-review-${Date.now()}`,
                oref: "block:fx-blk-doc-lead",
                questions: [
                    {
                        header,
                        question: [docPath, ...lines].join("\n"),
                        options: [{ label: approveLabel }, { label: "Request changes" }],
                    },
                ],
            },
        },
    ];
}

// the lead's row in the Agent tree, found by its name leaf as agent-tree-rail does
const docReviewTreeRow = (name) => `(() => {
    const tree = document.querySelector("[data-agent-tree]");
    const leaf = tree && [...tree.querySelectorAll("div")].find(
        (d) => d.textContent.trim() === ${JSON.stringify(name)} && d.children.length === 0
    );
    return leaf ? leaf.closest(".cursor-pointer") : null;
})()`;

// polls a boolean page expression; resolves to its last value
const docReviewWait = (h, expr, ms = 5000) =>
    h.ev(`(async () => {
        const t0 = performance.now();
        for (;;) {
            const v = !!(${expr});
            if (v || performance.now() - t0 > ${ms}) return v;
            await new Promise((r) => setTimeout(r, 150));
        }
    })()`);

// Escape where the user's focus is, so ModalShell's window listener sees it the way a keypress would reach it
const docReviewEscape = (h) =>
    h.ev(`(document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
    )`);

const docReviewHeaderNames = (h) =>
    h.ev(`(() => {
        const t = document.querySelector("[data-agent-header]")?.textContent ?? "";
        return { worker: t.includes(${JSON.stringify(DOC_REVIEW_WORKER)}), lead: t.includes(${JSON.stringify(DOC_REVIEW_LEAD)}) };
    })()`);

// focus the lead through its tree row with nothing editable focused, so auto-open is allowed to fire
const docReviewFocusRow = (h, name) =>
    h.ev(`(() => {
        document.activeElement?.blur?.();
        document.querySelector("[data-cockpit-surface-wrap]")?.focus();
        const row = ${docReviewTreeRow(name)};
        if (!row) return false;
        row.click();
        return true;
    })()`);

// the doc-review roster with its lead asking under header, on a plan this writes; the cockpit shows the worker's card
async function arrangeDocReview(h, name, header, sectionAfter = null, approveLabel = undefined) {
    const cwd = mkdtempSync(join(tmpdir(), `verify-${name}-`));
    const ctx = { cwd };
    try {
        await arrangeFixtureRun(h, ctx, name, DOC_REVIEW_LEAD);
        ctx.specPath = join(cwd, "doc-review-plan.md");
        writeFileSync(
            ctx.specPath,
            `# ${DOC_REVIEW_HEADING}\n\nA small plan the doc-review scenario writes for the dialog to render.\n`
        );
        writeFileSync(
            TREE_RAIL_FIXTURE,
            JSON.stringify(
                docReviewRoster(ctx.runId, ctx.specPath, DOC_REVIEW_DECISIONS, header, sectionAfter, approveLabel),
                null,
                2
            )
        );
        // the fixture roster is read once at boot
        await h.ev("location.reload()");
        await h.ev(`(async () => {
            for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                await new Promise((r) => setTimeout(r, 500));
            }
        })()`);
        await h.goto("cockpit");
        ctx.rosterLoaded = await docReviewWait(
            h,
            `document.querySelector('[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"]')`,
            15000
        );
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
    }
    return ctx;
}

export const docReview = {
    name: "doc-review",
    surface: "cockpit",
    arrange: (h) =>
        arrangeDocReview(h, "doc-review", DOC_REVIEW_CHIP, DOC_REVIEW_SECTION_AFTER, DOC_REVIEW_KEEP_LABEL),
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const nap = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const dialogOpen = () => h.ev(`!!${DOC_REVIEW_PANEL}`);
        const dialogGone = (ms) => docReviewWait(h, `!${DOC_REVIEW_PANEL}`, ms);
        if (ctx.arrangeError != null || !ctx.rosterLoaded) {
            return [{ step: "0. the fixture roster loaded", ok: false, detail: ctx.arrangeError ?? "no worker card" }];
        }

        // the card's terminal button focuses the worker and switches to the Agent surface in one step
        const opened = await h.ev(`(() => {
            const b = document.querySelector(
                '[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"] button[title="Open terminal (T)"]'
            );
            if (!b) return false;
            b.click();
            return true;
        })()`);
        const tagged = await docReviewWait(
            h,
            `${docReviewTreeRow(DOC_REVIEW_LEAD)}?.querySelector('button[title="${DOC_REVIEW_TAG_TITLE}"]')`
        );
        await nap(500);
        const names1 = await docReviewHeaderNames(h);
        const anyDialog1 = await h.ev(`!!document.querySelector('[role="dialog"]')`);
        rec(
            "1. on the working agent: no dialog, and the lead's tree row has the review tag",
            opened && names1.worker && !anyDialog1 && tagged,
            JSON.stringify({ opened, header: names1, dialog: anyDialog1, tagged })
        );

        await h.ev(`${docReviewTreeRow(DOC_REVIEW_LEAD)}?.querySelector('button[title="${DOC_REVIEW_TAG_TITLE}"]')?.click()`);
        const open2 = await docReviewWait(h, DOC_REVIEW_PANEL);
        // the document is read over RPC, so its heading lands after the panel
        await docReviewWait(h, `${DOC_REVIEW_PANEL}?.querySelector("h1")`);
        const panel2 = await h.ev(`(() => {
            const p = ${DOC_REVIEW_PANEL};
            if (!p) return null;
            return {
                heading: p.querySelector("h1")?.textContent.trim() ?? null,
                items: p.querySelectorAll("ol > li:not([data-doc-heading])").length,
            };
        })()`);
        const names2 = await docReviewHeaderNames(h);
        await h.shot("cdp-shots/doc-review-dialog.png");
        rec(
            "2. the tag opens the dialog over the working agent: the plan on the left, 3 findings on the right",
            open2 &&
                panel2?.heading === DOC_REVIEW_HEADING &&
                panel2?.items === DOC_REVIEW_DECISIONS.length &&
                names2.worker &&
                !names2.lead,
            JSON.stringify({ panel: panel2, header: names2 })
        );

        // the section line sits between the two groups of findings, whole and in view, at both widths
        const sectionLayout = () =>
            h.ev(`(() => {
                const p = ${DOC_REVIEW_PANEL};
                const lis = [...(p?.querySelectorAll("ol > li") ?? [])];
                const at = lis.findIndex((li) => li.hasAttribute("data-doc-heading"));
                const rect = (li) => li?.getBoundingClientRect();
                const head = rect(lis[at]);
                const before = rect(lis[at - 1]);
                const after = rect(lis[at + 1]);
                const pane = lis[at]?.closest(".sc")?.getBoundingClientRect();
                return {
                    at,
                    total: lis.length,
                    text: lis[at]?.textContent.trim() ?? null,
                    between: !!head && !!before && !!after && before.bottom <= head.top && head.bottom <= after.top,
                    inView: !!head && !!pane && head.top >= pane.top && head.bottom <= pane.bottom && head.width > 0,
                    numbered: lis.filter((li) => !li.hasAttribute("data-doc-heading")).length,
                };
            })()`);
        const sections = {};
        for (const [label, viewport] of [["1000x700", DOC_REVIEW_NARROW], ["1600x950", DOC_REVIEW_WIDE]]) {
            await h.cdp("Emulation.setDeviceMetricsOverride", viewport);
            await nap(400);
            sections[label] = await sectionLayout();
            await h.shot(`cdp-shots/doc-review-section-${label}.png`);
        }
        rec(
            "2b. the section line sits between the findings it divides, at 1000x700 and at 1600x950",
            Object.values(sections).every(
                (s) =>
                    s.at === DOC_REVIEW_SECTION_AFTER &&
                    s.text === DOC_REVIEW_SECTION &&
                    s.numbered === DOC_REVIEW_DECISIONS.length &&
                    s.between &&
                    s.inView
            ),
            JSON.stringify(sections)
        );

        // still at 1600x950 from 2b: the title follows the lead's proposal and the primary button its own approve label
        const proposal = await h.ev(`(() => {
            const p = ${DOC_REVIEW_PANEL};
            if (!p) return null;
            const primary = [...p.querySelectorAll("button")].filter((b) => b.classList.contains("bg-accent"));
            return {
                title: p.querySelector("[data-doc-review]")?.textContent.includes(${JSON.stringify(DOC_REVIEW_PROPOSAL_TITLE)}) ?? false,
                fixesWording: p.textContent.includes("with these fixes"),
                // the label is the button's first text node; the chord badge is a span after it
                primary: primary.map((b) => b.firstChild?.textContent.trim() ?? ""),
                enabled: primary.every((b) => !b.disabled),
            };
        })()`);
        await h.shot("cdp-shots/doc-review-proposal.png");
        rec(
            "2c. the title reads as the lead's proposal and the primary button is the lead's own approve label, at 1600x950",
            !!proposal &&
                proposal.title &&
                !proposal.fixesWording &&
                proposal.enabled &&
                proposal.primary.length === 1 &&
                proposal.primary[0] === DOC_REVIEW_KEEP_LABEL,
            JSON.stringify(proposal)
        );

        await docReviewEscape(h);
        const gone3 = await dialogGone(3000);
        const names3 = await docReviewHeaderNames(h);
        rec(
            "3. Escape hides the dialog and leaves the working agent focused",
            gone3 && names3.worker && !names3.lead,
            JSON.stringify({ gone: gone3, header: names3 })
        );

        const clicked4 = await docReviewFocusRow(h, DOC_REVIEW_LEAD);
        const auto4 = await docReviewWait(h, DOC_REVIEW_PANEL);
        const names4 = await docReviewHeaderNames(h);
        rec(
            "4a. focusing the lead with nothing editable focused opens the dialog by itself",
            clicked4 && auto4 && names4.lead,
            JSON.stringify({ clicked: clicked4, open: auto4, header: names4 })
        );

        await docReviewEscape(h);
        const gone4 = await dialogGone(3000);
        await docReviewFocusRow(h, DOC_REVIEW_WORKER);
        await nap(400);
        await docReviewFocusRow(h, DOC_REVIEW_LEAD);
        await nap(1200);
        const reopened = await dialogOpen();
        const names4b = await docReviewHeaderNames(h);
        rec(
            "4b. after Escape, refocusing the lead does not reopen it",
            gone4 && !reopened && names4b.lead,
            JSON.stringify({ gone: gone4, reopened, header: names4b })
        );

        const chipped = await h.ev(`(() => {
            const b = [...(document.querySelector("[data-agent-header]")?.querySelectorAll("button") ?? [])]
                .find((x) => x.textContent.trim() === ${JSON.stringify(DOC_REVIEW_CHIP)});
            if (!b) return false;
            b.click();
            return true;
        })()`);
        const open4 = await docReviewWait(h, DOC_REVIEW_PANEL);
        rec("4c. the header chip reopens it", chipped && open4, JSON.stringify({ chip: chipped, open: open4 }));
        await docReviewEscape(h);
        await dialogGone(3000);
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "doc-review");
    },
};

// Quoting passages of the reviewed document (docs/superpowers/plans/2026-10-05-highlight-to-quote.md): a selection
// in the document opens a note field, notes collect in the rail and travel with either answer. Same roster as
// doc-review, on the mockup's document and decisions. Selections, typing and keys are made in the page, since CDP
// input does not reliably reach the WebView. Nothing is delivered: the fixture ask has no live block, so a send
// shows the cockpit's own sent lock.
const DOC_NOTES_HEADING = "Highlight-to-quote in the review dialog";
const DOC_NOTES_FIELD = "A note field opens under the selection";
const DOC_NOTES_STAYS = "The passage stays highlighted in the document until its note is removed.";
const DOC_NOTES_REWORD = "A note can be reworded on the right afterwards.";
const DOC_NOTES_ORDER = "in document order";
const DOC_NOTES_CUT = "A long passage is cut to its first and last lines.";
const DOC_NOTES_KEYBOARD = "Selecting with the keyboard";
const DOC_NOTES_LAST = "The last round ends when every note is applied.";
// one token on a fenced block's second line, so a selection up to it crosses the block's header and a line number
const DOC_NOTES_FENCE = "quotedfence";
// enough one-line paragraphs after the mockup's text that the document pane scrolls
const DOC_NOTES_FILLER_ROUNDS = 16;
const DOC_NOTES_SPEC = [
    `# ${DOC_NOTES_HEADING}`,
    "## Goal",
    "Request changes is free text that points at nothing, so a change request has to describe the passage it means. Selecting a passage in the document and writing a note on it lets the answer carry the passage with it.",
    "## Gesture",
    `Select text in the document. ${DOC_NOTES_FIELD}: Enter adds the passage and what you wrote to your notes on the right, under the decisions, Esc drops it. ${DOC_NOTES_STAYS} ${DOC_NOTES_REWORD}`,
    "## Delivery",
    `Request changes sends each note as the quoted passage followed by what you wrote, ${DOC_NOTES_ORDER}, through the ask's own answer path. Approve sends them too, after the approval. ${DOC_NOTES_CUT} The whole answer is one message to the lead.`,
    "## Out of scope",
    `The Code surface's markdown preview and the run report. Quoting from the decisions list on the right. ${DOC_NOTES_KEYBOARD}: the passage is picked with the mouse, then everything after is keys.`,
    `\`\`\`ts\nalpha\n${DOC_NOTES_FENCE}\n\`\`\``,
    "## Review rounds",
    ...Array.from(
        { length: DOC_NOTES_FILLER_ROUNDS },
        (_, i) => `Round ${i + 1}: the lead applies the quoted notes and asks for the review again.`
    ),
    DOC_NOTES_LAST,
].join("\n\n");
const DOC_NOTES_DECISIONS = [
    "Quoting is built on the dialog's own light renderer; the shared Code-preview renderer is left alone.",
    "Highlights are painted over the rendered text, not wrapped into it, so the markdown output is untouched.",
    "Notes are kept per ask, survive hiding the dialog, and are cleared once the ask is answered.",
    "Approve carries any notes with it, and its button shows how many. Nothing you wrote is dropped.",
];
const DOC_NOTES_DECISIONS_CROWDED = [
    ...DOC_NOTES_DECISIONS,
    "A selection that crosses a code block or a table quotes its text only.",
    "Notes are sent in document order, not the order they were written.",
    "The same gesture works in the plan review; its findings are not quotable.",
    "A passage quoted twice makes two notes.",
    "Selecting inside the decisions list does nothing.",
];
const DOC_NOTES_STAYS_NOTE = "Keep it highlighted after sending too, until the lead picks it up.";
const DOC_NOTES_CUT_NOTE = "Don't cut it. Send the whole passage.";
const DOC_NOTES_REWORD_NOTE = "Clicking a note should scroll the document to its passage.";
const DOC_NOTES_REWORD_EDIT = "Scroll the document to the passage when its note is clicked.";
// the Crowded board's notes, in document order
const DOC_NOTES_CROWDED = [
    [DOC_NOTES_FIELD, "Open it above when the selection is near the bottom."],
    [DOC_NOTES_STAYS, DOC_NOTES_STAYS_NOTE],
    [DOC_NOTES_REWORD, DOC_NOTES_REWORD_NOTE],
    [DOC_NOTES_ORDER, "Yes. Not the order I wrote them in."],
    [DOC_NOTES_CUT, DOC_NOTES_CUT_NOTE],
    [DOC_NOTES_KEYBOARD, ""],
];
// the order they are written in
const DOC_NOTES_WRITTEN = [4, 1, 5, 0, 3, 2];
const DOC_NOTES_LIST_CAP = 300;
const DOC_NOTES_PANEL_WIDTH = 1240;
const DOC_NOTES_RAIL_WIDTH = 460;
const DOC_NOTES_EMPTY = "No note yet";

// page-side helpers, prefixed to every evaluated body. Every query is under the dialog panel.
const DOC_NOTES_LIB = `
    const panel = () => ${DOC_REVIEW_PANEL};
    const docRoot = () => panel()?.querySelector("[data-doc-review-doc]");
    // the document sits in a fade wrapper inside its scroller
    const docScroller = () => docRoot()?.closest(".sc");
    const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
    const ranges = (name) => CSS.highlights.get(name)?.size ?? 0;
    const box = (r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    const ownText = (el) =>
        [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("").trim();
    const textNode = (root, passage) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const at = n.nodeValue.indexOf(passage);
            if (at >= 0) return { node: n, at };
        }
        return null;
    };
    const rangeOf = (passage) => {
        const hit = docRoot() && textNode(docRoot(), passage);
        if (!hit) return null;
        const range = document.createRange();
        range.setStart(hit.node, hit.at);
        range.setEnd(hit.node, hit.at + passage.length);
        return range;
    };
    const selectRange = (range) => {
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        docRoot().dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    };
    const select = (passage) => {
        const range = rangeOf(passage);
        if (!range) return null;
        selectRange(range);
        return box(range.getBoundingClientRect());
    };
    const type = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const key = (el, k, mods) =>
        el.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true, ...mods }));
    const fieldInput = () => panel()?.querySelector("[data-doc-note-field] input");
    const rowOf = (passage) =>
        [...panel().querySelectorAll("[data-doc-note-row]")].find((r) => r.textContent.includes(passage));
    const button = (label) => [...panel().querySelectorAll("button")].find((b) => ownText(b) === label);
    const addNote = async (passage, note) => {
        select(passage);
        await settle();
        const input = fieldInput();
        if (!input) return false;
        if (note) {
            type(input, note);
            await settle();
        }
        key(input, "Enter");
        await settle();
        return true;
    };
    const state = () => {
        const p = panel();
        if (!p) return { open: false };
        const notes = p.querySelector("[data-doc-notes]");
        const toggle = notes?.querySelector("[data-doc-notes-toggle]");
        const list = notes?.querySelector("[data-doc-notes-list]");
        const field = p.querySelector("[data-doc-note-field]");
        const decisions = p.querySelector("ol")?.parentElement;
        return {
            open: true,
            panel: box(p.getBoundingClientRect()),
            panelWidth: p.offsetWidth,
            railWidth: decisions?.parentElement.offsetWidth ?? null,
            heading: p.querySelector("[data-doc-review-doc] h1")?.textContent.trim() ?? null,
            items: p.querySelectorAll("ol > li").length,
            decisions: decisions ? { client: decisions.clientHeight, scroll: decisions.scrollHeight } : null,
            header: toggle?.querySelector("span")?.textContent.trim() ?? null,
            expanded: toggle?.getAttribute("aria-expanded") ?? null,
            list: list ? { client: list.clientHeight, scroll: list.scrollHeight } : null,
            rows: [...(notes?.querySelectorAll("[data-doc-note-row]") ?? [])].map((row) => {
                const edit = row.querySelector('button[aria-label="Edit this note"]');
                const input = row.querySelector("input");
                return {
                    open: row.getAttribute("data-open") === "true",
                    passage: (edit ?? row.firstElementChild)?.firstElementChild?.textContent ?? null,
                    note: input ? input.value : (edit?.children[1]?.textContent ?? null),
                    input: !!input,
                    locked: edit?.disabled ?? false,
                    remove: !!row.querySelector('button[aria-label="Remove this note"]'),
                };
            }),
            field: field ? box(field.getBoundingClientRect()) : null,
            fieldFocused: !!field && document.activeElement === field.querySelector("input"),
            quoted: ranges("doc-review-quoted"),
            pending: ranges("doc-review-pending"),
            buttons: [...p.querySelectorAll("button")].map(ownText).filter(Boolean),
            sent: [...p.querySelectorAll("span")].find((s) => s.textContent.startsWith("Sent: "))?.textContent ?? null,
        };
    };
`;

// runs a body in the page (it may await, and set out), lets React settle, and resolves to the dialog's state
const docNotesAct = (h, body = "") =>
    h.ev(`(async () => {
        ${DOC_NOTES_LIB}
        let out = null;
        ${body}
        await settle();
        return { ...state(), out };
    })()`);

const docNotesJson = (v) => JSON.stringify(v);

// what a step's detail keeps of the dialog's state
const docNotesBrief = (s, out) =>
    JSON.stringify({
        open: s.open,
        header: s.header,
        rows: (s.rows ?? []).map((r) => [r.passage, r.note, r.open ? "open" : r.locked ? "locked" : "compact"]),
        field: s.field != null,
        quoted: s.quoted,
        pending: s.pending,
        buttons: s.buttons,
        sent: s.sent,
        ...out,
    });

// the fixture ask has no live block, and an answer that does not reach its agent unlocks the ask again (8051926e0),
// so the page's AnswerAgentCommand takes the answer; the reload in teardown puts the real one back
const docNotesTakeAnswers = (h) =>
    h.ev(`(async () => {
        ${APP_MOD}
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        RpcApi.AnswerAgentCommand = async () => null;
        return true;
    })()`);

// the fixture roster is read once at boot
async function docNotesReload(h, ctx, decisions) {
    writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(docReviewRoster(ctx.runId, ctx.specPath, decisions), null, 2));
    await h.ev("location.reload()");
    await h.ev(`(async () => {
        for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
            await new Promise((r) => setTimeout(r, 500));
        }
    })()`);
    await h.goto("cockpit");
    await docNotesTakeAnswers(h);
    return docReviewWait(
        h,
        `document.querySelector('[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"]')`,
        15000
    );
}

const docNotesTag = `${docReviewTreeRow(DOC_REVIEW_LEAD)}?.querySelector('button[title="${DOC_REVIEW_TAG_TITLE}"]')`;

// through the lead's tree tag, and resolved once the document is rendered and the panel has stopped scaling
async function docNotesOpenByTag(h) {
    const tagged = await docReviewWait(h, docNotesTag);
    await h.ev(`${docNotesTag}?.click()`);
    const open = await docReviewWait(h, DOC_REVIEW_PANEL);
    const rendered = await docReviewWait(h, `${DOC_REVIEW_PANEL}?.querySelector("[data-doc-review-doc] h1")`);
    await h.ev(`new Promise((r) => setTimeout(r, 500))`);
    return tagged && open && rendered;
}

// from the Cockpit: the worker's card leads to the Agent surface without spending the lead's auto-open
async function docNotesOpen(h) {
    await h.ev(`document.querySelector(
        '[data-cockpit-surface] [data-agent-id="${DOC_REVIEW_WORKER_ID}"] button[title="Open terminal (T)"]'
    )?.click()`);
    return docNotesOpenByTag(h);
}

export const docReviewNotes = {
    name: "doc-review-notes",
    surface: "cockpit",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-doc-review-notes-"));
        const ctx = { cwd };
        try {
            await arrangeFixtureRun(h, ctx, "doc-review-notes", DOC_REVIEW_LEAD);
            ctx.specPath = join(cwd, "2026-10-05-highlight-to-quote-design.md");
            writeFileSync(ctx.specPath, `${DOC_NOTES_SPEC}\n`);
            // the panel and rail widths asserted below need the room, and verify.mjs restores its own pin after
            await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
            ctx.rosterLoaded = await docNotesReload(h, ctx, DOC_NOTES_DECISIONS);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail });
        const has = (s, label) => (s.buttons ?? []).includes(label);
        const passages = (s) => (s.rows ?? []).map((r) => r.passage);
        if (ctx.arrangeError != null || !ctx.rosterLoaded) {
            return [{ step: "0. the fixture roster loaded", ok: false, detail: ctx.arrangeError ?? "no worker card" }];
        }

        const opened1 = await docNotesOpen(h);
        const s1 = await docNotesAct(h);
        rec(
            "1. the dialog is open on the fixture spec: 4 decisions, no notes, Approve and Request changes, 1240 wide with a 460 rail",
            opened1 &&
                s1.heading === DOC_NOTES_HEADING &&
                s1.items === DOC_NOTES_DECISIONS.length &&
                s1.header == null &&
                s1.rows.length === 0 &&
                has(s1, "Approve") &&
                has(s1, "Request changes") &&
                s1.panelWidth === DOC_NOTES_PANEL_WIDTH &&
                s1.railWidth === DOC_NOTES_RAIL_WIDTH,
            docNotesBrief(s1, {
                opened: opened1,
                heading: s1.heading,
                items: s1.items,
                panelWidth: s1.panelWidth,
                railWidth: s1.railWidth,
            })
        );

        const s2 = await docNotesAct(h, `out = select(${docNotesJson(DOC_NOTES_STAYS)});`);
        rec(
            "2. selecting a passage opens the note field under it, focused, and tints the passage",
            s2.out != null && s2.field != null && s2.field.top >= s2.out.bottom && s2.fieldFocused && s2.pending === 1,
            docNotesBrief(s2, { selection: s2.out, fieldRect: s2.field, focused: s2.fieldFocused })
        );

        const s3 = await docNotesAct(
            h,
            `type(fieldInput(), ${docNotesJson(DOC_NOTES_STAYS_NOTE)});
            await settle();
            key(fieldInput(), "Enter");`
        );
        rec(
            "3. a note and Enter: the field closes, the rail lists the note, the passage stays painted, the footer counts it, nothing is sent",
            s3.open &&
                s3.field == null &&
                s3.header === "Your notes · 1" &&
                s3.rows.length === 1 &&
                s3.rows[0].passage === DOC_NOTES_STAYS &&
                s3.rows[0].note === DOC_NOTES_STAYS_NOTE &&
                s3.quoted === 1 &&
                s3.pending === 0 &&
                has(s3, "Approve with 1 note") &&
                has(s3, "Request changes · 1 note") &&
                s3.sent == null,
            docNotesBrief(s3)
        );
        const draft3 = await docNotesAct(
            h,
            `select(${docNotesJson(DOC_NOTES_CUT)});
            await settle();
            type(fieldInput(), ${docNotesJson(DOC_NOTES_CUT_NOTE)});`
        );
        await h.shot("cdp-shots/doc-review-notes-main.png");
        rec(
            "3b. the Main board: one kept note, and the field open with a draft under a second, tinted passage",
            draft3.field != null && draft3.pending === 1 && draft3.quoted === 1 && draft3.rows.length === 1,
            docNotesBrief(draft3)
        );

        const s4 = await docNotesAct(h, `key(fieldInput(), "Escape");`);
        rec(
            "4. Escape in the field drops it and leaves the note and the dialog",
            s4.open && s4.field == null && s4.rows.length === 1 && s4.pending === 0,
            docNotesBrief(s4)
        );

        const s4b = await docNotesAct(
            h,
            `const from = textNode(docRoot(), ${docNotesJson(DOC_NOTES_KEYBOARD)});
            const to = textNode(docRoot(), ${docNotesJson(DOC_NOTES_FENCE)});
            const range = document.createRange();
            range.setStart(from.node, from.at);
            range.setEnd(to.node, to.at + ${DOC_NOTES_FENCE.length});
            selectRange(range);
            await settle();
            key(fieldInput(), "Enter");`
        );
        const removed4b = await docNotesAct(
            h,
            `rowOf(${docNotesJson(DOC_NOTES_FENCE)})?.querySelector('button[aria-label="Remove this note"]')?.click();`
        );
        rec(
            "4b. a passage quoted through a fenced code block is painted, and removing its note unpaints it",
            s4b.rows.length === 2 &&
                s4b.rows[1].passage.endsWith(`keys. alpha ${DOC_NOTES_FENCE}`) &&
                s4b.quoted === 2 &&
                removed4b.rows.length === 1 &&
                removed4b.quoted === 1,
            docNotesBrief(s4b, { afterRemove: removed4b.quoted })
        );

        const s5 = await docNotesAct(
            h,
            `const from = textNode(docRoot(), ${docNotesJson(DOC_NOTES_REWORD)});
            const to = textNode(panel().querySelector("ol"), ${docNotesJson(DOC_NOTES_DECISIONS[0])});
            const range = document.createRange();
            range.setStart(from.node, from.at);
            range.setEnd(to.node, to.at + 7);
            selectRange(range);
            out = { selected: getSelection().toString().length, endsInDoc: docRoot().contains(range.endContainer) };`
        );
        await h.ev("getSelection().removeAllRanges()");
        rec(
            "5. a selection that starts in the document and ends in the decisions opens nothing",
            s5.out.selected > 0 && !s5.out.endsInDoc && s5.field == null && s5.pending === 0,
            docNotesBrief(s5, s5.out)
        );

        const s6 = await docNotesAct(
            h,
            `const scroller = docScroller();
            const pane = scroller.getBoundingClientRect();
            scroller.scrollTop += rangeOf(${docNotesJson(DOC_NOTES_LAST)}).getBoundingClientRect().bottom - pane.bottom;
            await settle();
            out = {
                scrolls: scroller.scrollHeight > scroller.clientHeight,
                scrollTop: scroller.scrollTop,
                paneBottom: pane.bottom,
                selection: select(${docNotesJson(DOC_NOTES_LAST)}),
            };`
        );
        await h.shot("cdp-shots/doc-review-notes-flip.png");
        const inside6 =
            s6.field != null &&
            s6.field.top >= s6.panel.top &&
            s6.field.bottom <= s6.panel.bottom &&
            s6.field.left >= s6.panel.left &&
            s6.field.right <= s6.panel.right;
        rec(
            "6. with no room below, the field opens above a selection at the pane's bottom edge, inside the dialog",
            s6.out.scrolls && s6.out.scrollTop > 0 && s6.field != null && s6.field.bottom <= s6.out.selection.top && inside6,
            docNotesBrief(s6, { ...s6.out, fieldRect: s6.field, panelRect: s6.panel })
        );
        const dropped6 = await docNotesAct(h, `key(fieldInput(), "Escape"); docScroller().scrollTop = 0;`);

        await docReviewEscape(h);
        const gone7 = await docReviewWait(h, `!${DOC_REVIEW_PANEL}`, 3000);
        const reopened7 = await docNotesOpenByTag(h);
        const s7 = await docNotesAct(h);
        rec(
            "7. Escape hides the dialog; reopened, the note is still listed and its passage painted again",
            dropped6.field == null &&
                gone7 &&
                reopened7 &&
                s7.rows.length === 1 &&
                s7.rows[0].passage === DOC_NOTES_STAYS &&
                s7.rows[0].note === DOC_NOTES_STAYS_NOTE &&
                s7.quoted === 1,
            docNotesBrief(s7, { gone: gone7, reopened: reopened7 })
        );

        const request8 = await docNotesAct(h, `button("Request changes · 1 note")?.click();`);
        const s8 = await docNotesAct(
            h,
            `const send = button("Send 1 note to the lead");
            out = { textarea: panel().querySelector("#doc-review-note")?.value ?? null, enabled: !!send && !send.disabled };
            send?.click();`
        );
        await h.shot("cdp-shots/doc-review-notes-request-sent.png");
        const locked8 = await docNotesAct(
            h,
            `const row = rowOf(${docNotesJson(DOC_NOTES_STAYS)});
            row?.querySelector('button[aria-label="Edit this note"]')?.click();
            row?.querySelector('button[aria-label="Remove this note"]')?.click();
            await settle();
            select(${docNotesJson(DOC_NOTES_CUT)});`
        );
        await h.ev("getSelection().removeAllRanges()");
        rec(
            "8. Request changes with the textarea empty sends the one note: the sent line counts it, the row locks, a selection opens nothing",
            has(request8, "Send 1 note to the lead") &&
                s8.out.textarea === "" &&
                s8.out.enabled &&
                s8.sent === "Sent: Request changes, with 1 note" &&
                locked8.sent === s8.sent &&
                locked8.rows.length === 1 &&
                locked8.rows[0].locked &&
                !locked8.rows[0].remove &&
                !locked8.rows[0].open &&
                locked8.field == null &&
                locked8.pending === 0,
            docNotesBrief(locked8, s8.out)
        );

        // a new askId, so the sent lock is gone; the reload empties the notes too
        const loaded9 = await docNotesReload(h, ctx, DOC_NOTES_DECISIONS_CROWDED);
        const opened9 = loaded9 && (await docNotesOpen(h));
        const fresh9 = await docNotesAct(h);
        const written9 = DOC_NOTES_WRITTEN.map((i) => DOC_NOTES_CROWDED[i]);
        const s9 = await docNotesAct(
            h,
            `out = { added: [] };
            for (const [passage, note] of ${docNotesJson(written9)}) out.added.push(await addNote(passage, note));
            rowOf(${docNotesJson(DOC_NOTES_REWORD)})?.querySelector('button[aria-label="Edit this note"]')?.click();`
        );
        await h.shot("cdp-shots/doc-review-notes-crowded.png");
        const open9 = s9.rows.filter((r) => r.open);
        rec(
            "9. the Crowded board: six notes in document order, one empty, one open, the list capped at 300 and the decisions scrolling above it",
            opened9 &&
                fresh9.items === DOC_NOTES_DECISIONS_CROWDED.length &&
                fresh9.rows.length === 0 &&
                s9.out.added.every(Boolean) &&
                docNotesJson(passages(s9)) === docNotesJson(DOC_NOTES_CROWDED.map(([passage]) => passage)) &&
                s9.rows.at(-1).note === DOC_NOTES_EMPTY &&
                open9.length === 1 &&
                open9[0].passage === DOC_NOTES_REWORD &&
                open9[0].input &&
                open9[0].note === DOC_NOTES_REWORD_NOTE &&
                s9.rows.filter((r) => r.input).length === 1 &&
                s9.list.client <= DOC_NOTES_LIST_CAP &&
                s9.list.scroll > s9.list.client &&
                s9.decisions.scroll > s9.decisions.client &&
                s9.quoted === DOC_NOTES_CROWDED.length &&
                has(s9, "Approve with 6 notes") &&
                has(s9, "Request changes · 6 notes"),
            docNotesBrief(s9, {
                opened: opened9,
                items: fresh9.items,
                startedWith: fresh9.rows.length,
                list: s9.list,
                decisions: s9.decisions,
            })
        );

        const openInput = `panel().querySelector('[data-doc-note-row][data-open="true"] input')`;
        const s10 = await docNotesAct(
            h,
            `type(${openInput}, ${docNotesJson(DOC_NOTES_REWORD_EDIT)});
            await settle();
            key(${openInput}, "Enter");`
        );
        const esc10 = await docNotesAct(
            h,
            `rowOf(${docNotesJson(DOC_NOTES_REWORD)})?.querySelector('button[aria-label="Edit this note"]')?.click();
            await settle();
            out = { reopened: !!${openInput} };
            key(${openInput}, "Escape");`
        );
        const reworded = (s) => s.rows.find((r) => r.passage === DOC_NOTES_REWORD)?.note;
        rec(
            "10. in the open row, Enter keeps the new note and closes the row, Escape closes it; neither sends nor hides the dialog",
            s10.open &&
                !s10.rows.some((r) => r.open) &&
                reworded(s10) === DOC_NOTES_REWORD_EDIT &&
                s10.sent == null &&
                esc10.out.reopened &&
                esc10.open &&
                !esc10.rows.some((r) => r.open) &&
                reworded(esc10) === DOC_NOTES_REWORD_EDIT &&
                esc10.sent == null,
            docNotesBrief(esc10, { afterEnter: s10.rows.map((r) => r.open), reopened: esc10.out.reopened })
        );

        const toggle = `panel().querySelector("[data-doc-notes-toggle]").click();`;
        // the list leaves through its exit, so it is still attached for durExit after the click
        const collapsed11 = await docNotesAct(h, `${toggle} await settle(400);`);
        const expanded11 = await docNotesAct(h, toggle);
        const remove = `panel().querySelector('[data-doc-note-row] button[aria-label="Remove this note"]')`;
        const five11 = await docNotesAct(h, `${remove}.click();`);
        const none11 = await docNotesAct(h, `for (let i = 0; i < 10 && ${remove}; i++) { ${remove}.click(); await settle(); }`);
        const kept = [DOC_NOTES_CROWDED[4], DOC_NOTES_CROWDED[1]];
        const two11 = await docNotesAct(h, `for (const [passage, note] of ${docNotesJson(kept)}) await addNote(passage, note);`);
        rec(
            "11. the header collapses and expands the list; removing a note drops its row and its highlight, removing all drops the section",
            collapsed11.expanded === "false" &&
                collapsed11.rows.length === 0 &&
                collapsed11.header === "Your notes · 6" &&
                expanded11.expanded === "true" &&
                expanded11.rows.length === 6 &&
                five11.rows.length === 5 &&
                five11.quoted === 5 &&
                has(five11, "Approve with 5 notes") &&
                none11.header == null &&
                none11.rows.length === 0 &&
                none11.quoted === 0 &&
                has(none11, "Approve") &&
                has(none11, "Request changes") &&
                docNotesJson(passages(two11)) === docNotesJson([DOC_NOTES_STAYS, DOC_NOTES_CUT]),
            docNotesBrief(two11, {
                collapsed: [collapsed11.expanded, collapsed11.rows.length],
                expanded: [expanded11.expanded, expanded11.rows.length],
                afterOne: [five11.rows.length, five11.quoted, five11.buttons],
                afterAll: [none11.header, none11.quoted, none11.buttons],
            })
        );

        const s12 = await docNotesAct(
            h,
            `button("Request changes · 2 notes")?.click();
            await settle();
            const area = panel().querySelector("#doc-review-note");
            const send = button("Send 2 notes to the lead");
            out = {
                label: panel().querySelector('label[for="doc-review-note"]')?.textContent ?? null,
                placeholder: area?.placeholder ?? null,
                value: area?.value ?? null,
                enabled: !!send && !send.disabled,
            };`
        );
        await h.shot("cdp-shots/doc-review-notes-request.png");
        const cancel12 = await docNotesAct(h, `button("Cancel")?.click();`);
        rec(
            "12. Request changes with notes: the textarea is optional and Send 2 notes is enabled while it is empty; Cancel returns",
            s12.out.label === "Anything beyond your 2 notes?" &&
                s12.out.placeholder === "Optional" &&
                s12.out.value === "" &&
                s12.out.enabled &&
                has(cancel12, "Approve with 2 notes") &&
                has(cancel12, "Request changes · 2 notes") &&
                cancel12.sent == null,
            docNotesBrief(cancel12, s12.out)
        );

        // ctrl+enter while the field holds a draft: the draft joins the notes, then the answer leaves
        const s13 = await docNotesAct(
            h,
            `select(${docNotesJson(DOC_NOTES_ORDER)});
            await settle();
            type(fieldInput(), ${docNotesJson(DOC_NOTES_CROWDED[3][1])});
            await settle();
            out = { focusInField: document.activeElement === fieldInput() };
            key(document.activeElement || document.body, "Enter", { ctrlKey: true });`
        );
        await h.shot("cdp-shots/doc-review-notes-sent.png");
        const locked13 = await docNotesAct(
            h,
            `for (const row of panel().querySelectorAll("[data-doc-note-row]")) {
                row.querySelector('button[aria-label="Edit this note"]')?.click();
                row.querySelector('button[aria-label="Remove this note"]')?.click();
            }
            await settle();
            select(${docNotesJson(DOC_NOTES_REWORD)});`
        );
        await h.ev("getSelection().removeAllRanges()");
        const order13 = docNotesJson([DOC_NOTES_STAYS, DOC_NOTES_ORDER, DOC_NOTES_CUT]);
        rec(
            "13. Ctrl+Enter with a draft in the field adds it and approves: the sent line counts 3 notes, the rows lock, a selection opens nothing",
            s13.out.focusInField &&
                s13.sent === "Sent: Approve, with 3 notes" &&
                s13.field == null &&
                docNotesJson(passages(s13)) === order13 &&
                s13.rows[1].note === DOC_NOTES_CROWDED[3][1] &&
                locked13.sent === s13.sent &&
                docNotesJson(passages(locked13)) === order13 &&
                locked13.rows.every((r) => r.locked && !r.remove && !r.open) &&
                locked13.field == null &&
                locked13.pending === 0,
            docNotesBrief(locked13, s13.out)
        );

        await docReviewEscape(h);
        await docReviewWait(h, `!${DOC_REVIEW_PANEL}`, 3000);
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "doc-review-notes");
    },
};
