// opencode plugin reporting a running session into the Wave cockpit.
// Installed by `wsh install-agent-hooks` into ~/.config/opencode/plugins/waveterm-status.js with
// __WSH_PATH__ substituted for the absolute wsh path. opencode auto-loads files in that directory
// (docs verified 2026-08-07); the config `plugin` array is npm-only and is not touched.
// A bare opencode outside a Wave block is fully inert: nothing runs without WAVETERM_BLOCKID + JWT.

import { appendFileSync, mkdirSync } from "node:fs";

const WSH = __WSH_PATH__;
const SHADOW_DIR = "waveterm";

const stateBySession = new Map();
const rolesByMessage = new Map();
const lastTextByPart = new Map();

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function shadowPath(sessionID) {
  return homeDir() + "/.local/share/opencode/" + SHADOW_DIR + "/" + sessionID + ".jsonl";
}

function appendLine(sessionID, line) {
  if (!sessionID) return;
  try {
    const p = shadowPath(sessionID);
    mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    appendFileSync(p, JSON.stringify(line) + "\n");
  } catch (_) {}
}

function report(sessionID, state) {
  if (!sessionID || stateBySession.get(sessionID) === state) return;
  stateBySession.set(sessionID, state);
  appendLine(sessionID, { type: "state", state, ts: Date.now() });
  if (!process.env.WAVETERM_BLOCKID || !process.env.WAVETERM_JWT) return;
  try {
    Bun.spawn([WSH, "agent-hook", "--agent", "opencode", "--shadow", shadowPath(sessionID), "--state", state], {
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (_) {}
}

export const WaveStatusPlugin = async () => {
  return {
    event: async ({ event }) => {
      if (!process.env.WAVETERM_BLOCKID || !process.env.WAVETERM_JWT) return;
      const p = event.properties || {};

      if (event.type === "session.updated" && p.info && p.info.id) {
        appendLine(p.info.id, {
          type: "session",
          id: p.info.id,
          title: typeof p.info.title === "string" ? p.info.title : "",
          ts: Date.now(),
        });
        return;
      }
      if (event.type === "message.updated" && p.info && p.info.role) {
        rolesByMessage.set(p.info.id, p.info.role);
        if (p.info.role === "assistant" && p.info.modelID) {
          appendLine(p.info.sessionID, {
            type: "session",
            id: p.info.sessionID,
            model: (p.info.providerID || "") + "/" + p.info.modelID,
            ts: Date.now(),
          });
          report(p.info.sessionID, "working");
        }
        return;
      }
      if (event.type === "message.part.updated" && p.part) {
        const part = p.part || {};
        const sessionID = part.sessionID;
        if (!sessionID) return;
        if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
          const role = rolesByMessage.get(part.messageID) || "assistant";
          const prev = lastTextByPart.get(part.id) || "";
          const delta = part.text.startsWith(prev) ? part.text.slice(prev.length) : part.text;
          if (delta.trim() !== "") {
            appendLine(sessionID, { type: role, text: delta, ts: Date.now() });
            lastTextByPart.set(part.id, part.text);
          }
          report(sessionID, "working");
          return;
        }
        if (part.type === "tool" && typeof part.tool === "string") {
          const st = part.state || {};
          const input = st.input || {};
          appendLine(sessionID, {
            type: "tool",
            name: part.tool,
            state: st.status || "running",
            input: typeof input.command === "string" ? input.command : "",
            ts: Date.now(),
          });
          report(sessionID, "working");
          return;
        }
        return;
      }
      if (event.type === "permission.asked" && p.sessionID) {
        report(p.sessionID, "waiting");
        return;
      }
      if (event.type === "session.idle" && p.sessionID) {
        report(p.sessionID, "idle");
        return;
      }
      if (event.type === "session.error" && p.sessionID) {
        report(p.sessionID, "idle");
        return;
      }
    },
  };
};
