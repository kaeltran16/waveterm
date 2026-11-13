//go:build windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jobobject

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

const (
	helperEnv      = "JOBOBJECT_TEST_HELPER"
	helperLifetime = 60 * time.Second
	exitTimeout    = 10 * time.Second
	allocBytes     = 256 << 20
)

// TestHelperProcess is not a test: it is the child process the other tests start.
func TestHelperProcess(t *testing.T) {
	switch os.Getenv(helperEnv) {
	case "sleep":
		time.Sleep(helperLifetime)
		os.Exit(0)
	case "spawn":
		// waits for the go-ahead so the parent attaches the job first, then starts a sleeper and exits
		if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		child, err := helperCmd("sleep")
		if err == nil {
			err = child.Start()
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println(child.Process.Pid)
		os.Exit(0)
	case "alloc":
		// waits for the go-ahead so the parent attaches the job first, then commits and holds allocBytes
		if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		buf := make([]byte, allocBytes)
		for i := 0; i < len(buf); i += 4096 {
			buf[i] = 1
		}
		fmt.Println("ready")
		time.Sleep(helperLifetime)
		runtime.KeepAlive(buf)
		os.Exit(0)
	case "spin":
		deadline := time.Now().Add(helperLifetime)
		for time.Now().Before(deadline) {
		}
		os.Exit(0)
	}
}

func helperCmd(mode string) (*exec.Cmd, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, "-test.run=^TestHelperProcess$")
	cmd.Env = append(os.Environ(), helperEnv+"="+mode)
	return cmd, nil
}

func startSleeper(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd, err := helperCmd("sleep")
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting sleeper: %v", err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	return cmd
}

// attachRegistered closes the job at cleanup, so a test that closes it itself must not use this.
func attachRegistered(t *testing.T, cmd *exec.Cmd, o Owner) uintptr {
	t.Helper()
	job, err := Attach(cmd.Process)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	Register(job, cmd.Process.Pid, o)
	t.Cleanup(func() { Close(job) })
	return job
}

func assignToJob(t *testing.T, job uintptr, pid int) {
	t.Helper()
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		t.Fatalf("OpenProcess(%d): %v", pid, err)
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(windows.Handle(job), h); err != nil {
		t.Fatalf("AssignProcessToJobObject(%d): %v", pid, err)
	}
}

// isRunning is false for an exited process even while a handle keeps its object alive.
func isRunning(pid int) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == uint32(windows.WAIT_TIMEOUT)
}

func waitForExit(t *testing.T, pid int) {
	t.Helper()
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	if ev, err := windows.WaitForSingleObject(h, uint32(exitTimeout.Milliseconds())); err != nil || ev != windows.WAIT_OBJECT_0 {
		t.Fatalf("pid %d did not exit: %d %v", pid, ev, err)
	}
}

func findLiveJob(o Owner) (LiveJob, bool) {
	for _, lj := range LiveJobs() {
		if lj.Owner == o {
			return lj, true
		}
	}
	return LiveJob{}, false
}

func TestMembersIncludesOrphanedGrandchild(t *testing.T) {
	mid, err := helperCmd("spawn")
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := mid.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := mid.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := mid.Start(); err != nil {
		t.Fatalf("starting middle process: %v", err)
	}
	defer func() {
		mid.Process.Kill()
		mid.Wait()
	}()
	job, err := Attach(mid.Process)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer Close(job)

	if _, err := stdin.Write([]byte("\n")); err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(stdout)
	if !sc.Scan() {
		t.Fatalf("middle process printed no pid: %v", sc.Err())
	}
	grandchild, err := strconv.Atoi(strings.TrimSpace(sc.Text()))
	if err != nil {
		t.Fatalf("parsing grandchild pid %q: %v", sc.Text(), err)
	}
	waitForExit(t, mid.Process.Pid)

	members, err := Members(job)
	if err != nil {
		t.Fatalf("Members: %v", err)
	}
	if !slices.Contains(members, grandchild) {
		t.Fatalf("Members = %v, missing orphaned grandchild %d", members, grandchild)
	}
	if !isRunning(grandchild) {
		t.Fatalf("grandchild %d is not running", grandchild)
	}
}

