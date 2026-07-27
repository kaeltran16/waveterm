// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package secretstore

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// DPAPI is what Electron's safeStorage used on Windows, so calling CryptProtectData directly keeps the
// original cryptographic property rather than weakening it: the blob is encrypted to the logged-in user
// account, so another account on the machine cannot read it, and there is no key of our own to store
// (which would just move the problem). No entropy argument is passed — an entropy value would have to
// live in the binary, where it protects nothing.

var (
	crypt32                = windows.NewLazySystemDLL("crypt32.dll")
	procCryptProtectData   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
)

// dataBlob mirrors Win32 DATA_BLOB.
type dataBlob struct {
	cbData uint32
	pbData *byte
}

func newBlob(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
}

// take copies the blob's contents into Go memory and frees the LocalAlloc'd buffer CryptoAPI returned.
func (b *dataBlob) take() []byte {
	if b.pbData == nil {
		return nil
	}
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	windows.LocalFree(windows.Handle(unsafe.Pointer(b.pbData)))
	return out
}

func protect(plain []byte) ([]byte, error) {
	in := newBlob(plain)
	var out dataBlob
	// CryptProtectData(pDataIn, szDataDescr, pOptionalEntropy, pvReserved, pPromptStruct, dwFlags, pDataOut)
	r, _, errno := syscall.SyscallN(procCryptProtectData.Addr(),
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, fmt.Errorf("CryptProtectData: %w", errno)
	}
	return out.take(), nil
}

func unprotect(cipher []byte) ([]byte, error) {
	in := newBlob(cipher)
	var out dataBlob
	// CryptUnprotectData(pDataIn, ppszDataDescr, pOptionalEntropy, pvReserved, pPromptStruct, dwFlags, pDataOut)
	r, _, errno := syscall.SyscallN(procCryptUnprotectData.Addr(),
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, fmt.Errorf("CryptUnprotectData: %w", errno)
	}
	return out.take(), nil
}
