//go:build windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so closing the handle
// terminates the entire process tree (shell + children like pi/node), not just
// the direct child. KillGraceful only kills the direct process; without this a
// closed agent block can leave its agent process orphaned and spinning forever.
func attachJobObject(proc *os.Process) (uintptr, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateJobObject: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, fmt.Errorf("SetInformationJobObject: %w", err)
	}
	procHandle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_INFORMATION, false, uint32(proc.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return 0, fmt.Errorf("OpenProcess(%d): %w", proc.Pid, err)
	}
	defer windows.CloseHandle(procHandle)
	if err := windows.AssignProcessToJobObject(job, procHandle); err != nil {
		windows.CloseHandle(job)
		return 0, fmt.Errorf("AssignProcessToJobObject(%d): %w", proc.Pid, err)
	}
	return uintptr(job), nil
}

// killJobTree terminates every process in the job, i.e. the whole descendant tree.
func killJobTree(job uintptr) {
	if job == 0 {
		return
	}
	_ = windows.TerminateJobObject(windows.Handle(job), 1)
}

// closeJobObject closes the job handle; with KILL_ON_JOB_CLOSE set this also
// reaps any processes still in the job.
func closeJobObject(job uintptr) {
	if job == 0 {
		return
	}
	_ = windows.CloseHandle(windows.Handle(job))
}
