package identity

import (
	"bytes"
	"context"
	"math"
	"time"

	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"google.golang.org/grpc"
)

// Wire guards retain complete response material the SDK does not expose (CRLs)
// and reject ambiguity before SDK hint selection. All SVID parsing stays in SDK.
type wireSnapshot struct {
	certificates, key, bundle []byte
	crls                      [][]byte
	federated                 map[string][]byte
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
	pending := &wireSnapshot{certificates: bytes.Clone(selected.X509Svid), key: bytes.Clone(selected.X509SvidKey), bundle: bytes.Clone(selected.Bundle), crls: cloneBytes(response.Crl), federated: make(map[string][]byte, len(response.FederatedBundles))}
	for id, bundle := range response.FederatedBundles {
		pending.federated[id] = bytes.Clone(bundle)
	}
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

type validationKey struct{}
type fetchSelectionKey struct{}
type fetchSelection struct{ token string }
type validationExpectation struct{ spiffeID, audience string }

func (s *Source) unaryInterceptor(ctx context.Context, method string, request, reply any, cc *grpc.ClientConn, invoke grpc.UnaryInvoker, options ...grpc.CallOption) error {
	if err := invoke(ctx, method, request, reply, cc, options...); err != nil {
		return err
	}
	switch response := reply.(type) {
	case *workload.JWTSVIDResponse:
		selection, ok := ctx.Value(fetchSelectionKey{}).(*fetchSelection)
		if !ok {
			return failure("INVALID_RESPONSE")
		}
		if len(response.Svids) > maxEntries {
			return failure("INVALID_RESPONSE")
		}
		params, ok := request.(*workload.JWTSVIDRequest)
		if !ok {
			return failure("INVALID_RESPONSE")
		}
		seen := make(map[spiffeid.ID]bool, len(response.Svids))
		count := 0
		for _, candidate := range response.Svids {
			if candidate == nil || len(candidate.Svid) == 0 || len(candidate.Svid) > maxTokenBytes {
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
			parsed, err := jwtsvid.ParseInsecure(candidate.Svid, params.Audience)
			if err != nil {
				return failure("INVALID_RESPONSE")
			}
			if parsed.ID != id {
				return failure("IDENTITY_MISMATCH")
			}
			if candidate.SpiffeId == s.expected.String() {
				count++
				selection.token = candidate.Svid
			}
		}
		if count != 1 {
			return failure("IDENTITY_MISMATCH")
		}
		for _, candidate := range response.Svids {
			candidate.Hint = ""
		}
	case *workload.ValidateJWTSVIDResponse:
		expected, ok := ctx.Value(validationKey{}).(validationExpectation)
		if !ok || response.SpiffeId != expected.spiffeID {
			return failure("IDENTITY_MISMATCH")
		}
		claims := response.Claims.AsMap()
		if claims["sub"] != expected.spiffeID {
			return failure("IDENTITY_MISMATCH")
		}
		audiences, ok := claims["aud"].([]any)
		if !ok || len(audiences) > maxEntries {
			return failure("INVALID_RESPONSE")
		}
		matches := false
		for _, audience := range audiences {
			if audience == expected.audience {
				matches = true
			}
		}
		if !matches {
			return failure("IDENTITY_MISMATCH")
		}
		exp, ok := claims["exp"].(float64)
		if !ok || math.IsNaN(exp) || math.IsInf(exp, 0) || exp != math.Trunc(exp) || exp <= 0 || exp > 253402300799 {
			return failure("INVALID_RESPONSE")
		}
		if !time.Now().Before(time.Unix(int64(exp), 0)) {
			return failure("EXPIRED")
		}
	default:
		return failure("INVALID_RESPONSE")
	}
	return nil
}
