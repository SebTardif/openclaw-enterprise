package identity

import (
	"bytes"
	"context"

	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"google.golang.org/grpc"
)

// Wire guards retain complete response material the SDK does not expose (CRLs)
// and reject ambiguity before SDK hint selection. All SVID parsing stays in SDK.
type wireSnapshot struct {
	certificates, key, bundle []byte
	crls                      [][]byte
}
type guardedStream struct {
	grpc.ClientStream
	source *Source
}

func (s *Source) streamInterceptor(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, options ...grpc.CallOption) (grpc.ClientStream, error) {
	stream, err := streamer(ctx, desc, cc, method, options...)
	if err != nil {
		return nil, err
	}
	return &guardedStream{ClientStream: stream, source: s}, nil
}
func (s *guardedStream) RecvMsg(message any) error {
	if err := s.ClientStream.RecvMsg(message); err != nil {
		return err
	}
	response, ok := message.(*workload.X509SVIDResponse)
	if !ok {
		return failure("INVALID_RESPONSE")
	}
	return s.source.stageResponse(response)
}
func (s *Source) stageResponse(response *workload.X509SVIDResponse) error {
	if len(response.Svids) > maxEntries || len(response.Crl) > maxEntries || len(response.FederatedBundles) > maxEntries {
		return failure("INVALID_RESPONSE")
	}
	var selected *workload.X509SVID
	seen := make(map[spiffeid.ID]bool, len(response.Svids))
	for _, candidate := range response.Svids {
		if candidate == nil {
			return failure("INVALID_RESPONSE")
		}
		id, err := workloadID(candidate.SpiffeId)
		if err != nil {
			return failure("INVALID_RESPONSE")
		}
		if seen[id] {
			return failure("IDENTITY_MISMATCH")
		}
		seen[id] = true
		// SDK hint de-duplication can skip a raw entry. Validate every entry with
		// maintained parsers before permitting any hint handling or selection.
		parsed, err := x509svid.ParseRaw(candidate.X509Svid, candidate.X509SvidKey)
		if err != nil || len(parsed.Certificates) > maxEntries {
			return failure("INVALID_RESPONSE")
		}
		if parsed.ID != id {
			return failure("IDENTITY_MISMATCH")
		}
		if _, err := parseBundle(id.TrustDomain(), candidate.Bundle); err != nil {
			return err
		}
		if candidate.SpiffeId == s.expected.String() {
			if selected != nil {
				return failure("IDENTITY_MISMATCH")
			}
			selected = candidate
		}
	}
	if selected == nil {
		return failure("IDENTITY_MISMATCH")
	}
	if len(selected.X509Svid) == 0 || len(selected.X509SvidKey) == 0 || len(selected.Bundle) == 0 {
		return failure("INVALID_RESPONSE")
	}
	for _, crl := range response.Crl {
		if len(crl) == 0 {
			return failure("INVALID_RESPONSE")
		}
	}
	for id, raw := range response.FederatedBundles {
		td, err := spiffeid.TrustDomainFromString(id)
		if err != nil || len(id) > 2048 || td.ID().String() != id {
			return failure("INVALID_RESPONSE")
		}
		if _, err := parseBundle(td, raw); err != nil {
			return err
		}
	}
	// Selection is by configured identity, not operator hints. After validating
	// all entries, suppress the SDK's hint filter so it cannot hide that identity.
	for _, candidate := range response.Svids {
		candidate.Hint = ""
	}
	pending := &wireSnapshot{certificates: bytes.Clone(selected.X509Svid), key: bytes.Clone(selected.X509SvidKey), bundle: bytes.Clone(selected.Bundle), crls: cloneBytes(response.Crl)}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.terminal != nil {
		clear(pending.key)
		return s.terminal
	}
	if s.pending != nil {
		clear(s.pending.key)
	}
	s.pending = pending
	return nil
}
