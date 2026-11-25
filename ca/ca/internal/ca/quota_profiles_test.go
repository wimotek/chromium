package ca_test

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/wimotek/ca/internal/ca"
	"github.com/wimotek/ca/internal/cache"
	"github.com/wimotek/ca/internal/store"
)

func TestConcurrentQuotaAndExpandedProfiles(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer st.Close()
	hc := cache.NewHybridCache(st, cache.RedisConfig{})
	defer hc.Close()

	eng, err := ca.NewEngine(ctx, st, hc, ca.Config{
		OrgName:   "Concurrency Corp",
		BaseURL:   "https://ca.concurrency.test",
		MasterKey: []byte("0123456789abcdef0123456789abcdef"),
	})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	// 1. Verify all 5 expanded enterprise templates + Subject C/ST/L profile fields
	profiles := []struct {
		req ca.IssueRequest
		eku x509.ExtKeyUsage
	}{
		{
			req: ca.IssueRequest{
				Profile: ca.ProfileTLSClient, CommonName: "vpn-alice", Email: "alice@example.com",
				Country: "US", Province: "California", Locality: "San Francisco", IssuedBy: "admin", MaxQuota: -1,
			},
			eku: x509.ExtKeyUsageClientAuth,
		},
		{
			req: ca.IssueRequest{
				Profile: ca.ProfileCodeSigning, CommonName: "Build Pipeline Signer", Email: "ci@example.com",
				Country: "DE", Province: "Bavaria", Locality: "Munich", IssuedBy: "admin", MaxQuota: -1,
			},
			eku: x509.ExtKeyUsageCodeSigning,
		},
		{
			req: ca.IssueRequest{
				Profile: ca.ProfileSMIMEEmail, CommonName: "Jane Doe", Email: "jane@example.com",
				Country: "CN", Province: "Shanghai", Locality: "Pudong", IssuedBy: "admin", MaxQuota: -1,
			},
			eku: x509.ExtKeyUsageEmailProtection,
		},
		{
			req: ca.IssueRequest{
				Profile: ca.ProfileWiFiEAP, CommonName: "laptop-01", UPN: "alice@example.com", Email: "alice@example.com",
				IssuedBy: "admin", MaxQuota: -1,
			},
			eku: x509.ExtKeyUsageClientAuth,
		},
		{
			req: ca.IssueRequest{
				Profile: ca.ProfileIoTDevice, CommonName: "sensor-gw-01.iot.local", SANs: []string{"sensor-gw-01.iot.local", "10.99.0.5"},
				IssuedBy: "admin", MaxQuota: -1,
			},
			eku: x509.ExtKeyUsageClientAuth,
		},
	}

	for _, tc := range profiles {
		res, err := eng.Issue(ctx, tc.req)
		if err != nil {
			t.Fatalf("issue profile %s failed: %v", tc.req.Profile, err)
		}
		blk, _ := pem.Decode([]byte(res.Record.CertPEM))
		crt, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			t.Fatalf("parse cert %s: %v", tc.req.Profile, err)
		}
		foundEKU := false
		for _, e := range crt.ExtKeyUsage {
			if e == tc.eku {
				foundEKU = true
			}
		}
		if !foundEKU {
			t.Fatalf("profile %s missing expected EKU %v (got %v)", tc.req.Profile, tc.eku, crt.ExtKeyUsage)
		}
		if tc.req.Country != "" && (len(crt.Subject.Country) == 0 || crt.Subject.Country[0] != tc.req.Country) {
			t.Fatalf("profile %s missing Country %s", tc.req.Profile, tc.req.Country)
		}
	}

	// 2. Concurrency stress test: 8 concurrent goroutines issuing for basic user with quota=3
	// Atomic WithTx + SQLite WriteDB MaxOpenConns=1 MUST allow EXACTLY 3 and reject 5 with ErrQuotaExceeded.
	var succeeded atomic.Int32
	var rejected atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, err := eng.Issue(ctx, ca.IssueRequest{
				Profile:    ca.ProfileTLSClient,
				CommonName: fmt.Sprintf("bob-device-%d", idx),
				IssuedBy:   "bob",
				MaxQuota:   3,
			})
			if err == nil {
				succeeded.Add(1)
			} else if errors.Is(err, store.ErrQuotaExceeded) {
				rejected.Add(1)
			} else {
				t.Errorf("unexpected error during concurrent quota issue: %v", err)
			}
		}(i)
	}
	wg.Wait()

	if succeeded.Load() != 3 || rejected.Load() != 5 {
		t.Fatalf("expected exactly 3 succeeded and 5 quota-rejected, got succeeded=%d rejected=%d", succeeded.Load(), rejected.Load())
	}
}
