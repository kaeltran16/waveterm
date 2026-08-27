// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jobcontroller

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func mkJob(oid string, status string, attached string) *waveobj.Job {
	return &waveobj.Job{OID: oid, JobManagerStatus: status, AttachedBlockId: attached}
}

func TestUnusedJobCandidates(t *testing.T) {
	tests := []struct {
		name string
		jobs []*waveobj.Job
		want []string
	}{
		{
			name: "done and unattached are candidates",
			jobs: []*waveobj.Job{
				mkJob("j1", JobManagerStatus_Done, ""),
				mkJob("j2", JobManagerStatus_Done, "block-2"),
				mkJob("j3", JobManagerStatus_Running, ""),
			},
			want: []string{"j1"},
		},
		{
			name: "done but still attached is not a candidate",
			jobs: []*waveobj.Job{mkJob("j1", JobManagerStatus_Done, "block-1")},
			want: []string{},
		},
		{
			name: "live job is not a candidate",
			jobs: []*waveobj.Job{mkJob("j1", JobManagerStatus_Running, "")},
			want: []string{},
		},
		{
			name: "empty input yields no candidates",
			jobs: nil,
			want: []string{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := unusedJobCandidates(tt.jobs)
			if len(got) != len(tt.want) {
				t.Fatalf("unusedJobCandidates() = %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("unusedJobCandidates() = %v, want %v", got, tt.want)
				}
			}
		})
	}
}

// TestPruneUnusedJobsTwoRounds mirrors pruneUnusedJobs' candidate intersection semantics: a job
// must be prunable in two consecutive rounds before it is deleted, so a job that disappears from
// the DB between rounds (already deleted elsewhere) is never re-deleted.
func TestPruneUnusedJobsTwoRounds(t *testing.T) {
	round1 := unusedJobCandidates([]*waveobj.Job{
		mkJob("j1", JobManagerStatus_Done, ""),
		mkJob("j2", JobManagerStatus_Done, ""),
		mkJob("j3", JobManagerStatus_Running, ""),
	})
	// round 2: j1 got re-attached, j2 was deleted from the db elsewhere -> nothing left to
	// intersect, so nothing is deleted
	round2 := unusedJobCandidates([]*waveobj.Job{
		mkJob("j1", JobManagerStatus_Done, "block-1"),
		mkJob("j3", JobManagerStatus_Running, ""),
	})
	toDelete := utilfn.StrSetIntersection(round1, round2)
	if len(toDelete) != 0 {
		t.Fatalf("expected nothing to delete, got %v", toDelete)
	}

	// round 2b: j1 is still done and unattached -> it stays a candidate and is deleted
	round2b := unusedJobCandidates([]*waveobj.Job{
		mkJob("j1", JobManagerStatus_Done, ""),
		mkJob("j3", JobManagerStatus_Running, ""),
	})
	toDelete = utilfn.StrSetIntersection(round1, round2b)
	if len(toDelete) != 1 || toDelete[0] != "j1" {
		t.Fatalf("expected [j1] to be deleted, got %v", toDelete)
	}
}

func TestComputeStreamBaseSeq(t *testing.T) {
	tests := []struct {
		name     string
		fileSize int64
		totalGap int64
		want     int64
	}{
		{name: "no gap", fileSize: 100, totalGap: 0, want: 100},
		{name: "with gap", fileSize: 100, totalGap: 25, want: 125},
		{name: "empty file", fileSize: 0, totalGap: 0, want: 0},
		{name: "gap but empty file", fileSize: 0, totalGap: 40, want: 40},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := computeStreamBaseSeq(tt.fileSize, tt.totalGap); got != tt.want {
				t.Fatalf("computeStreamBaseSeq(%d, %d) = %d, want %d", tt.fileSize, tt.totalGap, got, tt.want)
			}
		})
	}
}

func TestAccountStreamGap(t *testing.T) {
	tests := []struct {
		name       string
		currentSeq int64
		serverSeq  int64
		want       int64
	}{
		{name: "server ahead", currentSeq: 100, serverSeq: 140, want: 40},
		{name: "server equal", currentSeq: 100, serverSeq: 100, want: 0},
		{name: "server behind", currentSeq: 100, serverSeq: 90, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := accountStreamGap(tt.currentSeq, tt.serverSeq); got != tt.want {
				t.Fatalf("accountStreamGap(%d, %d) = %d, want %d", tt.currentSeq, tt.serverSeq, got, tt.want)
			}
		})
	}
}