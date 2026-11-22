// Scenario rendered-bs-design: the design card at the end of the Rendered transcript through the DesignReady,
// KeepTalking and all-yours states; That's right pressing a guess, the narrow column stacking each row's buttons and
// keeping the settled design whole, and
// Confirm all and Check with a builder sending the pane's lines. kit is scenarios-rendered-brainstorm.mjs's RBS_KIT.

const NAME = "rendered-bs-design";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
// the header row alone measures 46px (69px wrapped); this is workspace-brainstorm-cards's bound, the full card is taller
const ROW_MAX_PX = 80;

const TITLES = [
  ["what", "What counts"],
  ["who", "Who it protects"],
  ["approach", "Approach"],
  ["queue", "Final queue"],
  ["banner", "Banner"],
];
const GISTS = {
  what: "Runs with a Final",
  who: "The oldest waiting run first",
  approach: "One Final at a time",
  queue: "Queue verifies one at a time",
  banner: "Warn after 20 minutes",
};
const parts = (states, over = {}) =>
  TITLES.map(([id, title], i) => ({ id, title, state: states[i], gist: GISTS[id], body: "", ...over[id] }));

const answered = (n, into) => ({ kind: "question", n, q: `question ${n}`, a: `answer ${n}`, into });
const file = (over) => ({
  v: 1,
  title: "Run memory pressure",
  spec: "docs/superpowers/specs/2026-11-17-run-memory-pressure-design.md",
  question: null,
  working: null,
  parts: [],
  history: [answered(1, ["what"]), answered(2, ["who"]), answered(3, ["approach"])],
  done: true,
  check: null,
  run: null,
  ...over,
});

const DESIGN_READY = file({ parts: parts(["yours", "yours", "yours", "guess", "guess"]) });
// the agent reopened Banner after the user had confirmed it
const KEEP_TALKING = file({
  parts: parts(["yours", "yours", "yours", "yours", "guess"], {
    banner: { gist: "Warn after 10 minutes", was: GISTS.banner },
  }),
});
const ALL_YOURS = file({ parts: parts(["yours", "yours", "yours", "yours", "yours"]) });

