package identity_test

import (
	"context"
	"os"
	"testing"
	"time"

	identity "github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
)

// TestRealSPIRE requires an independently provisioned/attested real SPIRE
// workload. It never fabricates an identity or turns fixture success into live
// attestation evidence. Credentials remain in memory and are never logged.
func TestRealSPIRE(t *testing.T) {
	path := os.Getenv("OCC_TEST_SPIFFE_SOCKET_PATH")
	id := os.Getenv("OCC_TEST_SPIFFE_ID")
	aud := os.Getenv("OCC_TEST_SPIFFE_AUDIENCE")
	if path == "" && id == "" && aud == "" {
		t.Skip("real SPIRE not selected: set OCC_TEST_SPIFFE_SOCKET_PATH, OCC_TEST_SPIFFE_ID, and OCC_TEST_SPIFFE_AUDIENCE")
	}
	if path == "" || id == "" || aud == "" {
		t.Fatal("partial real SPIRE configuration: all three OCC_TEST_SPIFFE_* settings are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	source, err := identity.NewSource(identity.Options{SocketPath: path, ExpectedSPIFFEID: id, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("source configuration failed: %v", err)
	}
	defer source.Close()
	if err = source.Start(ctx); err != nil {
		t.Fatalf("real SPIRE startup failed: %v", err)
	}
	m, err := source.Metadata()
	if err != nil {
		t.Fatalf("real SPIRE metadata failed: %v", err)
	}
	if m.SPIFFEID != id || m.CertificateCount < 1 || m.BundleCertificateCount < 1 || !m.ExpiresAt.After(time.Now()) {
		t.Fatal("real SPIRE metadata did not satisfy expected identity and validity")
	}
	jwt, err := source.FetchJWTSVID(ctx, aud)
	if err != nil {
		t.Fatalf("real SPIRE JWT fetch failed: %v", err)
	}
	result, err := source.ValidateJWTSVID(ctx, jwt.Token, aud, id)
	if err != nil {
		t.Fatalf("real SPIRE JWT validation failed: %v", err)
	}
	if result.SPIFFEID != id || !result.ExpiresAt.After(time.Now()) {
		t.Fatal("real SPIRE validation returned unexpected identity or expiry")
	}
	if _, err = source.ValidateJWTSVID(ctx, jwt.Token, aud+"-wrong-audience", id); err == nil {
		t.Fatal("real SPIRE accepted a token for an unrequested audience")
	}
}
