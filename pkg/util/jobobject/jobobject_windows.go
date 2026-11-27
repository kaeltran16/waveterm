//go:build windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jobobject

import (
	"errors"
	"fmt"
	"log"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const jobsSupported = true

// Attach puts proc in a new job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE so closing the
// handle (Close) terminates the entire process tree rooted at proc, not just proc itself.
func Attach(proc *os.Process) (uintptr, error) {
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

// KillTree terminates every process in the job, i.e. the whole descendant tree.
func KillTree(job uintptr) {
	if job == 0 {
		return
	}
	_ = windows.TerminateJobObject(windows.Handle(job), 1)
}

// Close unregisters the job, then closes its handle; with KILL_ON_JOB_CLOSE set this also reaps any
// processes still in the job. For a registered job it reads the peak before closing, releases the handles
// Suspend kept, then calls the close hook outside the registry lock (with peak 0 when the read failed, since
// the hook also marks the tree's end).
func Close(job uintptr) {
	if job == 0 {
		return
	}
	e, hook := unregister(job)
	var peak uint64
	if e != nil && hook != nil {
		var err error
		if peak, err = jobPeak(windows.Handle(job)); err != nil {
			log.Printf("jobobject: peak of job (root pid %d, owner %s %s): %v", e.rootPid, e.owner.Kind, e.owner.Id, err)
		}
	}
	_ = windows.CloseHandle(windows.Handle(job))
	if e == nil {
		return
	}
	// after the job handle: the tree is already reaped, so resuming lets nothing run
	for pid, h := range e.suspended {
		releaseSuspended(pid, windows.Handle(h))
	}
	if hook != nil {
		hook(e.owner, e.rootPid, peak)
	}
}

// mirrors JOBOBJECT_MEMORY_USAGE_INFORMATION.
type memoryUsageInformation struct {
	jobMemory         uint64
	peakJobMemoryUsed uint64
}

// JobObjectMemoryUsageInformation is missing from x/sys and winnt.h; 28 in the ntpsapi enum.
const jobObjectMemoryUsageInformation = 28

func jobPeak(job windows.Handle) (uint64, error) {
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		return 0, fmt.Errorf("QueryInformationJobObject(extended limit): %w", err)
	}
	return uint64(info.PeakJobMemoryUsed), nil
}

func jobCurrent(job windows.Handle) (uint64, error) {
	var info memoryUsageInformation
	if err := windows.QueryInformationJobObject(job, jobObjectMemoryUsageInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		return 0, fmt.Errorf("QueryInformationJobObject(memory usage): %w", err)
	}
	return info.jobMemory, nil
}

// LiveUsage reads every registered job's current memory under the registry lock. A job whose query
// fails is logged and skipped.
func LiveUsage() []JobUsage {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	var rtn []JobUsage
	for job, e := range registry.jobs {
		cur, err := jobCurrent(windows.Handle(job))
		if err != nil {
			log.Printf("jobobject: memory of job (root pid %d, owner %s %s): %v", e.rootPid, e.owner.Kind, e.owner.Id, err)
			continue
		}
		rtn = append(rtn, JobUsage{Owner: e.owner, RootPid: e.rootPid, Current: cur})
	}
	return rtn
}

var (
	ntdll                = windows.NewLazySystemDLL("ntdll.dll")
	procNtSuspendProcess = ntdll.NewProc("NtSuspendProcess")
	procNtResumeProcess  = ntdll.NewProc("NtResumeProcess")
)

func ntCall(proc *windows.LazyProc, h windows.Handle) error {
	if r, _, _ := proc.Call(uintptr(h)); r != 0 {
		return windows.NTStatus(r)
	}
	return nil
}

// Suspend suspends every member of each live job registered for o that this package has not already
// suspended, keeping each one's handle open (it pins the pid, so Resume hits exactly these processes). It
// returns how many it newly suspended; members that fail are skipped and their errors joined. ErrNotMember
// when no job is registered for o.
func Suspend(o Owner) (int, error) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	found := false
	n := 0
	var errs []error
	for job, e := range registry.jobs {
		if e.owner != o {
			continue
		}
		found = true
		members, err := Members(job)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, pid := range members {
			if h, ok := e.suspended[pid]; ok {
				if !hasExited(windows.Handle(h)) {
					continue
				}
				// exited, so the pid may now name a newcomer
				releaseSuspended(pid, windows.Handle(h))
				delete(e.suspended, pid)
			}
			h, err := suspendMember(job, pid)
			if errors.Is(err, ErrGone) {
				continue
			}
			if err != nil {
				errs = append(errs, err)
				continue
			}
			if e.suspended == nil {
				e.suspended = make(map[int]uintptr)
			}
			e.suspended[pid] = uintptr(h)
			n++
		}
	}
	if !found {
		return 0, ErrNotMember
	}
	return n, errors.Join(errs...)
}

// suspendMember opens pid, checks it is still in job on that same handle, then suspends through it. ErrGone
// when pid has exited or no longer names a member.
func suspendMember(job uintptr, pid int) (windows.Handle, error) {
	h, err := windows.OpenProcess(windows.PROCESS_SUSPEND_RESUME|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return 0, ErrGone
		}
		return 0, fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	if hasExited(h) {
		windows.CloseHandle(h)
		return 0, ErrGone
	}
	member, err := isProcessInJob(h, job)
	if err != nil || !member {
		windows.CloseHandle(h)
		if err != nil {
			return 0, fmt.Errorf("IsProcessInJob(%d): %w", pid, err)
		}
		return 0, ErrGone
	}
	if err := ntCall(procNtSuspendProcess, h); err != nil {
		windows.CloseHandle(h)
		return 0, fmt.Errorf("NtSuspendProcess(%d): %w", pid, err)
	}
	return h, nil
}

