---
name: ui-mockup
description: |
  Make a standalone HTML mockup/prototype of a UI change before implementation, per the
  repo's prototype-first rule. Use for any new screen design or screen redesign request
  in this repository.
---

# UI Mockup (prototype-first)

Repo rule: UI changes get a validated high-fidelity HTML mockup before code — the design
must be seen rendered before it is built. Prototype first, always.

1. **Read DESIGN.md fully** — do's and don'ts included, not just the tokens — and read the
   current component code for the surface being redesigned (match its conventions).
2. **Copy `docs/prototype/mockup-template.html`** as the starting file. Never hand-inline
   token values; the `:root` block is generated from `frontend/tailwindsetup.css` — run
   `task mockup:kit` first if `@theme` changed since the template was generated.
3. **Build with the template's recipes** — card/panel, row, chips, badges, sec-head,
   buttons, progress, skeleton, status dot. Don't introduce new recipes per surface.
4. **Run the audit checklist** at the top of the template before presenting: tokens only,
   contrast >= 4.5:1, status never color alone, focus-visible on interactives, reduced
   motion, correct card recipe (.card vs .panel), single accent CTA, micro motion only.
5. **Serve and present** — `python -m http.server 8766` in `docs/prototype/`, open the
   file in a browser, and present with a summary of the design direction. Iterate on the
   mockup until the user approves; implementation starts only after approval.
