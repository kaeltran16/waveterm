// pi extension wiring Wave's memory vault into pi sessions.
// Installed by `wsh install-agent-hooks` into ~/.pi/agent/extensions/waveterm-memory.ts with
// __WSH_PATH__ substituted for the absolute wsh path. pi auto-loads every file in that directory.
// A bare pi outside a Wave block is fully inert: both wsh commands no-op without WAVE_JWT_TOKEN.

export function registerWavetermMemory(pi: any, wshPath: string): void {
    const project = async (ctx: any) => {
        try {
            await pi.exec(wshPath, ["agent-memory-project", "--cwd", ctx.cwd ?? ""]);
        } catch { /* best-effort: outside WaveTerm the RPC is unreachable */ }
    };
    const enqueue = async (ctx: any) => {
        if (process.env.WAVETERM_MEMORY_DISTILL) return; // don't enqueue the distill sub-session
        const file = ctx.sessionManager?.getSessionFile?.() ?? "";
        if (!file) return; // ephemeral session (--no-session): nothing to distill
        try {
            await pi.exec(wshPath, ["agent-memory-hook", "--transcript", file, "--cwd", ctx.cwd ?? ""]);
        } catch { /* best-effort */ }
    };
    pi.on("session_start", (_event: any, ctx: any) => project(ctx));
    pi.on("session_shutdown", (_event: any, ctx: any) => enqueue(ctx));
}

export default function wavetermMemory(pi: any): void {
    registerWavetermMemory(pi, "__WSH_PATH__");
}
