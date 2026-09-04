// pi extension: wave_* tools (pi drives arc), notification bridge (B3), and the control
// channel watcher (arc steers pi). Installed by `wsh install-agent-hooks` into
// ~/.pi/agent/extensions/waveterm-tools.ts with __WSH_PATH__ substituted for the absolute wsh
// path. Bare pi outside a Wave block is inert: the tools fail closed with a clear error, the
// watcher needs WAVETERM_PI_CONTROL_DIR.
import { existsSync, readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
    captureTailArgs,
    controlAckArgs,
    controlFileName,
    dagEventMessage,
    makeSerialChain,
    notifyArgs,
    openFileArgs,
    parseControlCommand,
    querySessionsArgs,
    runCommandArgs,
    vaultAskArgs,
    type PiControlCommand,
} from "./waveterm-tools-core";

export function registerWavetermTools(pi: any, wshPath: string): void {
    const wsh = async (args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
        try {
            const { stdout } = await pi.exec(wshPath, args);
            return { ok: true, stdout, stderr: "" };
        } catch (e) {
            return { ok: false, stdout: "", stderr: String(e) };
        }
    };

    // --- B1: wave_* tools --------------------------------------------------

    pi.registerTool({
        name: "wave_run_command",
        label: "Run Command in Wave",
        description: "Run a command visibly in a new Wave tab and return the command's block id.",
        promptSnippet: "Run a command visibly in a Wave tab",
        promptGuidelines: ["Use wave_run_command when the user wants a command run and visible in Wave."],
        parameters: Type.Object({
            command: Type.String({ description: "Full command line to run (shell string)" }),
            cwd: Type.Optional(Type.String({ description: "Working directory for the command" })),
            capture: Type.Optional(Type.Boolean({ description: "Also return a truncated tail of the output" })),
        }),
        async execute(_toolCallId: string, params: any): Promise<unknown> {
            const r = await wsh(runCommandArgs(params.command, params.cwd));
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_run_command failed: ${r.stderr}` }], details: {} };
            }
            let text = r.stdout.trim();
            if (params.capture) {
                const blockId = (r.stdout.match(/block\s+(\S+)/i)?.[1] ?? "").trim();
                if (blockId) {
                    const tail = await wsh(captureTailArgs(blockId));
                    text += `\n\nTail:\n${tail.ok ? tail.stdout.slice(-4000) : tail.stderr}`;
                }
            }
            return { content: [{ type: "text", text }], details: {} };
        },
    });

    pi.registerTool({
        name: "wave_open_file",
        label: "Open File in Wave",
        description: "Open an existing file in a Wave tab.",
        promptSnippet: "Open a file in a Wave tab",
        promptGuidelines: ["Use wave_open_file when the user wants a file opened in Wave."],
        parameters: Type.Object({
            path: Type.String({ description: "Absolute path to the file to open" }),
        }),
        async execute(_toolCallId: string, params: any): Promise<unknown> {
            const r = await wsh(openFileArgs(params.path));
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_open_file failed: ${r.stderr}` }], details: {} };
            }
            return { content: [{ type: "text", text: r.stdout.trim() }], details: {} };
        },
    });

    // --- Axis 1: wave_vault_ask — read past work from the work ledger ---------------------

    pi.registerTool({
        name: "wave_vault_ask",
        label: "Ask the Wave Work Ledger",
        description:
            "Ask a stateless question about past work, decisions, or project state (status, history, what happened while away). " +
            "Advisory: verify or cite the returned sources before treating the answer as ground truth.",
        promptSnippet: "Ask the Wave work ledger about past work",
        promptGuidelines: [
            "Use wave_vault_ask when the user asks about past work, decisions, or project state.",
            "This reads the past; the ask mirror (ask_user_question) asks the user a live question — do not conflate them.",
        ],
        parameters: Type.Object({
            question: Type.String({ description: "The question to answer from the work ledger" }),
            cwd: Type.Optional(Type.String({ description: "Project directory to scope the question to" })),
        }),
        async execute(_toolCallId: string, params: any): Promise<unknown> {
            const r = await wsh(vaultAskArgs(params.question, params.cwd));
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_vault_ask failed: ${r.stderr}` }], details: {} };
            }
            let parsed: { answer?: string; sources?: { oref?: string; title?: string }[] } = {};
            try {
                parsed = JSON.parse(r.stdout);
            } catch {
                // fall through to the raw output below
            }
            const text = parsed.answer ?? r.stdout.trim();
            const sources = (parsed.sources ?? []).map((s) => `${s.oref} ${s.title ?? ""}`.trim());
            const content = sources.length ? `${text}\n\nSources:\n${sources.map((s) => `  ${s}`).join("\n")}` : text;
            return { content: [{ type: "text", text: content }], details: { sources: parsed.sources ?? [] } };
        },
    });

    pi.registerTool({
        name: "wave_query_sessions",
        label: "Query Wave Sessions",
        description: "List open Wave blocks (terminal and edit views) as JSON so the model can reference them.",
        promptSnippet: "List open Wave tabs/blocks",
        promptGuidelines: ["Use wave_query_sessions to list open Wave tabs before referencing one."],
        parameters: Type.Object({}),
        async execute(): Promise<unknown> {
            const r = await wsh(querySessionsArgs());
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_query_sessions failed: ${r.stderr}` }], details: {} };
            }
            return { content: [{ type: "text", text: r.stdout.slice(-8000) }], details: {} };
        },
    });

    pi.registerTool({
        name: "wave_notify",
        label: "Notify in Wave",
        description: "Send a Wave notification (title required; optional message and level).",
        promptSnippet: "Send a Wave notification",
        promptGuidelines: ["Use wave_notify to send a short notification into Wave."],
        parameters: Type.Object({
            title: Type.String({ description: "Notification title" }),
            message: Type.Optional(Type.String({ description: "Optional message body" })),
            level: Type.Optional(Type.String({ description: "info, warn, or error (default info)" })),
        }),
        async execute(_toolCallId: string, params: any): Promise<unknown> {
            const r = await wsh(notifyArgs(params.title, { message: params.message, level: params.level }));
            if (!r.ok) {
                return { content: [{ type: "text", text: `wave_notify failed: ${r.stderr}` }], details: {} };
            }
            return { content: [{ type: "text", text: "Notification sent." }], details: {} };
        },
    });

    // --- B3: notification bridge (event → wsh notify) ----------------------

    const notify = async (title: string, opts: { message?: string; level?: string }): Promise<void> => {
        try {
            await wsh(notifyArgs(title, opts));
        } catch {
            // best-effort: a failed notify never breaks the session
        }
    };

    pi.on("agent_settled", async (event: any, ctx: any) => {
        // The settled-payload error signal is confirmed during Task 8's live round-trip; the
        // predicate below covers the documented error carriers (event.error / ctx.lastError).
        if (event?.error || ctx?.lastError) {
            await notify("Pi session ended with an error", { level: "error" });
        }
    });

    // --- B2: control channel watcher ---------------------------------------

    // makeDispatcher maps a parsed command file onto pi/ctx APIs. ctx is the session ctx from
    // the enclosing session_start; the ctx-dependent commands (compact/abort/new_session/
    // switch_session) use it, per the spec's session-replacement notes.
    // ackControl confirms a dispatched engine control event back to the server. Best-effort: a failed
    // acknowledgement leaves the attempt "unconfirmed" in the cockpit, which is the honest state — it
    // must never block or undo the command the lead already acted on.
    const ackControl = async (cmd: PiControlCommand, log: (m: string) => void): Promise<void> => {
        const args = controlAckArgs(cmd);
        if (!args) return; // not an engine control event (no envelope) — nothing to confirm
        const r = await wsh(args);
        if (!r.ok) log(`pi-control: ack for ${cmd.eventid} failed: ${r.stderr}`);
    };

    // makeDispatcher returns whether the command was accepted, so only a real dispatch is
    // acknowledged — a command that threw must not be reported to the cockpit as received.
    const makeDispatcher = (ctx: any, log: (m: string) => void) => {
        return async (cmd: PiControlCommand): Promise<boolean> => {
            try {
                switch (cmd.cmd) {
                    case "steer":
                        await pi.sendUserMessage(cmd.content, { deliverAs: "steer" });
                        break;
                    case "follow_up":
                        await pi.sendUserMessage(cmd.content, { deliverAs: "followUp" });
                        break;
                    case "set_session_name":
                        if (cmd.name) pi.setSessionName(cmd.name);
                        break;
                    case "compact":
                        ctx.compact({ customInstructions: cmd.content || undefined });
                        break;
                    case "abort":
                        if (typeof ctx.abort === "function") ctx.abort();
                        break;
                    case "new_session":
                        await ctx.newSession({ withSession: async () => {} });
                        break;
                    case "switch_session":
                        if (!cmd.path) {
                            log("pi-control: switch_session requires a session path");
                            break;
                        }
                        await ctx.switchSession(cmd.path, { withSession: async () => {} });
                        break;
                    case "child_done":
                    case "gate_open":
                    case "dag_blocked":
                    case "dag_complete":
                    case "child_ask":
                    case "child_stalled":
                        await notify(dagEventMessage(cmd.cmd, cmd.content));
                        break;
                }
                return true;
            } catch (e) {
                log(`pi-control: command ${cmd.cmd} failed: ${String(e)}`);
                await notify(`Pi control command failed: ${cmd.cmd}`, { level: "error" });
                return false;
            }
        };
    };

    // startControlWatcher watches dir for <sessionId>.json, executes each parsed command, and
    // deletes the file when processing finishes (idempotent; a wedged command cannot replay).
    // fs.watch with a polling fallback when the platform/dir cannot watch.
    const startControlWatcher = (
        dir: string,
        sessionId: string,
        onCommand: (cmd: PiControlCommand) => Promise<boolean>,
        log: (m: string) => void
    ): (() => void) => {
        const file = join(dir, controlFileName(sessionId));
        const process = async (): Promise<void> => {
            if (!existsSync(file)) return;
            let cmd: PiControlCommand | null = null;
            try {
                cmd = parseControlCommand(readFileSync(file, "utf8"));
            } catch {
                log(`pi-control: unreadable control file ${file}`);
            }
            if (!cmd) {
                log(`pi-control: ignoring malformed or unknown command in ${file}`);
                rmSync(file, { force: true });
                return;
            }
            try {
                if (await onCommand(cmd)) {
                    await ackControl(cmd, log);
                }
            } finally {
                rmSync(file, { force: true });
            }
        };
        let watcher: ReturnType<typeof watch> | null = null;
        let poll: ReturnType<typeof setInterval> | null = null;
        // fs.watch coalesces but does not serialize: two callbacks can fire before the first
        // process() resolves, and all commands share one control file — concurrent runs could rm a
        // file the other is about to read or dispatch a stale generation. One chain keeps the
        // read-parse-dispatch-delete sequence atomic per command event.
        const enqueue = makeSerialChain(process, (e) => log(`pi-control: processing failed: ${String(e)}`));
        try {
            watcher = watch(dir, (_eventType, filename) => {
                if (filename === controlFileName(sessionId)) enqueue();
            });
        } catch {
            poll = setInterval(enqueue, 1000);
        }
        return () => {
            watcher?.close();
            if (poll) clearInterval(poll);
        };
    };

    let cleanup: (() => void) | undefined;

    pi.on("session_start", (_event: any, ctx: any) => {
        cleanup?.();
        const dir = process.env.WAVETERM_PI_CONTROL_DIR;
        const sessionId = ctx?.sessionManager?.getSessionId?.();
        if (!dir || !sessionId) return; // bare pi outside a Wave block — inert
        cleanup = startControlWatcher(
            dir,
            sessionId,
            makeDispatcher(ctx, (m) => console.log(m)),
            (m) => console.log(m)
        );
    });

    pi.on("session_shutdown", () => {
        cleanup?.();
        cleanup = undefined;
    });
}

export default function wavetermTools(pi: any): void {
    registerWavetermTools(pi, "__WSH_PATH__");
}