func TestLiveJobsDropsClosedJob(t *testing.T) {
	var logs bytes.Buffer
	prevLog := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(prevLog)

	cmd := startSleeper(t)
	pid := cmd.Process.Pid
	job, err := Attach(cmd.Process)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	o := Owner{Kind: OwnerKind_Block, Id: "test-livejobs-drops-closed"}
	Register(job, pid, o)

	lj, ok := findLiveJob(o)
	if !ok {
		t.Fatal("registered job missing from LiveJobs")
	}
	if lj.RootPid != pid || !slices.Contains(lj.Members, pid) {
		t.Fatalf("LiveJob = %+v, want root and member %d", lj, pid)
	}

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
				LiveJobs()
			}
		}
	}()
	Close(job)
	close(stop)
	<-done

	if _, ok := findLiveJob(o); ok {
		t.Fatal("closed job still in LiveJobs")
	}
	if logs.Len() > 0 {
		t.Fatalf("LiveJobs logged errors during Close: %s", logs.String())
	}
}

func TestTerminateMemberRefusesNonMember(t *testing.T) {
	member := startSleeper(t)
	stranger := startSleeper(t)
	o := Owner{Kind: OwnerKind_Block, Id: "test-terminate-refuses"}
	attachRegistered(t, member, o)

	if err := TerminateMember(o, stranger.Process.Pid); !errors.Is(err, ErrNotMember) {
		t.Fatalf("TerminateMember(stranger) = %v, want ErrNotMember", err)
	}
	if !isRunning(stranger.Process.Pid) {
		t.Fatal("stranger was terminated")
	}
	if err := TerminateMember(Owner{Kind: OwnerKind_Block, Id: "test-no-such-owner"}, member.Process.Pid); !errors.Is(err, ErrNotMember) {
		t.Fatalf("TerminateMember(unregistered owner) = %v, want ErrNotMember", err)
	}
	if !isRunning(member.Process.Pid) {
		t.Fatal("member was terminated through an owner with no live job")
	}
}

func TestTerminateMemberGone(t *testing.T) {
	cmd := startSleeper(t)
	pid := cmd.Process.Pid
	o := Owner{Kind: OwnerKind_Block, Id: "test-terminate-gone"}
	attachRegistered(t, cmd, o)

	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	// exited, but the exec handle still keeps the process object alive
	waitForExit(t, pid)
	if err := TerminateMember(o, pid); !errors.Is(err, ErrGone) {
		t.Fatalf("TerminateMember(exited, handle open) = %v, want ErrGone", err)
	}
	// releases the last handle, so the pid no longer opens
	cmd.Wait()
	if err := TerminateMember(o, pid); !errors.Is(err, ErrGone) {
		t.Fatalf("TerminateMember(exited, released) = %v, want ErrGone", err)
	}
}

func TestTerminateMemberKills(t *testing.T) {
	root := startSleeper(t)
	target := startSleeper(t)
	o := Owner{Kind: OwnerKind_Block, Id: "test-terminate-kills"}
	job := attachRegistered(t, root, o)
	assignToJob(t, job, target.Process.Pid)

	if err := TerminateMember(o, target.Process.Pid); err != nil {
		t.Fatalf("TerminateMember: %v", err)
	}
	waitForExit(t, target.Process.Pid)
	target.Wait()
	if code := target.ProcessState.ExitCode(); code != terminateExitCode {
		t.Fatalf("target exit code = %d, want %d", code, terminateExitCode)
	}
	if !isRunning(root.Process.Pid) {
		t.Fatal("the job's other member was terminated")
	}
}

func processExists(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	windows.CloseHandle(h)
	return true
}

