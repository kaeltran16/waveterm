// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package utilfn

import (
	"bytes"
	"io"
)

type lineBuf struct {
	buf        []byte
	inLongLine bool
}

// needs to be large enough to read the largest RPC packet
// there are some legacy file transfer packets that can send up to 32m (base64 encoded)
const maxLineLength = 64 * 1024 * 1024

func streamToLines_processBuf(lineBuf *lineBuf, readBuf []byte, lineFn func([]byte)) {
	for len(readBuf) > 0 {
		nlIdx := bytes.IndexByte(readBuf, '\n')
		if nlIdx == -1 {
			if lineBuf.inLongLine || len(lineBuf.buf)+len(readBuf) > maxLineLength {
				lineBuf.buf = nil
				lineBuf.inLongLine = true
				return
			}
			lineBuf.buf = append(lineBuf.buf, readBuf...)
			return
		}
		if !lineBuf.inLongLine && len(lineBuf.buf)+nlIdx <= maxLineLength {
			line := append(lineBuf.buf, readBuf[:nlIdx]...)
			lineFn(line)
		}
		lineBuf.buf = nil
		lineBuf.inLongLine = false
		readBuf = readBuf[nlIdx+1:]
	}
}

func StreamToLines(input io.Reader, lineFn func([]byte), readCallback func()) error {
	var lineBuf lineBuf
	readBuf := make([]byte, 64*1024)
	for {
		n, err := input.Read(readBuf)
		streamToLines_processBuf(&lineBuf, readBuf[:n], lineFn)
		if err != nil {
			return err
		}
		if readCallback != nil {
			readCallback()
		}
	}
}
