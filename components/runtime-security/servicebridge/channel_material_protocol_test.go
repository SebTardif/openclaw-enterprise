package servicebridge

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func materialTestBytes(kind byte, header string, payload []byte) []byte {
	result := make([]byte, 7+len(header)+len(payload))
	binary.BigEndian.PutUint32(result, uint32(len(result)-4))
	result[4] = kind
	binary.BigEndian.PutUint16(result[5:], uint16(len(header)))
	copy(result[7:], header)
	copy(result[7+len(header):], payload)
	return result
}

func TestMaterialFrameOpaqueBorrowAndZero(t *testing.T) {
	// Synthetic binary bytes exercise framing only, never actual selected material.
	raw := materialTestBytes(materialResult, `{"kind":"selected-bundle"}`, []byte{0, 255, 128, 13})
	frame, err := readMaterialFrame(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(frame.payload, []byte{0, 255, 128, 13}) {
		t.Fatal("payload correspondence")
	}
	var output bytes.Buffer
	if writeMaterialFrame(&output, frame) != nil || !bytes.Equal(output.Bytes(), raw) {
		t.Fatal("exact forwarding")
	}
	borrowed := frame.payload
	frame.release()
	if !bytes.Equal(borrowed, make([]byte, 4)) {
		t.Fatal("released backing retained")
	}
}

func TestMaterialFrameBoundsBeforePayload(t *testing.T) {
	for _, size := range []int{MaterialPayloadBytes, MaterialPayloadBytes + 1} {
		frame, err := readMaterialFrame(bytes.NewReader(materialTestBytes(materialResult, `{}`, make([]byte, size))))
		if size == MaterialPayloadBytes {
			if err != nil {
				t.Fatal(err)
			}
			frame.release()
		} else if err == nil {
			frame.release()
			t.Fatal("oversize accepted")
		}
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], MaterialFrameBytes)
	if _, err := readMaterialFrame(bytes.NewReader(prefix[:])); err == nil {
		t.Fatal("oversize length accepted")
	}
}

func TestMaterialFrameMalformedSyntheticInputs(t *testing.T) {
	cases := [][]byte{
		materialTestBytes(0, `{}`, nil),
		materialTestBytes(10, `{}`, nil),
		materialTestBytes(materialRequest, `{}`, []byte{1}),
		materialTestBytes(materialResult, `{"x":1,"x":2}`, nil),
		materialTestBytes(materialResult, `[]`, nil),
		materialTestBytes(materialResult, `{"x":`, nil),
		materialTestBytes(materialResult, `{"x":"`+string(bytes.Repeat([]byte{'x'}, 2048))+`"}`, nil),
		materialTestBytes(materialResult, string([]byte{'{', 255, '}'}), nil),
	}
	for i, raw := range cases {
		if frame, err := readMaterialFrame(bytes.NewReader(raw)); err == nil {
			frame.release()
			t.Fatalf("malformed case %d accepted", i)
		}
	}
}

type materialFragmentReader struct{ bytes []byte }

func (r *materialFragmentReader) Read(target []byte) (int, error) {
	if len(r.bytes) == 0 {
		return 0, io.EOF
	}
	target[0] = r.bytes[0]
	r.bytes = r.bytes[1:]
	return 1, nil
}
func TestMaterialFragmentedInputAndNoExtraConsumption(t *testing.T) {
	one := materialTestBytes(materialRequest, `{"purpose":"read-selected-channel-material"}`, nil)
	r := &materialFragmentReader{append(append([]byte{}, one...), 42)}
	f, err := readMaterialFrame(r)
	if err != nil {
		t.Fatal(err)
	}
	f.release()
	if !bytes.Equal(r.bytes, []byte{42}) {
		t.Fatal("prefetched another frame")
	}
	for i := 0; i < len(one); i++ {
		if f, e := readMaterialFrame(bytes.NewReader(one[:i])); e == nil {
			f.release()
			t.Fatalf("truncated input %d accepted", i)
		}
	}
}

func TestMaterialMetadataEncoderHasOneBoundedBacking(t *testing.T) {
	value := struct {
		SchemaVersion int    `json:"schemaVersion"`
		Ref           string `json:"ref"`
		Minimum       int64  `json:"minimum"`
		Maximum       uint64 `json:"maximum"`
		Message       any    `json:"message"`
	}{1, "quotes\"\\<>&\n\r\t\b\f\u0001\u2028\u2029界😀", -9007199254740991, 9007199254740991,
		struct {
			Valid  bool  `json:"valid"`
			Values []int `json:"values"`
		}{true, []int{0, 1, -1}}}
	standard, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := newMaterialMetadataFrame(materialConnected, value)
	if err != nil {
		t.Fatal(err)
	}
	defer frame.release()
	if !bytes.Equal(frame.header, standard) {
		t.Fatalf("bounded writer differs from standard metadata encoding: %q", frame.header)
	}
	if cap(frame.wire) != 7+MaterialMetadataBytes || len(frame.owned) != len(standard)+3 || &frame.header[0] != &frame.owned[3] {
		t.Fatal("metadata header lacks its one fixed backing")
	}
	for _, invalid := range []any{map[string]any{"bad": string([]byte{255})}, map[string]any{"large": strings.Repeat("界", 1000)}, map[string]any{"large": uint64(9007199254740992)}, map[string]any{"bad": 1.25}} {
		if frame, err := newMaterialMetadataFrame(materialReady, invalid); err == nil {
			frame.release()
			t.Fatal("invalid bounded metadata accepted")
		}
	}
}
