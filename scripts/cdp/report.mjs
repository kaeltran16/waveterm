// Pure result formatting for the verification runner. No CDP/DOM/browser deps, so it is unit-testable
// without a live app. A scenario result is { name, steps: [{ step, ok, detail? }], error? }.

export function exitCode(scenarioResults) {
    const allPass = scenarioResults.every((s) => !s.error && s.steps.every((st) => st.ok));
    return allPass ? 0 : 1;
}

export function formatResults(scenarioResults) {
    const lines = [];
    let pass = 0;
    let total = 0;
    for (const s of scenarioResults) {
        lines.push(`\n# ${s.name}`);
        if (s.error) lines.push(`  ERROR: ${s.error}`);
        for (const st of s.steps) {
            total++;
            if (st.ok) pass++;
            lines.push(`  ${st.ok ? "PASS" : "FAIL"}  ${st.step}`);
            if (st.detail) lines.push(`        ${st.detail}`);
        }
    }
    lines.push(`\n${pass}/${total} steps passed`);
    return lines.join("\n");
}

export function contactSheetHtml(entries) {
    // entries: [{ name, png }] where png is a path relative to the html file (same dir).
    const cards = entries
        .map((e) => `<figure><figcaption>${e.name}</figcaption><img src="${e.png}" alt="${e.name}"></figure>`)
        .join("\n");
    return `<!doctype html><meta charset="utf-8"><title>verify contact sheet</title>
<style>body{background:#111;color:#eee;font:13px system-ui;margin:16px}
figure{margin:0 0 24px}figcaption{margin-bottom:6px;color:#9ab}
img{max-width:100%;border:1px solid #333}</style>
${cards}`;
}
