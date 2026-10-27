// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package remotemode

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	remoteMinPort = 1024
	remoteMaxPort = 65535

	remoteTunnelOff = "off"
)

// the team becomes the host of the certs url, so anything but a bare team name could aim that fetch
// at another host
var remoteTeamRe = regexp.MustCompile(`^[A-Za-z0-9-]+$`)

// remoteFindCloudflared is a var so tests can fake a missing cloudflared.
var remoteFindCloudflared = FindCloudflared

// remoteSetupMu serializes Setup's read-modify-write of the stored config.
var remoteSetupMu sync.Mutex

// Setup stores what the owner gives it; a field left empty keeps its stored value, so one flag can be
// changed alone. The VAPID pair is generated only when none is stored and subscriptions are kept, so a
// re-setup does not orphan a phone that already subscribed.
func Setup(data wshrpc.CommandRemoteSetupData) (*wshrpc.RemoteStatusData, error) {
	if err := remoteValidateSetup(data); err != nil {
		return nil, err
	}
	remoteSetupMu.Lock()
	cfg, err := LoadConfig()
	if err != nil {
		remoteSetupMu.Unlock()
		return nil, err
	}
	remoteApplySetup(&cfg, data)
	if cfg.VapidPrivate == "" || cfg.VapidPublic == "" {
		cfg.VapidPrivate, cfg.VapidPublic, err = remoteNewVapidPair()
		if err != nil {
			remoteSetupMu.Unlock()
			return nil, err
		}
	}
	err = SaveConfig(cfg)
	remoteSetupMu.Unlock()
	if err != nil {
		return nil, err
	}
	publishStatus()
	return Status(), nil
}

func remoteValidateSetup(data wshrpc.CommandRemoteSetupData) error {
	if team := strings.TrimSpace(data.Team); team != "" && !remoteTeamRe.MatchString(team) {
		return fmt.Errorf("team must be the bare team name, e.g. \"acme\" for acme.cloudflareaccess.com")
	}
	if host := strings.TrimSpace(data.Hostname); strings.ContainsAny(host, "/:?#@ ") {
		return fmt.Errorf("hostname must be a bare host name with no scheme, port or path, e.g. \"arc.example.com\"")
	}
	if email := strings.TrimSpace(data.Email); email != "" && !strings.Contains(email, "@") {
		return fmt.Errorf("email must be an address containing @")
	}
	if p := data.Port; p != 0 && (p < remoteMinPort || p > remoteMaxPort) {
		return fmt.Errorf("port must be %d-%d, or 0 for the default (%d)", remoteMinPort, remoteMaxPort, DefaultPort)
	}
	return nil
}

func remoteApplySetup(cfg *Config, data wshrpc.CommandRemoteSetupData) {
	set := func(dst *string, v string) {
		if v = strings.TrimSpace(v); v != "" {
			*dst = v
		}
	}
	set(&cfg.TunnelToken, data.TunnelToken)
	set(&cfg.Team, data.Team)
	set(&cfg.Aud, data.Aud)
	set(&cfg.Email, data.Email)
	set(&cfg.Hostname, strings.ToLower(data.Hostname))
	switch {
	case data.Port != 0:
		cfg.Port = data.Port
	case cfg.Port == 0:
		cfg.Port = DefaultPort
	}
}

func remoteNewVapidPair() (private, public string, err error) {
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("generate vapid key: %w", err)
	}
	enc := base64.RawURLEncoding
	return enc.EncodeToString(key.Bytes()), enc.EncodeToString(key.PublicKey().Bytes()), nil
}

// Status never carries the tunnel token.
func Status() *wshrpc.RemoteStatusData {
	cfg, err := LoadConfig()
	st := &wshrpc.RemoteStatusData{Tunnel: remoteTunnelOff}
	if err != nil {
		st.TunnelError = err.Error()
		return st
	}
	st.On = cfg.On
	st.Missing = cfg.Missing()
	st.Hostname = cfg.Hostname
	st.Port = cfg.Port
	st.Subscriptions = len(cfg.Subscriptions)
	_, findErr := remoteFindCloudflared()
	st.CloudflaredMissing = findErr != nil
	return st
}

var errRemoteNotBuilt = errors.New("remote mode is not built yet")

func On() (*wshrpc.RemoteStatusData, error) {
	return nil, errRemoteNotBuilt
}

func Off() (*wshrpc.RemoteStatusData, error) {
	return nil, errRemoteNotBuilt
}

func publishStatus() {
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_RemoteStatus, Data: Status()})
}
