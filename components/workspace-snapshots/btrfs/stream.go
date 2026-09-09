package btrfs

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
)

type streamIdentity struct {
	Path           string
	UUID           string
	CTransID       uint64
	ParentUUID     string
	ParentCTransID uint64
}

// readStreamIdentity extracts the first command of our own successful native
// send. It is not a validator or admission path for arbitrary receive streams.
// See https://btrfs.readthedocs.io/en/latest/dev/dev-send-stream.html.
func readStreamIdentity(r io.Reader) (streamIdentity, error) {
	var out streamIdentity
	header := make([]byte, 17)
	if _, err := io.ReadFull(r, header); err != nil {
		return out, err
	}
	if !bytes.Equal(header[:13], []byte("btrfs-stream\x00")) || binary.LittleEndian.Uint32(header[13:]) != 1 {
		return out, fmt.Errorf("unsupported Btrfs stream header")
	}
	command := make([]byte, 10)
	if _, err := io.ReadFull(r, command); err != nil {
		return out, err
	}
	size := binary.LittleEndian.Uint32(command[:4])
	kind := binary.LittleEndian.Uint16(command[4:6])
	if size > 65536 || (kind != 1 && kind != 2) {
		return out, fmt.Errorf("invalid first Btrfs command")
	}
	payload := make([]byte, int(size))
	if _, err := io.ReadFull(r, payload); err != nil {
		return out, err
	}
	wantCRC := binary.LittleEndian.Uint32(command[6:10])
	clear(command[6:10])
	// The stream uses raw CRC32C seed zero, without the usual conditioning.
	gotCRC := ^crc32.Update(^uint32(0), crc32.MakeTable(crc32.Castagnoli), append(command, payload...))
	if gotCRC != wantCRC {
		return out, fmt.Errorf("invalid Btrfs first-command checksum")
	}
	attrs := make(map[uint16][]byte)
	for len(payload) > 0 {
		if len(payload) < 4 {
			return out, fmt.Errorf("truncated Btrfs attribute")
		}
		key, n := binary.LittleEndian.Uint16(payload[:2]), int(binary.LittleEndian.Uint16(payload[2:4]))
		payload = payload[4:]
		if n > len(payload) {
			return out, fmt.Errorf("truncated Btrfs attribute value")
		}
		if _, exists := attrs[key]; exists {
			return out, fmt.Errorf("duplicate Btrfs attribute")
		}
		attrs[key] = payload[:n]
		payload = payload[n:]
	}
	expected := 3
	if kind == 2 {
		expected = 5
	}
	if len(attrs) != expected || len(attrs[1]) != 16 || len(attrs[2]) != 8 || !validID(string(attrs[15])) {
		return out, fmt.Errorf("invalid Btrfs stream identity")
	}
	out.Path = string(attrs[15])
	out.UUID = uuidString(attrs[1])
	out.CTransID = binary.LittleEndian.Uint64(attrs[2])
	if out.UUID == "00000000-0000-0000-0000-000000000000" || out.CTransID == 0 {
		return out, fmt.Errorf("empty Btrfs identity")
	}
	if kind == 2 {
		if len(attrs[20]) != 16 || len(attrs[21]) != 8 {
			return out, fmt.Errorf("missing Btrfs parent identity")
		}
		out.ParentUUID = uuidString(attrs[20])
		out.ParentCTransID = binary.LittleEndian.Uint64(attrs[21])
		if out.ParentUUID == "00000000-0000-0000-0000-000000000000" || out.ParentCTransID == 0 {
			return out, fmt.Errorf("empty Btrfs parent identity")
		}
	}
	return out, nil
}

func uuidString(b []byte) string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func validID(id string) bool {
	if len(id) < 1 || len(id) > 64 {
		return false
	}
	for i, c := range id {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			continue
		}
		if i > 0 && (c == '-' || c == '_') {
			continue
		}
		return false
	}
	return true
}