// powershellEncodedCommand base64-encodes a command as UTF-16LE for -EncodedCommand.
func powershellEncodedCommand(cmd string) string {
	u16 := utf16.Encode([]rune(cmd))
	buf := make([]byte, 0, len(u16)*2)
	for _, v := range u16 {
		buf = append(buf, byte(v), byte(v>>8))
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// TestJobObjectKillsDescendants verifies that killing the job terminates not just the
// direct child but its descendants too — the behavior that prevents orphaned agent
// processes when a block is closed.
func TestJobObjectKillsDescendants(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	// inner powershell writes its own pid then sleeps; outer powershell waits on it
	inner := fmt.Sprintf("$pid | Out-File -Encoding ascii -FilePath '%s'; Start-Sleep -Seconds 60", pidFile)
	outer := fmt.Sprintf("Start-Process -NoNewWindow -Wait powershell -ArgumentList '-NoProfile','-EncodedCommand','%s'; Start-Sleep -Seconds 60", powershellEncodedCommand(inner))
	cmd := exec.Command("powershell", "-NoProfile", "-Command", outer)
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting outer process: %v", err)
	}
	defer func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	}()

	job, err := Attach(cmd.Process)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if job == 0 {
		t.Fatal("Attach returned zero handle")
	}
	defer Close(job)

	// wait for the descendant to write its pid
	var childPid int
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		data, rerr := os.ReadFile(pidFile)
		if rerr == nil {
			pidStr := strings.TrimSpace(string(data))
			if _, serr := fmt.Sscanf(pidStr, "%d", &childPid); serr == nil && childPid > 0 {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if childPid == 0 {
		t.Fatal("descendant never wrote its pid")
	}
	if !processExists(childPid) {
		t.Fatalf("descendant %d not running before job kill", childPid)
	}

	KillTree(job)

	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !processExists(childPid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("descendant %d still alive after job kill", childPid)
}

func priorityClass(t *testing.T, pid int) uint32 {
	t.Helper()
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatalf("OpenProcess(%d): %v", pid, err)
	}
	defer windows.CloseHandle(h)
	class, err := windows.GetPriorityClass(h)
	if err != nil {
		t.Fatalf("GetPriorityClass(%d): %v", pid, err)
	}
	return class
}

func TestLowerPriorityKeepsKillOnClose(t *testing.T) {
	cmd := startSleeper(t)
	job, err := Attach(cmd.Process)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	blockId := "block-" + strconv.Itoa(cmd.Process.Pid)
	Register(job, cmd.Process.Pid, Owner{Kind: OwnerKind_Block, Id: blockId})
	if err := LowerPriority(blockId); err != nil {
		t.Fatalf("LowerPriority: %v", err)
	}
	if got := priorityClass(t, cmd.Process.Pid); got != windows.BELOW_NORMAL_PRIORITY_CLASS {
		t.Fatalf("priority class = %#x, want BELOW_NORMAL (%#x)", got, windows.BELOW_NORMAL_PRIORITY_CLASS)
	}
	Close(job)
	waitForExit(t, cmd.Process.Pid)
}

func TestLowerPriorityNoLiveJob(t *testing.T) {
	if err := LowerPriority("no-such-block"); !errors.Is(err, ErrNotMember) {
		t.Fatalf("LowerPriority(unregistered block) = %v, want ErrNotMember", err)
	}
}

// startAllocator starts a child in a new (unregistered) job and returns once the child has committed
// allocBytes. The caller closes the job.
func startAllocator(t *testing.T) (*exec.Cmd, uintptr) {
	t.Helper()
	cmd, err := helperCmd("alloc")
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting allocator: %v", err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	job, err := Attach(cmd.Process)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if _, err := stdin.Write([]byte("\n")); err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(stdout)
	if !sc.Scan() || sc.Text() != "ready" {
		t.Fatalf("allocator did not report ready: %q %v", sc.Text(), sc.Err())
	}
	return cmd, job
}

func findUsage(o Owner) (JobUsage, bool) {
	for _, u := range LiveUsage() {
		if u.Owner == o {
			return u, true
		}
	}
	return JobUsage{}, false
}

func TestLiveUsageReportsChildMemory(t *testing.T) {
	cmd, job := startAllocator(t)
	o := Owner{Kind: OwnerKind_Block, Id: "test-liveusage"}
	Register(job, cmd.Process.Pid, o)
	defer Close(job)

	u, ok := findUsage(o)
	if !ok {
		t.Fatal("registered job missing from LiveUsage")
	}
	if u.RootPid != cmd.Process.Pid || u.Current < allocBytes {
		t.Fatalf("JobUsage = %+v, want root %d and Current >= %d", u, cmd.Process.Pid, allocBytes)
	}
}

func TestCloseHookGetsPeak(t *testing.T) {
	type call struct {
		owner   Owner
		rootPid int
		peak    uint64
	}
	var calls []call
	SetCloseHook(func(o Owner, rootPid int, peak uint64) {
		calls = append(calls, call{o, rootPid, peak})
	})
	defer SetCloseHook(nil)

	unregistered, unregJob := startAllocator(t)
	Close(unregJob)
	waitForExit(t, unregistered.Process.Pid)
	if len(calls) != 0 {
		t.Fatalf("hook fired for an unregistered job: %+v", calls)
	}

	cmd, job := startAllocator(t)
	o := Owner{Kind: OwnerKind_RunCmd, Id: "test-closehook", Cmd: "Verify", Task: "2"}
	Register(job, cmd.Process.Pid, o)
	Close(job)
	if len(calls) != 1 {
		t.Fatalf("hook fired %d times, want 1: %+v", len(calls), calls)
	}
	if c := calls[0]; c.owner != o || c.rootPid != cmd.Process.Pid || c.peak < allocBytes {
		t.Fatalf("hook got %+v, want owner %+v, root %d, peak >= %d", c, o, cmd.Process.Pid, allocBytes)
	}
}

func cpuTime(t *testing.T, pid int) time.Duration {
	t.Helper()
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatalf("OpenProcess(%d): %v", pid, err)
	}
	defer windows.CloseHandle(h)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		t.Fatalf("GetProcessTimes(%d): %v", pid, err)
	}
	return time.Duration(kernel.Nanoseconds() + user.Nanoseconds())
}

