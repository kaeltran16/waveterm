// Code surface review fixes: code-blame-draft (F9). Blame describes the saved file, so with an unsaved draft
// each entry has to sit beside its saved lines where the draft moved them, and an inserted line gets none.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./scenarios-shared.mjs";
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";

const FILE = "blame.txt";
const SEED = "seed the file";
const SECOND = "edit line four";
const SAVED = ["one", "two", "three", "FOUR", "five", "six"];
const INSERTED = "inserted";
const text = (lines) => lines.join("\n") + "\n";

// where each blame row and each editor line sits on screen; rows by sha and subject, lines by their text
const READ_ROWS = `
    const rows = [...document.querySelectorAll("[data-code-blame-column] [data-code-blame-entry]")].map((r) => ({
        subject: (r.getAttribute("title") || "").split(" — ")[0],
        top: Math.round(r.getBoundingClientRect().top),
        bottom: Math.round(r.getBoundingClientRect().bottom),
    }));
    const lineTop = (t) => {
        const el = [...document.querySelectorAll(".monaco-editor .view-line")].find((l) => flat(l) === t);
        return el == null ? null : Math.round(el.getBoundingClientRect().top);
    };
`;

// a row sits beside a line when their tops agree to a pixel or two of rounding
const beside = (row, top) => row != null && top != null && Math.abs(row.top - top) <= 2;

export const codeBlameDraft = {
    name: "code-blame-draft",
    surface: "code",
    async arrange() {
        const dir = makeCodeRepo({ [FILE]: text(SAVED.map((l) => (l === "FOUR" ? "four" : l))) });
        git(dir, "commit", "-q", "--amend", "-m", SEED);
        writeFileSync(join(dir, FILE), text(SAVED));
        git(dir, "commit", "-q", "-am", SECOND);
        return { dir };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        const folder = await openFolderInCode(h, ctx.dir);
        const file = folder === true && (await openFileInCode(h, FILE));
        const shown = await codeEval(h, `
            await until(() => document.querySelector(".monaco-editor .view-line") != null, 8000);
            // the toggle is module state another scenario may have left on
            if (document.querySelector("[data-code-blame-column]") == null) document.querySelector("[data-code-blame-toggle]")?.click();
            await until(() => document.querySelectorAll("[data-code-blame-column] [data-code-blame-entry]").length >= 3, 30000);
            await nap(300);
            ${READ_ROWS}
            return { rows, one: lineTop("one"), four: lineTop("FOUR") };
        `);
        await h.shot("cdp-shots/code-blame-draft-saved.png");
        const seed0 = shown?.rows?.find((r) => r.subject === SEED);
        const second0 = shown?.rows?.find((r) => r.subject === SECOND);
        rec(
            "with no draft, the seed row sits beside line one and the second commit's row beside FOUR",
            file === true && beside(seed0, shown?.one) && beside(second0, shown?.four),
            JSON.stringify({ folder, file, shown })
        );

        // Monaco takes no text a CDP session types, so the edit goes through editDraft, which its onChange calls
        const drafted = await codeEval(h, `
            const { editDraft } = await mod("app/view/code/codestore.ts");
            editDraft(${JSON.stringify(text([INSERTED, ...SAVED]))});
            await until(() => [...document.querySelectorAll(".monaco-editor .view-line")].some((l) => flat(l) === ${JSON.stringify(INSERTED)}), 4000);
            await nap(400);
            ${READ_ROWS}
            return { rows, inserted: lineTop(${JSON.stringify(INSERTED)}), one: lineTop("one"), four: lineTop("FOUR") };
        `);
        await h.shot("cdp-shots/code-blame-draft-inserted.png");
        const first = drafted?.rows?.slice().sort((a, b) => a.top - b.top)[0];
        rec(
            "after inserting a line at the top, the first blame row sits beside saved line one, not the inserted line",
            first?.subject === SEED && beside(first, drafted?.one) && !beside(first, drafted?.inserted),
            JSON.stringify(drafted)
        );
        const covered =
            drafted?.inserted != null &&
            (drafted?.rows ?? []).some((r) => r.top <= drafted.inserted + 2 && r.bottom > drafted.inserted + 2);
        const second = drafted?.rows?.find((r) => r.subject === SECOND);
        rec(
            "the inserted line has no blame row, and the second commit's row moved down with FOUR",
            !covered && beside(second, drafted?.four),
            JSON.stringify({ covered, second, four: drafted?.four })
        );

        await codeEval(h, `
            const { revertDraft } = await mod("app/view/code/codestore.ts");
            revertDraft();
            if (document.querySelector("[data-code-blame-column]") != null) document.querySelector("[data-code-blame-toggle]")?.click();
        `);
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        if (ctx?.dir) removeCodeRepo(ctx.dir);
    },
};
