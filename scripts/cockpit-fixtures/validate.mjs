// Runtime shape check for fixture rosters. Shared by the scenario test and the generator so a
// malformed fixture can never be written/served. Mirrors the fields the cockpit grid relies on
// (frontend/app/view/agents/agentsviewmodel.ts: AgentVM). No type imports — plain runtime checks.

const STATES = new Set(["asking", "working", "idle"]);

export function validateScenario(records) {
    if (!Array.isArray(records)) {
        return { ok: false, errors: ["scenario is not an array"] };
    }
    const errors = [];
    const seen = new Set();
    records.forEach((r, i) => {
        const at = `[${i}]`;
        if (typeof r?.id !== "string" || r.id === "") {
            errors.push(`${at} id must be a non-empty string`);
        } else if (seen.has(r.id)) {
            errors.push(`${at} duplicate id ${r.id}`);
        } else {
            seen.add(r.id);
        }
        if (typeof r?.name !== "string" || r.name === "") {
            errors.push(`${at} name must be a non-empty string`);
        }
        if (!STATES.has(r?.state)) {
            errors.push(`${at} state must be asking|working|idle (got ${JSON.stringify(r?.state)})`);
        }
        // ask is optional even for asking agents (plain-text questions); validate shape only if present
        if (r?.ask !== undefined) {
            const qs = r.ask?.questions;
            if (!Array.isArray(qs) || qs.length === 0) {
                errors.push(`${at} ask.questions must be a non-empty array`);
            } else {
                qs.forEach((q, qi) => {
                    if (typeof q?.question !== "string" || q.question === "") {
                        errors.push(`${at}.questions[${qi}] question must be a non-empty string`);
                    }
                    if (q?.options !== undefined) {
                        if (!Array.isArray(q.options)) {
                            errors.push(`${at}.questions[${qi}] options must be an array`);
                        } else {
                            q.options.forEach((o, oi) => {
                                if (typeof o?.label !== "string" || o.label === "") {
                                    errors.push(`${at}.questions[${qi}].options[${oi}] label must be a non-empty string`);
                                }
                            });
                        }
                    }
                });
            }
        }
    });
    return { ok: errors.length === 0, errors };
}
