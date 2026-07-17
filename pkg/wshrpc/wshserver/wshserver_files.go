// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func (ws *WshServer) FileCreateCommand(ctx context.Context, data wshrpc.FileData) error {
	data.Data64 = ""
	err := wshfs.PutFile(ctx, data)
	if err != nil {
		return fmt.Errorf("error creating file: %w", err)
	}
	return nil
}

func (ws *WshServer) FileMkdirCommand(ctx context.Context, data wshrpc.FileData) error {
	return wshfs.Mkdir(ctx, data.Info.Path)
}

func (ws *WshServer) FileDeleteCommand(ctx context.Context, data wshrpc.CommandDeleteFileData) error {
	return wshfs.Delete(ctx, data)
}

func (ws *WshServer) FileInfoCommand(ctx context.Context, data wshrpc.FileData) (*wshrpc.FileInfo, error) {
	return wshfs.Stat(ctx, data.Info.Path)
}

func (ws *WshServer) FileListCommand(ctx context.Context, data wshrpc.FileListData) ([]*wshrpc.FileInfo, error) {
	return wshfs.ListEntries(ctx, data.Path, data.Opts)
}

func (ws *WshServer) FileListStreamCommand(ctx context.Context, data wshrpc.FileListData) <-chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData] {
	return wshfs.ListEntriesStream(ctx, data.Path, data.Opts)
}

func (ws *WshServer) FileWriteCommand(ctx context.Context, data wshrpc.FileData) error {
	return wshfs.PutFile(ctx, data)
}

func (ws *WshServer) FileReadCommand(ctx context.Context, data wshrpc.FileData) (*wshrpc.FileData, error) {
	return wshfs.Read(ctx, data)
}

func (ws *WshServer) FileStreamCommand(ctx context.Context, data wshrpc.CommandFileStreamData) (*wshrpc.FileInfo, error) {
	return wshfs.FileStream(ctx, data)
}

func (ws *WshServer) FileCopyCommand(ctx context.Context, data wshrpc.CommandFileCopyData) error {
	return wshfs.Copy(ctx, data)
}

func (ws *WshServer) FileMoveCommand(ctx context.Context, data wshrpc.CommandFileCopyData) error {
	return wshfs.Move(ctx, data)
}

func (ws *WshServer) FileAppendCommand(ctx context.Context, data wshrpc.FileData) error {
	return wshfs.Append(ctx, data)
}

func (ws *WshServer) FileJoinCommand(ctx context.Context, paths []string) (*wshrpc.FileInfo, error) {
	if len(paths) < 2 {
		if len(paths) == 0 {
			return nil, fmt.Errorf("no paths provided")
		}
		return wshfs.Stat(ctx, paths[0])
	}
	return wshfs.Join(ctx, paths[0], paths[1:]...)
}

func (ws *WshServer) WriteTempFileCommand(ctx context.Context, data wshrpc.CommandWriteTempFileData) (string, error) {
	if data.FileName == "" {
		return "", fmt.Errorf("filename is required")
	}
	name := filepath.Base(data.FileName)
	if name == "" || name == "." || name == ".." {
		return "", fmt.Errorf("invalid filename")
	}
	tempDir, err := os.MkdirTemp("", "waveterm-")
	if err != nil {
		return "", fmt.Errorf("error creating temp directory: %w", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(data.Data64)
	if err != nil {
		return "", fmt.Errorf("error decoding base64 data: %w", err)
	}
	tempPath := filepath.Join(tempDir, name)
	err = os.WriteFile(tempPath, decoded, 0600)
	if err != nil {
		return "", fmt.Errorf("error writing temp file: %w", err)
	}
	return tempPath, nil
}

func waveFileToWaveFileInfo(wf *filestore.WaveFile) *wshrpc.WaveFileInfo {
	return &wshrpc.WaveFileInfo{
		ZoneId:    wf.ZoneId,
		Name:      wf.Name,
		Opts:      wf.Opts,
		CreatedTs: wf.CreatedTs,
		Size:      wf.Size,
		ModTs:     wf.ModTs,
		Meta:      wf.Meta,
	}
}

func (ws *WshServer) WaveFileReadStreamCommand(ctx context.Context, data wshrpc.CommandWaveFileReadStreamData) (*wshrpc.WaveFileInfo, error) {
	const maxStreamFileSize = 5 * 1024 * 1024

	waveFile, err := filestore.WFS.Stat(ctx, data.ZoneId, data.Name)
	if err != nil {
		return nil, fmt.Errorf("error statting wavefile: %w", err)
	}

	dataLength := waveFile.DataLength()
	if dataLength > maxStreamFileSize {
		return nil, fmt.Errorf("file size %d exceeds maximum streaming size of %d bytes", dataLength, maxStreamFileSize)
	}

	wshRpc := wshutil.GetWshRpcFromContext(ctx)
	if wshRpc == nil || wshRpc.StreamBroker == nil {
		return nil, fmt.Errorf("no stream broker available")
	}

	writer, err := wshRpc.StreamBroker.CreateStreamWriter(&data.StreamMeta)
	if err != nil {
		return nil, fmt.Errorf("error creating stream writer: %w", err)
	}

	_, fileData, err := filestore.WFS.ReadFile(ctx, data.ZoneId, data.Name)
	if err != nil {
		writer.Close()
		return nil, fmt.Errorf("error reading wavefile: %w", err)
	}

	go func() {
		defer func() {
			panichandler.PanicHandler("WaveFileReadStreamCommand", recover())
		}()
		defer writer.Close()

		_, err := writer.Write(fileData)
		if err != nil {
			log.Printf("error writing to stream for wavefile %s:%s: %v\n", data.ZoneId, data.Name, err)
		}
	}()

	rtnInfo := &wshrpc.WaveFileInfo{
		ZoneId:    waveFile.ZoneId,
		Name:      waveFile.Name,
		Opts:      waveFile.Opts,
		CreatedTs: waveFile.CreatedTs,
		Size:      waveFile.Size,
		ModTs:     waveFile.ModTs,
		Meta:      waveFile.Meta,
	}
	return rtnInfo, nil
}
