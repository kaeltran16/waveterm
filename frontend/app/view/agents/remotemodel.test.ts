// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    REMOTE_CLOUDFLARED_NOTE,
    REMOTE_SETUP_NOTE,
    remoteStatusLines,
    remoteSwitch,
    showRemotePill,
} from "./remotemodel";

const UNSET: RemoteStatusData = {
    on: false,
    missing: ["tunneltoken", "team", "aud", "email", "hostname"],
    tunnel: "off",
    subscriptions: 0,
};
const OFF: RemoteStatusData = { on: false, hostname: "arc.example.com", port: 8765, tunnel: "off", subscriptions: 0 };
const UP: RemoteStatusData = { ...OFF, on: true, tunnel: "up", subscriptions: 1 };
const DOWN: RemoteStatusData = { ...UP, tunnel: "down", tunnelerror: "connection refused" };
const NO_CLOUDFLARED: RemoteStatusData = { ...OFF, cloudflaredmissing: true };

const texts = (s: RemoteStatusData | null) => remoteStatusLines(s).map((l) => l.text);

describe("remoteSwitch", () => {
    it("is disabled with no note before the status loads", () => {
        expect(remoteSwitch(null)).toEqual({ enabled: false, on: false, note: null });
    });

    it("is disabled and points at setup while setup is missing", () => {
        expect(remoteSwitch(UNSET)).toEqual({ enabled: false, on: false, note: REMOTE_SETUP_NOTE });
    });

    it("names setup before cloudflared when both are missing", () => {
        expect(remoteSwitch({ ...UNSET, cloudflaredmissing: true }).note).toBe(REMOTE_SETUP_NOTE);
    });

    it("is disabled with the winget line while cloudflared is missing", () => {
        expect(remoteSwitch(NO_CLOUDFLARED)).toEqual({ enabled: false, on: false, note: REMOTE_CLOUDFLARED_NOTE });
        expect(REMOTE_CLOUDFLARED_NOTE).toContain("winget install --id Cloudflare.cloudflared");
    });

    it("is enabled and off once set up", () => {
        expect(remoteSwitch(OFF)).toEqual({ enabled: true, on: false, note: null });
    });

    it("is enabled and on while on, tunnel up or down", () => {
        expect(remoteSwitch(UP)).toEqual({ enabled: true, on: true, note: null });
        expect(remoteSwitch(DOWN)).toEqual({ enabled: true, on: true, note: null });
    });

    it("can still turn off when cloudflared went missing while on", () => {
        expect(remoteSwitch({ ...DOWN, cloudflaredmissing: true })).toEqual({ enabled: true, on: true, note: null });
    });
});

describe("remoteStatusLines", () => {
    it("is empty before the status loads", () => {
        expect(remoteStatusLines(null)).toEqual([]);
    });

    it("names every missing setup field, with no address", () => {
        expect(texts(UNSET)).toEqual([
            "Setup incomplete, missing tunnel token, team, audience tag, email, hostname",
            "Tunnel off",
            "No phone subscribed yet",
        ]);
    });

    it("shows setup complete, the address and no phone when set but off", () => {
        expect(texts(OFF)).toEqual([
            "Setup complete",
            "Tunnel off",
            "https://arc.example.com",
            "No phone subscribed yet",
        ]);
    });

    it("shows the tunnel up and the phone subscribed when on", () => {
        expect(texts(UP)).toEqual(["Setup complete", "Tunnel up", "https://arc.example.com", "Phone subscribed"]);
        expect(remoteStatusLines(UP).some((l) => l.error)).toBe(false);
    });

    it("marks the down line with its error", () => {
        const tunnel = remoteStatusLines(DOWN).find((l) => l.id === "tunnel");
        expect(tunnel).toEqual({ id: "tunnel", text: "Tunnel down: connection refused", error: true });
    });

    it("counts more than one phone", () => {
        expect(texts({ ...UP, subscriptions: 3 })).toContain("3 phones subscribed");
    });
});

describe("showRemotePill", () => {
    it("shows only while on", () => {
        expect(showRemotePill(null)).toBe(false);
        expect(showRemotePill(UNSET)).toBe(false);
        expect(showRemotePill(OFF)).toBe(false);
        expect(showRemotePill(NO_CLOUDFLARED)).toBe(false);
        expect(showRemotePill(UP)).toBe(true);
        expect(showRemotePill(DOWN)).toBe(true);
    });
});