// Resume resumes and closes every handle Suspend kept for o's jobs. A process that has since exited is not
// an error.
func Resume(o Owner) error {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	var errs []error
	for _, e := range registry.jobs {
		if e.owner != o {
			continue
		}
		for pid, h := range e.suspended {
			if err := releaseSuspended(pid, windows.Handle(h)); err != nil {
				errs = append(errs, err)
			}
		}
		e.suspended = nil
	}
	return errors.Join(errs...)
}

// releaseSuspended resumes h and closes it.
func releaseSuspended(pid int, h windows.Handle) error {
	defer windows.CloseHandle(h)
	if err := ntCall(procNtResumeProcess, h); err != nil && !hasExited(h) {
		return fmt.Errorf("NtResumeProcess(%d): %w", pid, err)
	}
	return nil
}

// LowerPriority puts every process in the live job registered for block blockId at below-normal priority, so a
// background worker's tree yields the CPU to the app. It ORs the limit into the job's current ones, keeping
// KILL_ON_JOB_CLOSE. ErrNotMember when no live job is registered for the block.
func LowerPriority(blockId string) error {
	o := Owner{Kind: OwnerKind_Block, Id: blockId}
	found, err := anyOwnedJob(o, func(job uintptr) (bool, error) { return true, setBelowNormal(windows.Handle(job)) })
	if err != nil {
		return fmt.Errorf("lowering priority of block %s: %w", blockId, err)
	}
	if !found {
		return ErrNotMember
	}
	return nil
}

// LowerJobPriority puts every process in job, and every one it starts later, at below-normal priority.
func LowerJobPriority(job uintptr) error {
	return setBelowNormal(windows.Handle(job))
}

func setBelowNormal(job windows.Handle) error {
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	size := uint32(unsafe.Sizeof(info))
	if err := windows.QueryInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), size, nil); err != nil {
		return fmt.Errorf("QueryInformationJobObject: %w", err)
	}
	info.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_PRIORITY_CLASS
	info.BasicLimitInformation.PriorityClass = windows.BELOW_NORMAL_PRIORITY_CLASS
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), size); err != nil {
		return fmt.Errorf("SetInformationJobObject: %w", err)
	}
	return nil
}

// mirrors JOBOBJECT_BASIC_PROCESS_ID_LIST; list is a variable-length array.
type basicProcessIdList struct {
	assigned uint32
	inList   uint32
	list     [1]uintptr
}

const (
	initialIdListLen = 64
	idListSlack      = 16 // members can join between the sizing call and the retry
)

// Members lists the pids in job, growing the buffer while the list is truncated.
func Members(job uintptr) ([]int, error) {
	if job == 0 {
		return nil, nil
	}
	wordSize := unsafe.Sizeof(uintptr(0))
	hdr := int(unsafe.Offsetof(basicProcessIdList{}.list) / wordSize)
	n := initialIdListLen
	for {
		buf := make([]uintptr, hdr+n)
		list := (*basicProcessIdList)(unsafe.Pointer(&buf[0]))
		err := windows.QueryInformationJobObject(windows.Handle(job), windows.JobObjectBasicProcessIdList,
			uintptr(unsafe.Pointer(&buf[0])), uint32(uintptr(len(buf))*wordSize), nil)
		if err != nil && !errors.Is(err, windows.ERROR_MORE_DATA) {
			return nil, fmt.Errorf("QueryInformationJobObject: %w", err)
		}
		if err == nil && list.inList >= list.assigned {
			pids := make([]int, list.inList)
			for i, id := range buf[hdr : hdr+int(list.inList)] {
				pids[i] = int(id)
			}
			return pids, nil
		}
		n = max(int(list.assigned)+idListSlack, n*2)
	}
}

const terminateExitCode = 1

var procIsProcessInJob = windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob")

func isProcessInJob(proc windows.Handle, job uintptr) (bool, error) {
	var result int32
	r, _, err := procIsProcessInJob.Call(uintptr(proc), job, uintptr(unsafe.Pointer(&result)))
	if r == 0 {
		return false, err
	}
	return result != 0, nil
}

func hasExited(h windows.Handle) bool {
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == windows.WAIT_OBJECT_0
}

// TerminateMember opens pid, checks IsProcessInJob against a live job registered for o on that same
// handle, then terminates through it. The open handle pins the process, so a reused pid cannot be hit.
func TerminateMember(o Owner, pid int) error {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return ErrGone
		}
		return fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer windows.CloseHandle(h)
	// an exited process whose object another handle keeps open still opens and still reports its job
	if hasExited(h) {
		return ErrGone
	}
	member, err := anyOwnedJob(o, func(job uintptr) (bool, error) { return isProcessInJob(h, job) })
	if err != nil {
		return fmt.Errorf("IsProcessInJob(%d): %w", pid, err)
	}
	if !member {
		return ErrNotMember
	}
	if err := windows.TerminateProcess(h, terminateExitCode); err != nil {
		if hasExited(h) {
			return ErrGone
		}
		return fmt.Errorf("TerminateProcess(%d): %w", pid, err)
	}
	return nil
}
