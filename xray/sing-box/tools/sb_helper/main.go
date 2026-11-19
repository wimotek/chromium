package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type statEntry struct {
	Name  string `json:"name"`
	Value int64  `json:"value"`
}

type statsOutput struct {
	Stat []statEntry `json:"stat"`
}

func appendVarint(dst []byte, v uint64) []byte {
	var buf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(buf[:], v)
	return append(dst, buf[:n]...)
}

func encodeQueryStatsRequest(pattern string, reset bool) []byte {
	var payload []byte
	if pattern != "" {
		payload = append(payload, 0x0a) // field 1, wire type 2 (length-delimited string)
		payload = appendVarint(payload, uint64(len(pattern)))
		payload = append(payload, pattern...)
	}
	if reset {
		payload = append(payload, 0x10, 0x01) // field 2, wire type 0 (bool = true)
	}
	frame := make([]byte, 5+len(payload))
	frame[0] = 0 // uncompressed gRPC frame
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(payload)))
	copy(frame[5:], payload)
	return frame
}

func decodeStatMessage(b []byte) (statEntry, error) {
	var entry statEntry
	for len(b) > 0 {
		tag, n := binary.Uvarint(b)
		if n <= 0 {
			return entry, errors.New("invalid stat tag")
		}
		b = b[n:]
		fieldNum := tag >> 3
		wireType := tag & 0x7
		switch wireType {
		case 0: // varint
			v, vn := binary.Uvarint(b)
			if vn <= 0 {
				return entry, errors.New("invalid varint")
			}
			b = b[vn:]
			if fieldNum == 2 {
				entry.Value = int64(v)
			}
		case 2: // length-delimited
			l, ln := binary.Uvarint(b)
			if ln <= 0 || uint64(len(b)-ln) < l {
				return entry, errors.New("invalid length-delimited field")
			}
			b = b[ln:]
			chunk := b[:l]
			b = b[l:]
			if fieldNum == 1 {
				entry.Name = string(chunk)
			}
		case 1: // 64-bit
			if len(b) < 8 {
				return entry, errors.New("truncated 64-bit field")
			}
			b = b[8:]
		case 5: // 32-bit
			if len(b) < 4 {
				return entry, errors.New("truncated 32-bit field")
			}
			b = b[4:]
		default:
			return entry, fmt.Errorf("unsupported wire type %d", wireType)
		}
	}
	return entry, nil
}

func decodeQueryStatsResponse(raw []byte) ([]statEntry, error) {
	var entries []statEntry
	for len(raw) >= 5 {
		compressed := raw[0]
		msgLen := binary.BigEndian.Uint32(raw[1:5])
		raw = raw[5:]
		if uint32(len(raw)) < msgLen {
			return nil, errors.New("truncated gRPC frame")
		}
		msg := raw[:msgLen]
		raw = raw[msgLen:]
		if compressed != 0 {
			return nil, errors.New("compressed gRPC response unsupported")
		}
		for len(msg) > 0 {
			tag, n := binary.Uvarint(msg)
			if n <= 0 {
				return nil, errors.New("invalid response tag")
			}
			msg = msg[n:]
			fieldNum := tag >> 3
			wireType := tag & 0x7
			switch wireType {
			case 2:
				l, ln := binary.Uvarint(msg)
				if ln <= 0 || uint64(len(msg)-ln) < l {
					return nil, errors.New("invalid response length")
				}
				msg = msg[ln:]
				chunk := msg[:l]
				msg = msg[l:]
				if fieldNum == 1 {
					st, err := decodeStatMessage(chunk)
					if err != nil {
						return nil, err
					}
					if st.Name != "" {
						entries = append(entries, st)
					}
				}
			case 0:
				_, vn := binary.Uvarint(msg)
				if vn <= 0 {
					return nil, errors.New("invalid varint in response")
				}
				msg = msg[vn:]
			case 1:
				if len(msg) < 8 {
					return nil, errors.New("truncated 64-bit in response")
				}
				msg = msg[8:]
			case 5:
				if len(msg) < 4 {
					return nil, errors.New("truncated 32-bit in response")
				}
				msg = msg[4:]
			default:
				return nil, fmt.Errorf("unsupported response wire type %d", wireType)
			}
		}
	}
	return entries, nil
}

