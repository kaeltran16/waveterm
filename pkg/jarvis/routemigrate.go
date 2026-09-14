// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MetaKey_TierPinsMigrated marks, on the MainServer singleton, that saved tier pins were rewritten to models.
const MetaKey_TierPinsMigrated = "jarvis:tierpinsmigrated"

// the setting was deleted with tiers; only this pass still names it
const settingsKeyPreferredTier = "harness:preferredtier"

// MigrateTierPins rewrites every saved route pin that still names a tier, once per data dir. Every
// step is idempotent, so a pass that fails part way is simply run again on the next boot.
func MigrateTierPins(ctx context.Context) error {
	done, err := wstore.SingletonMetaBool(ctx, MetaKey_TierPinsMigrated)
	if err != nil || done {
		return err
	}
	if err := migrateTierPinsOnce(ctx); err != nil {
		return err
	}
	return wstore.MarkSingletonMetaBool(ctx, MetaKey_TierPinsMigrated)
}

func migrateTierPinsOnce(ctx context.Context) error {
	if err := migratePreferredTier(); err != nil {
		return fmt.Errorf("migrating %s: %w", settingsKeyPreferredTier, err)
	}
	if err := migrateGlobalProfilePins(); err != nil {
		return fmt.Errorf("migrating the global profile worker route: %w", err)
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return fmt.Errorf("listing channels: %w", err)
	}
	if err := migrateChannelPins(ctx, channels); err != nil {
		return err
	}
	if err := migrateRunPins(ctx, channels); err != nil {
		return err
	}
	return migrateDagPins(ctx)
}

// migratePin rewrites a stored pin in place and reports whether it changed.
func migratePin(pin *waveobj.RoutePin) bool {
	if pin == nil {
		return false
	}
	next, changed := runroute.MigrateTierPin(*pin)
	*pin = next
	return changed
}

func migratePreferredTier() error {
	m, cerrs := wconfig.ReadWaveHomeConfigFile(wconfig.SettingsFile)
	if len(cerrs) > 0 {
		return fmt.Errorf("reading %s: %v", wconfig.SettingsFile, cerrs[0])
	}
	rawTier, present := m[settingsKeyPreferredTier]
	if !present {
		return nil
	}
	tier, _ := rawTier.(string)
	runtime, _ := m[wconfig.ConfigKey_HarnessPreferredRuntime].(string)
	model, _ := m[wconfig.ConfigKey_HarnessPreferredModel].(string)
	pin, _ := runroute.MigrateTierPin(waveobj.RoutePin{Runtime: runtime, Model: model, Tier: tier})
	if pin.Model != "" {
		m[wconfig.ConfigKey_HarnessPreferredModel] = pin.Model
	}
	delete(m, settingsKeyPreferredTier)
	return wconfig.WriteWaveHomeConfigFile(wconfig.SettingsFile, m)
}

func migrateGlobalProfilePins() error {
	profile := LoadGlobalProfile()
	if !migratePin(profile.WorkerRoute) {
		return nil
	}
	return SaveGlobalProfile(profile)
}

func migrateChannelPins(ctx context.Context, channels []*waveobj.Channel) error {
	for _, ch := range channels {
		override := OverrideFromMeta(ch)
		if override == nil {
			continue
		}
		routeChanged := migratePin(override.Route)
		workerChanged := migratePin(override.WorkerRoute)
		if !routeChanged && !workerChanged {
			continue
		}
		if err := wstore.DBUpdateFn(ctx, ch.OID, func(c *waveobj.Channel) {
			// same encoding SetChannelProfileCommand writes
			c.Meta[MetaKey_JarvisProfile] = override
		}); err != nil {
			return fmt.Errorf("migrating channel %s profile route: %w", ch.OID, err)
		}
	}
	return nil
}

// runs are walked through the channel blob because it keeps its own copy of each run; UpdateRun
// rewrites that copy and the db_run row together.
func migrateRunPins(ctx context.Context, channels []*waveobj.Channel) error {
	for _, ch := range channels {
		for i := range ch.Runs {
			run := &ch.Runs[i]
			if !migratePin(run.WorkerRoute) {
				continue
			}
			route := *run.WorkerRoute
			if err := wstore.UpdateRun(ctx, ch.OID, run.ID, func(r *waveobj.Run) error {
				r.WorkerRoute = &route
				return nil
			}); err != nil {
				return fmt.Errorf("migrating run %s worker route: %w", run.ID, err)
			}
		}
	}
	return nil
}

func migrateDagPins(ctx context.Context) error {
	dags, err := wstore.DBGetAllObjsByType[*waveobj.TaskGroup](ctx, waveobj.OType_Dag)
	if err != nil {
		return fmt.Errorf("listing dags: %w", err)
	}
	for _, g := range dags {
		if !migratePin(g.WorkerRoute) {
			continue
		}
		route := *g.WorkerRoute
		if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
			cur.WorkerRoute = &route
			return nil
		}); err != nil {
			return fmt.Errorf("migrating dag %s worker route: %w", g.OID, err)
		}
	}
	return nil
}
