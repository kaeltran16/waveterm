// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func CreateRadarReport(ctx context.Context, projectName, projectPath string) (*waveobj.RadarReport, error) {
	rpt := &waveobj.RadarReport{
		OID:         uuid.NewString(),
		ProjectName: projectName,
		ProjectPath: projectPath,
		Status:      "collecting",
		Phase:       "collecting",
		StartedTs:   time.Now().UnixMilli(),
		Coverage:    make(map[string]string),
		Meta:        make(waveobj.MetaMapType),
	}
	if err := DBInsert(ctx, rpt); err != nil {
		return nil, err
	}
	return rpt, nil
}

func GetRadarReport(ctx context.Context, reportId string) (*waveobj.RadarReport, error) {
	return DBMustGet[*waveobj.RadarReport](ctx, reportId)
}

// GetRadarReports returns reports for projectPath (all reports when projectPath == ""), newest-first.
func GetRadarReports(ctx context.Context, projectPath string) ([]*waveobj.RadarReport, error) {
	all, err := DBGetAllObjsByType[*waveobj.RadarReport](ctx, waveobj.OType_RadarReport)
	if err != nil {
		return nil, err
	}
	var out []*waveobj.RadarReport
	for _, r := range all {
		if projectPath == "" || r.ProjectPath == projectPath {
			out = append(out, r)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartedTs > out[j].StartedTs })
	return out, nil
}

func UpdateRadarReport(ctx context.Context, reportId string, fn func(*waveobj.RadarReport)) error {
	return DBUpdateFn(ctx, reportId, fn)
}

func DeleteRadarReport(ctx context.Context, reportId string) error {
	return DBDelete(ctx, waveobj.OType_RadarReport, reportId)
}
