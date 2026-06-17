import type { AgentsDataSource } from "./agentsdatasource";
import type { AgentVM } from "./agentsviewmodel";

export const MOCK_AGENTS: AgentVM[] = [
    {
        id: "block:loom",
        name: "loom",
        task: "Fix duplicate-session race",
        state: "asking",
        model: "opus",
        blockedMs: 240_000,
        previousInfo: [
            { kind: "message", text: "The clone re-reads the source block by id, so a stale id slips through. I added a nil-guard returning a clean failResult." },
            { kind: "action", verb: "edited", target: "sessionmodel.go" },
            { kind: "action", verb: "wrote", target: "duplicate-session_test.go", note: "+2 tests" },
            { kind: "action", verb: "ran", target: "go test ./...", outcome: "ok" },
            { kind: "message", text: "While testing I noticed the source block can also be removed between the lookup and the clone — a second race the guard doesn't cover." },
        ],
        ask: { question: "Should I guard that second case too?", recommendation: "yes — cheap insurance" },
    },
    {
        id: "block:waveterm",
        name: "waveterm",
        task: "Migrate badges to tailwind",
        state: "asking",
        model: "opus",
        blockedMs: 60_000,
        previousInfo: [
            { kind: "message", text: "Migrated Badge.tsx; tests green. Old badge.css still imported by Toast, Pill, StatusDot." },
            { kind: "action", verb: "edited", target: "Badge.tsx" },
            { kind: "action", verb: "grep", target: "badge.css", note: "3 importers" },
        ],
        ask: { question: "Old badge.css — keep, delete, or deprecate?", options: ["Keep", "Delete", "Deprecate"] },
    },
    { id: "block:waveterm-2", name: "waveterm-2", task: "Add settings search", state: "working", model: "sonnet", activeMs: 120_000, activity: "go test ./pkg/wconfig/…" },
    { id: "block:obsidian", name: "obsidian", task: "Daily note backlinks", state: "working", model: "sonnet", activeMs: 45_000, activity: "editing daily-note.ts" },
    { id: "block:obsidian-2", name: "obsidian-2", task: "Cleanup", state: "idle", model: "sonnet", activity: "stopped without asking · 12m" },
];

export class MockAgentsDataSource implements AgentsDataSource {
    getAgents(): AgentVM[] {
        return MOCK_AGENTS;
    }

    answer(agentId: string, answer: string): void {
        // Plan 3 routes this back through the ask_human elicitation result.
        console.log(`[agents] answer for ${agentId}: ${answer}`);
    }
}
