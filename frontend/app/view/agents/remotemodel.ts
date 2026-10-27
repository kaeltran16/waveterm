// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What Settings > Remote and the app bar's Remote on pill show for a remote mode status. Pure; the atom and
// the RPCs are in remotestore.ts. null is "not loaded yet".

export const REMOTE_SETUP_NOTE = "Run wsh remote setup first";
// the line pkg/remotemode prints when cloudflared is not found
export const REMOTE_CLOUDFLARED_NOTE = "Install cloudflared first: winget install --id Cloudflare.cloudflared";

export type RemoteSwitch = { enabled: boolean; on: boolean; note: string | null };

export type RemoteStatusLine = { id: "setup" | "tunnel" | "address" | "phone"; text: string; error?: boolean };

// the stored config's field names (Config.Missing), as the setup flags name them
const MISSING_LABEL: Record<string, string> = {
    tunneltoken: "tunnel token",
    team: "team",
    aud: "audience tag",
    email: "email",
    hostname: "hostname",
};

const TUNNEL_LABEL: Record<string, string> = {
    off: "Tunnel off",
    starting: "Tunnel starting…",
    up: "Tunnel up",
    down: "Tunnel down",
};

// While on, the switch always turns off, whatever the setup says: off must never be out of reach.
export function remoteSwitch(status: RemoteStatusData | null): RemoteSwitch {
    if (status == null) {
        return { enabled: false, on: false, note: null };
    }
    if (status.on) {
        return { enabled: true, on: true, note: null };
    }
    if ((status.missing?.length ?? 0) > 0) {
        return { enabled: false, on: false, note: REMOTE_SETUP_NOTE };
    }
    if (status.cloudflaredmissing) {
        return { enabled: false, on: false, note: REMOTE_CLOUDFLARED_NOTE };
    }
    return { enabled: true, on: false, note: null };
}

export function remoteStatusLines(status: RemoteStatusData | null): RemoteStatusLine[] {
    if (status == null) {
        return [];
    }
    const missing = status.missing ?? [];
    const lines: RemoteStatusLine[] = [
        {
            id: "setup",
            text:
                missing.length === 0
                    ? "Setup complete"
                    : `Setup incomplete, missing ${missing.map((m) => MISSING_LABEL[m] ?? m).join(", ")}`,
        },
    ];
    const tunnel = TUNNEL_LABEL[status.tunnel] ?? `Tunnel ${status.tunnel}`;
    lines.push({
        id: "tunnel",
        text: status.tunnelerror ? `${tunnel}: ${status.tunnelerror}` : tunnel,
        error: status.tunnelerror ? true : undefined,
    });
    if (status.hostname) {
        lines.push({ id: "address", text: `https://${status.hostname}` });
    }
    const n = status.subscriptions ?? 0;
    lines.push({
        id: "phone",
        text: n === 0 ? "No phone subscribed yet" : n === 1 ? "Phone subscribed" : `${n} phones subscribed`,
    });
    return lines;
}

export function showRemotePill(status: RemoteStatusData | null): boolean {
    return status?.on === true;
}
