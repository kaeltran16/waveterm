// Pure builder for the pi control-channel call. The session id is the one the status
// extension reports via agentstatus --session-id and the cockpit stores on the agent record.
// PiControlCommandData is a global type from the generated gotypes.d.ts (wshrpc domain).

export function steerData(sessionId: string, content: string): PiControlCommandData {
    return { sessionid: sessionId, command: "steer", content: content.trim(), name: "", path: "" };
}