func cmdStats(args []string) error {
	fs := flag.NewFlagSet("stats", flag.ContinueOnError)
	server := fs.String("server", "127.0.0.1:10085", "v2ray_api listen address")
	pattern := fs.String("pattern", "user>>>", "stats query pattern")
	reset := fs.Bool("reset", true, "reset counters after query")
	timeout := fs.Duration("timeout", 4*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		return err
	}

	protocols := new(http.Protocols)
	protocols.SetUnencryptedHTTP2(true)
	client := &http.Client{
		Timeout: *timeout,
		Transport: &http.Transport{
			Protocols: protocols,
		},
	}

	reqBody := encodeQueryStatsRequest(*pattern, *reset)
	url := fmt.Sprintf("http://%s/v2ray.core.app.stats.command.StatsService/QueryStats", strings.TrimPrefix(*server, "http://"))
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/grpc")
	req.Header.Set("TE", "trailers")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected HTTP status %d", resp.StatusCode)
	}
	if grpcStatus := resp.Trailer.Get("Grpc-Status"); grpcStatus != "" && grpcStatus != "0" {
		return fmt.Errorf("grpc error status=%s msg=%s", grpcStatus, resp.Trailer.Get("Grpc-Message"))
	}
	if grpcStatus := resp.Header.Get("Grpc-Status"); grpcStatus != "" && grpcStatus != "0" {
		return fmt.Errorf("grpc error status=%s msg=%s", grpcStatus, resp.Header.Get("Grpc-Message"))
	}

	entries, err := decodeQueryStatsResponse(body)
	if err != nil {
		return err
	}
	if entries == nil {
		entries = []statEntry{}
	}
	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(statsOutput{Stat: entries})
}

func cmdGenCert(args []string) error {
	fs := flag.NewFlagSet("gencert", flag.ContinueOnError)
	sni := fs.String("sni", "www.bing.com", "certificate CN and SAN DNSName")
	certPath := fs.String("cert", "/data/hy2_cert.pem", "output PEM cert path")
	keyPath := fs.String("key", "/data/hy2_key.pem", "output PEM key path")
	days := fs.Int("days", 3650, "validity in days")
	if err := fs.Parse(args); err != nil {
		return err
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return err
	}

	host := strings.TrimSpace(*sni)
	if host == "" {
		host = "www.bing.com"
	}
	notBefore := time.Now().Add(-10 * time.Minute)
	tmpl := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			CommonName: host,
		},
		NotBefore:             notBefore,
		NotAfter:              notBefore.Add(time.Duration(*days) * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{host},
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(*certPath), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(*keyPath), 0o755); err != nil {
		return err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := os.WriteFile(*certPath, certPEM, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(*keyPath, keyPEM, 0o600); err != nil {
		return err
	}
	return nil
}

func cmdX25519Pub(args []string) error {
	fs := flag.NewFlagSet("x25519-pub", flag.ContinueOnError)
	privB64 := fs.String("private", "", "base64url encoded X25519 private key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rawStr := strings.TrimSpace(*privB64)
	if rawStr == "" {
		return errors.New("missing --private")
	}
	rawKey, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(rawStr, "="))
	if err != nil {
		rawKey, err = base64.StdEncoding.DecodeString(rawStr)
		if err != nil {
			return err
		}
	}
	privKey, err := ecdh.X25519().NewPrivateKey(rawKey)
	if err != nil {
		return err
	}
	pubB64 := base64.RawURLEncoding.EncodeToString(privKey.PublicKey().Bytes())
	fmt.Println(pubB64)
	return nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: sb-helper <stats|gencert|x25519-pub> [flags]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "stats":
		err = cmdStats(os.Args[2:])
	case "gencert":
		err = cmdGenCert(os.Args[2:])
	case "x25519-pub":
		err = cmdX25519Pub(os.Args[2:])
	default:
		err = fmt.Errorf("unknown subcommand: %s", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
