// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const remoteTestToken = "eyJhIjoic2VjcmV0LXRva2VuIn0="

func TestRemoteStatusText(t *testing.T) {
	cases := []struct {
		name string
		st   wshrpc.RemoteStatusData
		want string
	}{
		{
			name: "off and unset",
			st: wshrpc.RemoteStatusData{
				Tunnel:  "off",
				Missing: []string{"tunneltoken", "team", "aud", "email", "hostname"},
			},
			want: "Remote mode: off\n" +
				"Tunnel: off\n" +
				"Phone: not subscribed yet\n" +
				"Setup: missing tunneltoken, team, aud, email, hostname, run wsh remote setup\n",
		},
		{
			name: "on and up",
			st: wshrpc.RemoteStatusData{
				On: true, Hostname: "arc.example.com", Port: 47821, Tunnel: "up", Subscriptions: 2,
			},
			want: "Remote mode: on\n" +
				"Address: https://arc.example.com\n" +
				"Local port: 47821\n" +
				"Tunnel: up\n" +
				"Phone: subscribed (2)\n" +
				"Setup: complete\n",
		},
		{
			name: "down with error",
			st: wshrpc.RemoteStatusData{
				On: true, Hostname: "arc.example.com", Port: 47821, Tunnel: "down", TunnelError: "cloudflared exited: exit status 1",
			},
			want: "Remote mode: on\n" +
				"Address: https://arc.example.com\n" +
				"Local port: 47821\n" +
				"Tunnel: down (cloudflared exited: exit status 1)\n" +
				"Phone: not subscribed yet\n" +
				"Setup: complete\n",
		},
		{
			name: "cloudflared missing",
			st:   wshrpc.RemoteStatusData{Tunnel: "off", Hostname: "arc.example.com", Port: 47821, CloudflaredMissing: true},
			want: "Remote mode: off\n" +
				"Address: https://arc.example.com\n" +
				"Local port: 47821\n" +
				"Tunnel: off\n" +
				"Phone: not subscribed yet\n" +
				"Setup: complete\n" +
				"cloudflared not found: winget install --id Cloudflare.cloudflared\n",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := remoteStatusText(&c.st)
			if got != c.want {
				t.Errorf("status text:\n got: %q\nwant: %q", got, c.want)
			}
			if strings.Contains(got, remoteTestToken) {
				t.Errorf("status text contains the token")
			}
		})
	}
}

func TestReadTunnelToken(t *testing.T) {
	cases := []struct {
		name, in, want string
		wantErr        bool
	}{
		{name: "trims", in: "  " + remoteTestToken + " \r\n", want: remoteTestToken},
		{name: "skips blank lines", in: "\n \t\n" + remoteTestToken + "\nnext\n", want: remoteTestToken},
		{name: "no trailing newline", in: remoteTestToken, want: remoteTestToken},
		{name: "empty", in: "", wantErr: true},
		{name: "only blanks", in: "\n  \n\t\n", wantErr: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := readTunnelToken(strings.NewReader(c.in), false)
			if c.wantErr {
				if err == nil {
					t.Fatalf("want an error, got %q", got)
				}
				return
			}
			if err != nil || got != c.want {
				t.Errorf("got %q, %v; want %q", got, err, c.want)
			}
		})
	}
}
