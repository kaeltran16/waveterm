import type { AgentVM } from "./agentsviewmodel";

// The seam between the Agents view and where agent data comes from.
// Plan 1 provides MockAgentsDataSource; Plan 2 supplies real previous-info
// (transcript projection) and Plan 3 supplies real asks + answer routing (ask_human).
export interface AgentsDataSource {
    getAgents(): AgentVM[];
    answer(agentId: string, answer: string): void;
}