export default (kit) => {
  const {
    scenario,
    writeFile,
    waitCard,
    narrow,
    widen,
    recordSends,
    sentLines,
    waitSent,
    agentIdle,
    agentPage,
    polishWaitFor,
    polishNap,
    closePaneTabs,
    HOST,
    PANE,
    RV,
  } = kit;
  const CARD = `${HOST}?.querySelector("[data-rendered-bs-design]")`;
  const ROW = (id) => `${CARD}?.querySelector('[data-rendered-bs-design-row="${id}"]')`;

  // the card as drawn: its text pieces, each row (state, buttons, whether they sit under the line) and its buttons
  const readD = (h) =>
    h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const host = ${HOST};
            const card = ${CARD};
            const q = (sel) => card?.querySelector(sel);
            const rows = [...(card?.querySelectorAll("[data-rendered-bs-design-row]") ?? [])].map((r) => {
                const gist = r.querySelector("[data-rendered-bs-design-gist]")?.getBoundingClientRect();
                const acts = r.querySelector("[data-rendered-bs-design-actions]");
                const a = acts?.getBoundingClientRect();
                const btns = [...(acts?.querySelectorAll("button") ?? [])];
                return {
                    id: r.getAttribute("data-rendered-bs-design-row"),
                    state: r.getAttribute("data-state"),
                    title: flat(r.querySelector("[data-rendered-bs-part-link]")),
                    gist: flat(r.querySelector("[data-rendered-bs-design-gist]")),
                    buttons: btns.map(flat),
                    pressed: btns.filter((b) => b.getAttribute("aria-pressed") === "true").map(flat),
                    changedMark: flat(r.querySelector("[data-rendered-bs-changed]")),
                    under: gist && a ? a.top >= gist.bottom - 1 : null,
                };
            });
            return {
                kind: host?.getAttribute("data-rendered-bs-card") ?? null,
                compact: host?.hasAttribute("data-compact") ?? null,
                card: card != null,
                status: flat(q("[data-rendered-bs-status]")),
                head: flat(q("[data-rendered-bs-head]")),
                chip: flat(q("[data-rendered-bs-chip]")),
                heading: flat(q("[data-rendered-bs-design-title]")),
                row: q("[data-rendered-bs-row]") != null,
                rowTitle: flat(q("[data-rendered-bs-row-title]")),
                height: card ? Math.round(card.getBoundingClientRect().height) : null,
                body: q("[data-rendered-bs-body]") != null,
                settledRow: q("[data-rendered-bs-design-settled]") != null,
                needsPill: host?.querySelector("[data-needs-input]") != null,
                line: flat(q("[data-rendered-bs-design-line]")),
                confirmed: flat(q("[data-rendered-bs-design-confirmed]")),
                open: flat(q("[data-rendered-bs-open]")),
                text: flat(card),
                confirmAll: flat(q("[data-rendered-bs-confirm-all]")),
                check: flat(q("[data-rendered-bs-check-btn]")),
                waiting: flat(q("[data-rendered-bs-design-waiting]")),
                rows,
            };
        })()`);

  const drawn = (h, test) =>
    polishWaitFor(h, `(() => { const card = ${CARD}; return ${test}; })()`, kit.BS_POLL_WAIT_MS);
  const click = (h, sel) =>
    h.ev(`(() => { const b = ${sel}; if (!b || b.disabled) return false; b.click(); return true; })()`);
  const THAT_S_RIGHT = "That’s right";

  return [
    scenario(NAME, { noTab: true, file: DESIGN_READY }, async (h, ctx, step) => {
      await step(
        "DesignReady: Confirm the design, 2 guesses, Confirm all 2 guesses, That's right and Edit on each guess, the waiting line",
        async () => {
          await recordSends(h);
          await waitCard(h, "design");
          const r = await readD(h);
          await h.shot(SHOT(1, "design-ready"));
          const guess = (id) => r.rows.find((x) => x.id === id);
          const ok =
            r.card &&
            r.head === `Brainstorm ${ctx.topic} Needs your input Talking it through · 3 of 5 yours Open brainstorm` &&
            r.heading === "Confirm the design" &&
            !r.needsPill &&
            r.status === "Talking it through · 3 of 5 yours" &&
            r.line.startsWith("2 decisions are still the agent’s guess.") &&
            r.confirmAll === "Confirm all 2 guesses" &&
            r.check === "" &&
            r.rows.map((x) => x.id).join("|") === "banner|queue|approach|who|what" &&
            r.rows.map((x) => x.title).join("|") === "Banner|Final queue|Approach|Who it protects|What counts" &&
            guess("banner").gist === GISTS.banner &&
            JSON.stringify(guess("banner").buttons) === JSON.stringify([THAT_S_RIGHT, "Edit"]) &&
            JSON.stringify(guess("queue").buttons) === JSON.stringify([THAT_S_RIGHT, "Edit"]) &&
            guess("what").buttons.length === 0 &&
            r.waiting === "Waiting for you: confirm the design, then Check with a builder";
          return [ok, r];
        }
      );

      await step("That's right on one guess presses it and sends nothing: the other guess still waits", async () => {
        const clicked = await click(h, `${ROW("banner")}?.querySelector("[aria-pressed]")`);
        await drawn(h, `${ROW("banner")}?.querySelector("[aria-pressed='true']") != null`);
        const r = await readD(h);
        await h.shot(SHOT(2, "pressed"));
        const banner = r.rows.find((x) => x.id === "banner");
        const queue = r.rows.find((x) => x.id === "queue");
        const sent = await sentLines(h);
        const ok =
          clicked &&
          banner.pressed.join("|") === THAT_S_RIGHT &&
          queue.pressed.length === 0 &&
          sent.length === 0 &&
          r.confirmAll === "Confirm all 2 guesses";
        return [ok, { clicked, sent, banner, queue }];
      });

      await step(
        "KeepTalking: the reopened Banner reads changed, with That's right and Edit, and no Confirm all",
        async () => {
          writeFile(ctx, KEEP_TALKING);
          await drawn(h, `${ROW("banner")}?.getAttribute("data-state") === "changed"`);
          const r = await readD(h);
          await h.shot(SHOT(3, "keep-talking"));
          const banner = r.rows.find((x) => x.id === "banner");
          const ok =
            r.kind === "design" &&
            banner.state === "changed" &&
            banner.gist === "Warn after 10 minutes" &&
            banner.changedMark === "changed" &&
            r.head.startsWith(`Brainstorm ${ctx.topic} Needs your input Talking it through · `) &&
            r.rows.filter((x) => x.changedMark === "changed").length === 1 &&
            JSON.stringify(banner.buttons) === JSON.stringify([THAT_S_RIGHT, "Edit"]) &&
            r.line.startsWith("1 decision changed since you confirmed it.") &&
            r.confirmAll === "";
          return [ok, r];
        }
      );

      await step(
        "every decision yours: the header reads Ready for the builder check, with one body row summing the design up beside Check with a builder, so The design reads once, and the rows are gone",
        async () => {
          writeFile(ctx, ALL_YOURS);
          await drawn(h, `card?.querySelector("[data-rendered-bs-check-btn]") != null`);
          const r = await readD(h);
          await h.shot(SHOT(4, "all-yours"));
          const ok =
            r.kind === "design" &&
            r.head === `Brainstorm ${ctx.topic} Ready for the builder check Open brainstorm` &&
            r.chip === "Ready for the builder check" &&
            r.status === "" &&
            r.body &&
            r.settledRow &&
            !r.needsPill &&
            r.line === "The design · 5 of 5 yours" &&
            r.confirmed === "you confirmed 2 guesses" &&
            r.text.split("The design").length === 2 &&
            r.open === "Open brainstorm" &&
            r.check === "Check with a builder" &&
            r.confirmAll === "" &&
            r.rows.length === 0 &&
            r.waiting === "";
          return [ok, r];
        }
      );

      await step(
        "with the Brainstorm tab showing, the settled design folds to the header alone, its title The design · 5 of 5 yours, and closing the tab brings the card back",
        async () => {
          writeFile(ctx, ALL_YOURS);
          await drawn(h, `card?.querySelector("[data-rendered-bs-check-btn]") != null`);
          await agentPage(
            h,
            `const W = await mod("app/view/agents/workspacestore.ts");
                        W.openWorkspaceTab(${JSON.stringify(ctx.agentId)}, { kind: "brainstorm" });
                        return true;`
          );
          const folded = await drawn(h, `card?.querySelector("[data-rendered-bs-row]") != null`);
          await polishNap(800);
          const r = await readD(h);
          await h.shot(SHOT(5, "settled-row"));
          const back = await closePaneTabs(h, ctx);
          await waitCard(h, "design");
          const full = await drawn(h, `card?.querySelector("[data-rendered-bs-check-btn]") != null`);
          const ok =
            folded &&
            r.row &&
            !r.body &&
            r.head === `Brainstorm ${ctx.topic} Ready for the builder check The design · 5 of 5 yours Open brainstorm` &&
            r.rowTitle === "The design · 5 of 5 yours" &&
            r.chip === "Ready for the builder check" &&
            r.open === "Open brainstorm" &&
            r.height != null &&
            r.height < ROW_MAX_PX &&
            back &&
            full;
          return [ok, { folded, back, full, ...r }];
        }
      );

      await step("the narrow column stacks each row's buttons under its line", async () => {
        writeFile(ctx, DESIGN_READY);
        await drawn(h, `card?.querySelector('[data-rendered-bs-design-row="banner"]') != null`);
        const narrowed = await narrow(h);
        const r = await readD(h);
        await h.shot(SHOT(6, "narrow"));
        const widened = await widen(h);
        const withButtons = r.rows.filter((x) => x.buttons.length > 0);
        const ok =
          narrowed &&
          r.compact === true &&
          withButtons.length === 2 &&
          withButtons.every((x) => x.under === true) &&
          widened;
        return [ok, { narrowed, widened, compact: r.compact, rows: r.rows }];
      });

      await step(
        "the narrow column keeps the settled design whole: the compact header reads Brainstorm, the topic, the chip and Open brainstorm, and the settled row wraps inside the card with Check with a builder in full",
        async () => {
          writeFile(ctx, ALL_YOURS);
          await drawn(h, `card?.querySelector("[data-rendered-bs-check-btn]") != null`);
          const narrowed = await narrow(h);
          const r = await readD(h);
          const box = await h.ev(`(() => {
              const card = ${CARD};
              const rect = (el) => el?.getBoundingClientRect() ?? null;
              const c = rect(card);
              const col = rect(${RV}?.querySelector("[data-rendered-column]"));
              const row = rect(card?.querySelector("[data-rendered-bs-design-settled]"));
              const btn = rect(card?.querySelector("[data-rendered-bs-check-btn]"));
              const within = (a, b) => a != null && b != null && a.left >= b.left - 1 && a.right <= b.right + 1;
              return {
                  rowInCard: within(row, c),
                  btnInCard: within(btn, c),
                  cardInColumn: within(c, col),
                  cardWidth: c ? Math.round(c.width) : null,
                  btnRight: btn ? Math.round(btn.right) : null,
                  cardRight: c ? Math.round(c.right) : null,
              };
          })()`);
          await h.shot(SHOT(7, "narrow-settled"));
          const widened = await widen(h);
          // compact, Open brainstorm ends the head's first line and the chip takes the second
          const ok =
            narrowed &&
            r.compact === true &&
            r.head === `Brainstorm ${ctx.topic} Open brainstorm Ready for the builder check` &&
            r.chip === "Ready for the builder check" &&
            r.open === "Open brainstorm" &&
            r.settledRow &&
            r.check === "Check with a builder" &&
            box.rowInCard &&
            box.btnInCard &&
            box.cardInColumn &&
            widened;
          return [ok, { narrowed, widened, compact: r.compact, head: r.head, check: r.check, ...box }];
        }
      );

      await step("Edit on the Banner row opens the Brainstorm tab at that part beside the transcript, its row open and in view", async () => {
        writeFile(ctx, DESIGN_READY);
        await drawn(h, `${ROW("banner")}?.querySelector("[data-rendered-bs-design-actions]") != null`);
        const edit = `[...(${ROW("banner")}?.querySelectorAll("[data-rendered-bs-design-actions] button") ?? [])].find((b) => b.innerText.trim() === "Edit")`;
        const clicked = await h.ev(`(() => { const b = ${edit}; if (!b || b.disabled) return false; b.click(); return true; })()`);
        const sel = `${PANE}?.querySelector('[data-brainstorm-part="banner"]')`;
        const shown = await polishWaitFor(h, `!!${sel}`, kit.WAIT_MS);
        await polishWaitFor(
          h,
          `${sel}?.querySelector("[data-brainstorm-row-toggle]")?.getAttribute("aria-expanded") === "true"`,
          kit.WAIT_MS
        );
        // the scroll is smooth: give it time to land before judging the row's place
        await polishNap(800);
        const row = await h.ev(`(() => {
            const el = ${sel};
            const toggle = el?.querySelector("[data-brainstorm-row-toggle]");
            let sc = el?.parentElement;
            while (sc && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
            const r = el?.getBoundingClientRect();
            const v = (sc ?? document.documentElement).getBoundingClientRect();
            return {
                expanded: toggle?.getAttribute("aria-expanded") ?? null,
                inView: r != null && r.top >= v.top - 1 && r.top < v.bottom,
                rendered: ${RV} != null,
            };
        })()`);
        await h.shot(SHOT(8, "edit-opens-pane"));
        const back = await closePaneTabs(h, ctx);
        await waitCard(h, "design");
        return [clicked && shown && row.expanded === "true" && row.inView && row.rendered && back, { clicked, shown, ...row, back }];
      });

      await step("Confirm all sends the pane's line", async () => {
        // the guess pressed in step 2 still waits, and a line carries waiting picks: drop it to see the plain line
        await agentPage(
          h,
          `const S = await mod("app/view/agents/brainstormstore.ts");
                    S.updateBrainstorm(${JSON.stringify(ctx.agentId)}, (x) => ({ ...x, picks: {} }));
                    return true;`
        );
        writeFile(ctx, DESIGN_READY);
        await drawn(h, `card?.querySelector("[data-rendered-bs-confirm-all]") != null`);
        const clicked = await click(h, `${CARD}?.querySelector("[data-rendered-bs-confirm-all]")`);
        const line = await waitSent(h, 0);
        return [clicked && line === "brainstorm: confirm every guess", { clicked, line }];
      });

      await step("Check with a builder sends the pane's line", async () => {
        await agentIdle(h, ctx);
        writeFile(ctx, ALL_YOURS);
        await drawn(h, `card?.querySelector("[data-rendered-bs-check-btn]") != null`);
        const clicked = await click(h, `${CARD}?.querySelector("[data-rendered-bs-check-btn]")`);
        const line = await waitSent(h, 1);
        return [clicked && line === "brainstorm: check", { clicked, line }];
      });
    }),
  ];
};
