# Headless AI section — runtime selector design

## 2026-08-15 — initial build (subagent, ui-design workflow)

Prototype states covered: openrouter selected (default) with key present and key missing;
harness selected (claude) with models locked; uninstalled harnesses (codex, opencode) visible
but disabled with a "not installed" tag.

Design decisions:
- Selector: radio-card rows (theme-picker language: border + rounded-[11px] + p-[10px], selected =
  accent-700 border + surface-hover fill + radio check). Chosen over the Segmented pill because five
  options each carry status metadata (default / installed / not installed) that pills cannot express.
- Option order: openrouter pinned first (API-backed default, absent from the harness catalog), then
  backend catalog order: pi, claude, codex, opencode.
- openrouter "installed" state = OpenRouter API key presence ("default · key stored" / "default · key
  missing").
- Uninstalled harnesses: visible, opacity-reduced, cursor-not-allowed, "not installed" tag, no hover
  accent, not selectable.
- Models: enabled only for openrouter; any harness selection disables the three ConfigFields (input
  disabled, Save replaced by a mono "openrouter only" hint tag) and adds the same hint to the Models
  group header. Fields stay visible so the lock is discoverable.
- Key-missing warning: existing amber line with dot (status never color alone), shown only when
  runtime = openrouter and the key is missing.