const cpuSampleWindow = 500 * time.Millisecond

func TestSuspendResume(t *testing.T) {
	cmd, err := helperCmd("spin")
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting spinner: %v", err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	pid := cmd.Process.Pid
	o := Owner{Kind: OwnerKind_Block, Id: "test-suspend-resume"}
	attachRegistered(t, cmd, o)

	if n, err := Suspend(o); err != nil || n != 1 {
		t.Fatalf("Suspend = %d, %v; want 1, nil", n, err)
	}
	before := cpuTime(t, pid)
	time.Sleep(cpuSampleWindow)
	if after := cpuTime(t, pid); after != before {
		t.Fatalf("suspended child's CPU time advanced: %v -> %v", before, after)
	}
	if n, err := Suspend(o); err != nil || n != 0 {
		t.Fatalf("second Suspend = %d, %v; want 0, nil", n, err)
	}

	if err := Resume(o); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	before = cpuTime(t, pid)
	time.Sleep(cpuSampleWindow)
	if after := cpuTime(t, pid); after <= before {
		t.Fatalf("resumed child's CPU time did not advance: %v -> %v (a second Suspend double-counted?)", before, after)
	}

	if _, err := Suspend(Owner{Kind: OwnerKind_Block, Id: "test-no-such-owner"}); !errors.Is(err, ErrNotMember) {
		t.Fatalf("Suspend(unregistered owner) = %v, want ErrNotMember", err)
	}
}

func TestKillSuspendedTree(t *testing.T) {
	cmd := startSleeper(t)
	pid := cmd.Process.Pid
	job, err := Attach(cmd.Process)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	o := Owner{Kind: OwnerKind_Block, Id: "test-kill-suspended"}
	Register(job, pid, o)
	if n, err := Suspend(o); err != nil || n != 1 {
		t.Fatalf("Suspend = %d, %v; want 1, nil", n, err)
	}

	KillTree(job)
	Close(job)
	waitForExit(t, pid)
	// releases exec's handle; a suspend handle still open would keep the process object (and pid) alive
	cmd.Wait()
	if processExists(pid) {
		t.Fatalf("pid %d still opens after Close: its suspend handle was not released", pid)
	}
	if n, err := Suspend(o); !errors.Is(err, ErrNotMember) || n != 0 {
		t.Fatalf("Suspend after Close = %d, %v; want 0, ErrNotMember", n, err)
	}
}
