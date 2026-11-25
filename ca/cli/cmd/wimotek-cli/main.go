package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/wimotek/cli/internal/certutil"
	"github.com/wimotek/cli/internal/client"
	"github.com/wimotek/cli/internal/config"
	"github.com/wimotek/cli/internal/renewer"
	"github.com/wimotek/cli/internal/webui"
)

// Version is overridden at build time via -ldflags "-X main.Version=..."
var Version = "v1.0.0-dev"

type stringSliceFlag []string

func (s *stringSliceFlag) String() string { return strings.Join(*s, ",") }
func (s *stringSliceFlag) Set(v string) error {
	for _, part := range strings.Split(v, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			*s = append(*s, trimmed)
		}
	}
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		printRootHelp()
		return nil
	}
	cmd := args[0]
	rest := args[1:]
	switch cmd {
	case "ca":
		return runCA(rest)
	case "certificate", "cert":
		return runCertificate(rest)
	case "crypto":
		return runCrypto(rest)
	case "context":
		return runContext(rest)
	case "web":
		return runWeb(rest)
	case "version", "-v", "--version":
		fmt.Printf("wimotek-cli %s (step-aligned PKI client + embedded Web Manager)\n", Version)
		return nil
	case "help", "-h", "--help":
		printRootHelp()
		return nil
	default:
		return fmt.Errorf("unknown command %q (run 'wimotek-cli help')", cmd)
	}
}

func printRootHelp() {
	fmt.Print(`wimotek-cli - Enterprise PKI Client aligned with Smallstep (step) CLI + Embedded Web Manager

Usage:
  wimotek-cli <command> [subcommand] [flags]

Commands:
  ca           Interact with a wimotek/ca server (bootstrap, root, health, token, certificate, sign, renew, revoke, crl, list)
  certificate  Local X.509 certificate utilities (inspect, verify, needs-renewal, fingerprint, create, p12, install, format, bundle)
  crypto       Cryptographic primitives (keypair, rand)
  context      Manage multiple CA contexts (list, select, current, remove)
  web          Launch embedded Web Management Console + background auto-renewal daemon
  version      Print client version
`)
}

// ============================================================================
// `wimotek-cli ca ...`
// ============================================================================

func runCA(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Print(`Usage: wimotek-cli ca <subcommand> [flags]

Subcommands:
  bootstrap    Fetch Root CA, verify SHA-256 fingerprint, save context & optionally install OS trust
  root         Download Root CA PEM from server
  health       Check CA server health endpoint
  token        Authenticate via username/password (auto PoW) or save a wca_ provisioner token
  certificate  Generate key locally, submit CSR, save cert/key & track for auto-renewal
  sign         Submit an existing CSR file to the CA and write signed certificate chain
  renew        Renew a certificate/key pair (supports --daemon for automated renewal)
  revoke       Revoke a certificate by serial number
  crl          Download Issuing CA CRL (DER or PEM)
  list         List certificates from the CA server
`)
		return nil
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "bootstrap":
		return runCABootstrap(rest)
	case "root":
		return runCARoot(rest)
	case "health":
		return runCAHealth(rest)
	case "token":
		return runCAToken(rest)
	case "certificate", "cert":
		return runCACertificate(rest)
	case "sign":
		return runCASign(rest)
	case "renew":
		return runCARenew(rest)
	case "revoke":
		return runCARevoke(rest)
	case "crl":
		return runCACRL(rest)
	case "list":
		return runCAList(rest)
	default:
		return fmt.Errorf("unknown ca subcommand %q", sub)
	}
}

func runCABootstrap(args []string) error {
	fs := flag.NewFlagSet("ca bootstrap", flag.ContinueOnError)
	caURL := fs.String("ca-url", "", "CA server URL (e.g. https://ca.company.internal:8443)")
	fp := fs.String("fingerprint", "", "Expected Root CA SHA-256 hex fingerprint")
	ctxName := fs.String("context", "default", "Context name to save")
	token := fs.String("token", "", "Optional Provisioner token (wca_...) or Bearer token")
	insecure := fs.Bool("insecure", false, "Skip TLS verification during initial bootstrap")
	install := fs.Bool("install", false, "Install Root CA into OS system trust store")
	pathDir := fs.String("path", "", "Override config directory (default ~/.wimotek)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*caURL) == "" {
		return errors.New("--ca-url is required")
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	rootPEM, actualFP, err := client.FetchRoot(ctx, *caURL, *fp, *insecure)
	if err != nil {
		return err
	}
	saved, err := mgr.SaveContext(config.Context{
		Name:               *ctxName,
		CAURL:              *caURL,
		Fingerprint:        actualFP,
		Token:              *token,
		InsecureSkipVerify: *insecure,
	}, rootPEM, true)
	if err != nil {
		return err
	}
	fmt.Printf("Bootstrapped context %q (%s)\n", saved.Name, saved.CAURL)
	fmt.Printf("Root CA saved to: %s\n", saved.RootCertPath)
	fmt.Printf("SHA-256 fingerprint: %s\n", actualFP)
	if *install {
		msg, err := certutil.InstallRootTrust(saved.RootCertPath, false)
		if err != nil {
			return err
		}
		fmt.Println(msg)
	}
	return nil
}

func runCARoot(args []string) error {
	fs := flag.NewFlagSet("ca root", flag.ContinueOnError)
	caURL := fs.String("ca-url", "", "CA server URL (defaults to active context)")
	fp := fs.String("fingerprint", "", "Expected Root CA SHA-256 fingerprint")
	insecure := fs.Bool("insecure", false, "Skip TLS verification")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	url := strings.TrimSpace(*caURL)
	if url == "" {
		mgr, err := config.Open(*pathDir)
		if err != nil {
			return err
		}
		c, err := mgr.GetContext("")
		if err != nil {
			return err
		}
		url = c.CAURL
		if *fp == "" {
			*fp = c.Fingerprint
		}
		*insecure = *insecure || c.InsecureSkipVerify
	}
	rootPEM, actualFP, err := client.FetchRoot(context.Background(), url, *fp, *insecure)
	if err != nil {
		return err
	}
	if fs.NArg() > 0 {
		outPath := fs.Arg(0)
		if err := os.WriteFile(outPath, rootPEM, 0o644); err != nil {
			return err
		}
		fmt.Printf("Saved Root CA (%s) to %s\n", actualFP, outPath)
		return nil
	}
	_, err = os.Stdout.Write(rootPEM)
	return err
}

func runCAHealth(args []string) error {
	fs := flag.NewFlagSet("ca health", flag.ContinueOnError)
	ctxName := fs.String("context", "", "Context name")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)
	ctxRec, cli, err := ren.ClientForContext(*ctxName, "")
	if err != nil {
		return err
	}
	res, err := cli.Health(context.Background())
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(map[string]any{"context": ctxRec.Name, "ca_url": ctxRec.CAURL, "health": res})
}

func runCAToken(args []string) error {
	fs := flag.NewFlagSet("ca token", flag.ContinueOnError)
	ctxName := fs.String("context", "", "Context name")
	username := fs.String("username", "", "CA username for PoW login")
	password := fs.String("password", "", "CA password (or set WIMOTEK_PASSWORD env)")
	saveToken := fs.String("save-token", "", "Store an existing wca_ provisioner token directly")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)
	ctxRec, cli, err := ren.ClientForContext(*ctxName, "")
	if err != nil {
		return err
	}
	tok := strings.TrimSpace(*saveToken)
	if tok == "" {
		if strings.TrimSpace(*username) == "" {
			return errors.New("provide --username (and --password / WIMOTEK_PASSWORD) or --save-token")
		}
		pw := *password
		if pw == "" {
			pw = os.Getenv("WIMOTEK_PASSWORD")
		}
		if pw == "" {
			return errors.New("password required via --password or WIMOTEK_PASSWORD env")
		}
		tok, err = cli.LoginWithPoW(context.Background(), *username, pw)
		if err != nil {
			return err
		}
	}
	ctxRec.Token = tok
	if _, err := mgr.SaveContext(*ctxRec, nil, false); err != nil {
		return err
	}
	fmt.Printf("Saved credential (%s) for context %q\n", config.MaskSecret(tok), ctxRec.Name)
	return nil
}

func runCACertificate(args []string) error {
	fs := flag.NewFlagSet("ca certificate", flag.ContinueOnError)
	profile := fs.String("profile", "tls_server", "Certificate profile (tls_server, tls_client, entra_cba, pdf_signing, code_signing, smime_email, wifi_eap, iot_device)")
	var sans stringSliceFlag
	fs.Var(&sans, "san", "Subject Alternative Name (repeatable or comma-separated)")
	upn := fs.String("upn", "", "User Principal Name for entra_cba")
	email := fs.String("email", "", "Email SAN")
	kty := fs.String("kty", "EC", "Key type: EC, OKP, RSA")
	crv := fs.String("crv", "P-256", "EC curve: P-256, P-384")
	size := fs.Int("size", 2048, "RSA key size: 2048, 4096")
	days := fs.Int("days", 0, "Validity in days (0 = CA default)")
	renewBefore := fs.String("renew-before", "33%", "Auto-renewal threshold (e.g. 33%, 168h, 15d)")
	autoRenew := fs.Bool("auto-renew", true, "Track in managed auto-renewal list")
	ctxName := fs.String("context", "", "CA context name")
	token := fs.String("token", "", "Override token")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return errors.New("usage: wimotek-cli ca certificate <subject> [cert.crt] [cert.key] [flags]")
	}
	subject := fs.Arg(0)
	var certOut, keyOut string
	if fs.NArg() >= 2 {
		certOut = fs.Arg(1)
	}
	if fs.NArg() >= 3 {
		keyOut = fs.Arg(2)
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)
	rec, err := ren.Issue(context.Background(), renewer.IssueParams{
		ContextName:   *ctxName,
		Profile:       *profile,
		CommonName:    subject,
		SANs:          sans,
		UPN:           *upn,
		Email:         *email,
		KeyType:       *kty,
		Curve:         *crv,
		RSABits:       *size,
		ValidityDays:  *days,
		RenewBefore:   *renewBefore,
		AutoRenew:     *autoRenew,
		CertOutPath:   certOut,
		KeyOutPath:    keyOut,
		TokenOverride: *token,
	})
	if err != nil {
		return err
	}
	fmt.Printf("Issued certificate for %s (serial %s)\n", rec.CommonName, rec.SerialHex)
	fmt.Printf("  Certificate: %s\n", rec.CertPath)
	fmt.Printf("  Private Key: %s (mode 0600)\n", rec.KeyPath)
	fmt.Printf("  Expires UTC: %s\n", time.Unix(rec.NotAfter, 0).UTC().Format(time.RFC3339))
	return nil
}

func runCASign(args []string) error {
	fs := flag.NewFlagSet("ca sign", flag.ContinueOnError)
	profile := fs.String("profile", "tls_server", "Certificate profile")
	ctxName := fs.String("context", "", "CA context")
	token := fs.String("token", "", "Override token")
	days := fs.Int("days", 0, "Validity days")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 2 {
		return errors.New("usage: wimotek-cli ca sign <csr.pem> <out.crt> [--profile tls_server]")
	}
	csrRaw, err := os.ReadFile(fs.Arg(0))
	if err != nil {
		return err
	}
	info, err := certutil.InspectPEM(csrRaw)
	if err != nil {
		return err
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)
	_, cli, err := ren.ClientForContext(*ctxName, *token)
	if err != nil {
		return err
	}
	sans := append([]string{}, info.DNSNames...)
	sans = append(sans, info.IPAddresses...)
	resp, err := cli.SignCSR(context.Background(), client.SignRequest{
		Profile:      *profile,
		CommonName:   info.CommonName,
		SANs:         sans,
		CSRPEM:       string(csrRaw),
		ValidityDays: *days,
	})
	if err != nil {
		return err
	}
	out := resp.ChainPEM
	if out == "" {
		out = resp.CertPEM
	}
	if err := os.WriteFile(fs.Arg(1), []byte(out), 0o644); err != nil {
		return err
	}
	fmt.Printf("Signed CSR -> %s (serial %s)\n", fs.Arg(1), resp.SerialHex)
	return nil
}

func runCARenew(args []string) error {
	fs := flag.NewFlagSet("ca renew", flag.ContinueOnError)
	profile := fs.String("profile", "tls_server", "Certificate profile")
	expiresIn := fs.String("expires-in", "33%", "Renew when remaining lifetime <= threshold (e.g. 33%, 168h, 15d)")
	force := fs.Bool("force", false, "Force renewal even if certificate is not due yet")
	daemon := fs.Bool("daemon", false, "Keep running in foreground and renew automatically")
	interval := fs.Duration("interval", 15*time.Minute, "Daemon check interval")
	ctxName := fs.String("context", "", "CA context")
	token := fs.String("token", "", "Override token")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)

	// Mode A: Renew all managed certs when no file args passed
	if fs.NArg() == 0 {
		if !*daemon {
			renewed, failed := ren.RenewAllDue(context.Background())
			fmt.Printf("Managed renewal scan complete: renewed=%d failed=%d\n", renewed, failed)
			return nil
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		log.Printf("Starting wimotek-cli renewal daemon for all managed certificates (interval=%s)", *interval)
		ren.RenewAllDue(ctx)
		ren.StartDaemon(ctx, *interval)
		<-ctx.Done()
		return nil
	}

	if fs.NArg() < 2 {
		return errors.New("usage: wimotek-cli ca renew <cert.crt> <cert.key> [--force] [--daemon]")
	}
	certPath, keyPath := fs.Arg(0), fs.Arg(1)
	doOnce := func() error {
		resp, did, err := ren.RenewFile(context.Background(), *ctxName, *token, certPath, keyPath, *profile, *expiresIn, *force)
		if err != nil {
			return err
		}
		if did {
			fmt.Printf("Renewed %s (new serial %s)\n", certPath, resp.SerialHex)
		} else {
			fmt.Printf("Certificate %s does not need renewal yet (threshold %s)\n", certPath, *expiresIn)
		}
		return nil
	}
	if err := doOnce(); err != nil {
		return err
	}
	if !*daemon {
		return nil
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	log.Printf("Watching %s for renewal every %s", certPath, *interval)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := doOnce(); err != nil {
				log.Printf("renewal check error: %v", err)
			}
		}
	}
}

func runCARevoke(args []string) error {
	fs := flag.NewFlagSet("ca revoke", flag.ContinueOnError)
	reason := fs.Int("reason", 0, "RFC 5280 CRL reason code (0=unspecified, 1=keyCompromise, 4=superseded, 5=cessationOfOperation)")
	ctxName := fs.String("context", "", "CA context")
	token := fs.String("token", "", "Override token")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return errors.New("usage: wimotek-cli ca revoke <serial-hex> [--reason 0]")
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)
	_, cli, err := ren.ClientForContext(*ctxName, *token)
	if err != nil {
		return err
	}
	if err := cli.Revoke(context.Background(), fs.Arg(0), *reason); err != nil {
		return err
	}
	fmt.Printf("Revoked certificate serial %s\n", strings.ToUpper(fs.Arg(0)))
	return nil
}

func runCACRL(args []string) error {
	fs := flag.NewFlagSet("ca crl", flag.ContinueOnError)
	pemFmt := fs.Bool("pem", true, "Download CRL in PEM format (false = DER)")
	ctxName := fs.String("context", "", "CA context")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)
	_, cli, err := ren.ClientForContext(*ctxName, "")
	if err != nil {
		return err
	}
	raw, err := cli.FetchCRL(context.Background(), *pemFmt)
	if err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return os.WriteFile(fs.Arg(0), raw, 0o644)
	}
	_, err = os.Stdout.Write(raw)
	return err
}

func runCAList(args []string) error {
	fs := flag.NewFlagSet("ca list", flag.ContinueOnError)
	ctxName := fs.String("context", "", "CA context")
	token := fs.String("token", "", "Override token")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)
	_, cli, err := ren.ClientForContext(*ctxName, *token)
	if err != nil {
		return err
	}
	certs, err := cli.ListCertificates(context.Background())
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(certs)
}

// ============================================================================
// `wimotek-cli certificate ...`
// ============================================================================

func runCertificate(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Print(`Usage: wimotek-cli certificate <subcommand> [flags]

Subcommands:
  inspect        Decode and display X.509 certificate or CSR details
  verify         Verify a certificate chain against a Root CA and optional server name
  needs-renewal  Exit 0 if certificate needs renewal (else exit 1)
  fingerprint    Print SHA-256 fingerprint of a certificate
  create         Create an offline self-signed leaf or Root CA certificate
  p12            Package certificate + private key into Modern2023 .pfx bundle
  install        Install Root CA certificate into current OS system trust store
  format         Convert certificate between PEM and DER
  bundle         Concatenate leaf certificate + intermediate/root CA into a chain PEM
`)
		return nil
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "inspect":
		return runCertInspect(rest)
	case "verify":
		return runCertVerify(rest)
	case "needs-renewal":
		return runCertNeedsRenewal(rest)
	case "fingerprint":
		return runCertFingerprint(rest)
	case "create":
		return runCertCreate(rest)
	case "p12":
		return runCertP12(rest)
	case "install":
		return runCertInstall(rest)
	case "format":
		return runCertFormat(rest)
	case "bundle":
		return runCertBundle(rest)
	default:
		return fmt.Errorf("unknown certificate subcommand %q", sub)
	}
}

func readFileOrStdin(path string) ([]byte, error) {
	if path == "" || path == "-" {
		return io.ReadAll(io.LimitReader(os.Stdin, 2*1024*1024))
	}
	return os.ReadFile(path)
}

func runCertInspect(args []string) error {
	fs := flag.NewFlagSet("certificate inspect", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "Output JSON format")
	if err := fs.Parse(args); err != nil {
		return err
	}
	raw, err := readFileOrStdin(fs.Arg(0))
	if err != nil {
		return err
	}
	info, err := certutil.InspectPEM(raw)
	if err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(info)
	}
	fmt.Printf("Kind:        %s (CA=%v)\n", strings.ToUpper(info.Kind), info.IsCA)
	fmt.Printf("Subject:     %s\n", info.SubjectDN)
	if info.IssuerDN != "" {
		fmt.Printf("Issuer:      %s\n", info.IssuerDN)
	}
	if info.SerialColon != "" {
		fmt.Printf("Serial:      %s\n", info.SerialColon)
	}
	if info.FingerprintSHA256 != "" {
		fmt.Printf("SHA-256:     %s\n", info.FingerprintSHA256)
	}
	fmt.Printf("Key / Sig:   %s / %s\n", info.PublicKeyAlgorithm, info.SignatureAlgorithm)
	if info.NotBeforeUTC != "" {
		fmt.Printf("Validity:    %s -> %s (%d days left, %.1f%% used)\n", info.NotBeforeUTC, info.NotAfterUTC, info.RemainingDays, info.LifetimeUsedPct)
	}
	if len(info.DNSNames) > 0 {
		fmt.Printf("DNS SANs:    %s\n", strings.Join(info.DNSNames, ", "))
	}
	if len(info.IPAddresses) > 0 {
		fmt.Printf("IP SANs:     %s\n", strings.Join(info.IPAddresses, ", "))
	}
	if info.UPN != "" {
		fmt.Printf("msUPN SAN:   %s\n", info.UPN)
	}
	if len(info.ExtKeyUsages) > 0 {
		fmt.Printf("EKUs:        %s\n", strings.Join(info.ExtKeyUsages, ", "))
	}
	return nil
}

func runCertVerify(args []string) error {
	fs := flag.NewFlagSet("certificate verify", flag.ContinueOnError)
	rootsFile := fs.String("roots", "", "Root CA PEM path (defaults to active context root)")
	serverName := fs.String("server-name", "", "Expected DNS hostname")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	certRaw, err := readFileOrStdin(fs.Arg(0))
	if err != nil {
		return err
	}
	var rootsRaw []byte
	if *rootsFile != "" {
		rootsRaw, err = os.ReadFile(*rootsFile)
		if err != nil {
			return err
		}
	} else if mgr, mErr := config.Open(*pathDir); mErr == nil {
		if ctxRec, cErr := mgr.GetContext(""); cErr == nil && ctxRec.RootCertPath != "" {
			rootsRaw, _ = os.ReadFile(ctxRec.RootCertPath)
		}
	}
	res := certutil.VerifyCertificate(certRaw, rootsRaw, *serverName)
	if !res.Valid {
		return errors.New(res.Error)
	}
	fmt.Printf("OK: verified chain (%s)\n", strings.Join(res.ChainSubjects, " -> "))
	return nil
}

func runCertNeedsRenewal(args []string) error {
	fs := flag.NewFlagSet("certificate needs-renewal", flag.ContinueOnError)
	expiresIn := fs.String("expires-in", "33%", "Threshold (e.g. 33%, 168h, 15d)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	raw, err := readFileOrStdin(fs.Arg(0))
	if err != nil {
		return err
	}
	certs, err := certutil.ParseCertChainPEM(raw)
	if err != nil {
		return err
	}
	due, err := certutil.NeedsRenewal(certs[0], *expiresIn)
	if err != nil {
		return err
	}
	if due {
		fmt.Println("certificate needs renewal")
		return nil
	}
	fmt.Println("certificate does not need renewal")
	os.Exit(1)
	return nil
}

func runCertFingerprint(args []string) error {
	if len(args) < 1 {
		return errors.New("usage: wimotek-cli certificate fingerprint <cert.crt>")
	}
	raw, err := readFileOrStdin(args[0])
	if err != nil {
		return err
	}
	certs, err := certutil.ParseCertChainPEM(raw)
	if err != nil {
		return err
	}
	hexFP, _ := certutil.FingerprintSHA256(certs[0])
	fmt.Println(hexFP)
	return nil
}

func runCertCreate(args []string) error {
	fs := flag.NewFlagSet("certificate create", flag.ContinueOnError)
	var sans stringSliceFlag
	fs.Var(&sans, "san", "SAN DNS/IP/Email")
	org := fs.String("org", "", "Organization")
	days := fs.Int("days", 365, "Validity days")
	isCA := fs.Bool("ca", false, "Create self-signed Root CA")
	kty := fs.String("kty", "EC", "Key type: EC, OKP, RSA")
	crv := fs.String("crv", "P-256", "EC curve: P-256, P-384")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 3 {
		return errors.New("usage: wimotek-cli certificate create <subject> <cert.crt> <cert.key> [--ca] [--san ...]")
	}
	signer, _, privPEM, err := certutil.GenerateKeyPair(*kty, *crv, 2048)
	if err != nil {
		return err
	}
	certPEM, err := certutil.CreateSelfSignedCert(fs.Arg(0), *org, sans, time.Duration(*days)*24*time.Hour, *isCA, signer)
	if err != nil {
		return err
	}
	if err := os.WriteFile(fs.Arg(1), certPEM, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(fs.Arg(2), privPEM, 0o600); err != nil {
		return err
	}
	fmt.Printf("Created self-signed certificate %s and private key %s\n", fs.Arg(1), fs.Arg(2))
	return nil
}

func runCertP12(args []string) error {
	fs := flag.NewFlagSet("certificate p12", flag.ContinueOnError)
	password := fs.String("password", "", "PKCS#12 password")
	chainFile := fs.String("chain", "", "Optional extra CA chain PEM")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 3 {
		return errors.New("usage: wimotek-cli certificate p12 <out.pfx> <cert.crt> <cert.key> [--password ...]")
	}
	certRaw, err := os.ReadFile(fs.Arg(1))
	if err != nil {
		return err
	}
	keyRaw, err := os.ReadFile(fs.Arg(2))
	if err != nil {
		return err
	}
	var chainRaw []byte
	if *chainFile != "" {
		chainRaw, err = os.ReadFile(*chainFile)
		if err != nil {
			return err
		}
	}
	pfx, err := certutil.EncodeModernPFX(certRaw, keyRaw, chainRaw, *password)
	if err != nil {
		return err
	}
	if err := os.WriteFile(fs.Arg(0), pfx, 0o600); err != nil {
		return err
	}
	fmt.Printf("Wrote Modern2023 PKCS#12 bundle to %s\n", fs.Arg(0))
	return nil
}

func runCertInstall(args []string) error {
	fs := flag.NewFlagSet("certificate install", flag.ContinueOnError)
	dryRun := fs.Bool("dry-run", false, "Print command without modifying system trust store")
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rootPath := fs.Arg(0)
	if rootPath == "" {
		mgr, err := config.Open(*pathDir)
		if err != nil {
			return err
		}
		ctxRec, err := mgr.GetContext("")
		if err != nil {
			return err
		}
		rootPath = ctxRec.RootCertPath
	}
	msg, err := certutil.InstallRootTrust(rootPath, *dryRun)
	if err != nil {
		return err
	}
	fmt.Println(msg)
	return nil
}

func runCertFormat(args []string) error {
	fs := flag.NewFlagSet("certificate format", flag.ContinueOnError)
	outFile := fs.String("out", "", "Output file path (default stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	raw, err := readFileOrStdin(fs.Arg(0))
	if err != nil {
		return err
	}
	converted, targetFmt, err := certutil.ConvertFormat(raw)
	if err != nil {
		return err
	}
	if *outFile != "" {
		if err := os.WriteFile(*outFile, converted, 0o644); err != nil {
			return err
		}
		fmt.Printf("Converted certificate to %s (%s)\n", strings.ToUpper(targetFmt), *outFile)
		return nil
	}
	_, err = os.Stdout.Write(converted)
	return err
}

func runCertBundle(args []string) error {
	if len(args) < 3 {
		return errors.New("usage: wimotek-cli certificate bundle <leaf.crt> <ca.crt> <bundle.crt>")
	}
	leaf, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	ca, err := os.ReadFile(args[1])
	if err != nil {
		return err
	}
	joined := strings.TrimSpace(string(leaf)) + "\n" + strings.TrimSpace(string(ca)) + "\n"
	if err := os.WriteFile(args[2], []byte(joined), 0o644); err != nil {
		return err
	}
	fmt.Printf("Bundled certificate chain -> %s\n", args[2])
	return nil
}

// ============================================================================
// `wimotek-cli crypto ...`
// ============================================================================

func runCrypto(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Print("Usage: wimotek-cli crypto <keypair|rand> [flags]\n")
		return nil
	}
	switch args[0] {
	case "keypair":
		fs := flag.NewFlagSet("crypto keypair", flag.ContinueOnError)
		kty := fs.String("kty", "EC", "Key type: EC, OKP, RSA")
		crv := fs.String("crv", "P-256", "EC curve: P-256, P-384")
		size := fs.Int("size", 2048, "RSA size: 2048, 4096")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() < 2 {
			return errors.New("usage: wimotek-cli crypto keypair <pub.pem> <priv.pem> [--kty EC]")
		}
		_, pubPEM, privPEM, err := certutil.GenerateKeyPair(*kty, *crv, *size)
		if err != nil {
			return err
		}
		if err := os.WriteFile(fs.Arg(0), pubPEM, 0o644); err != nil {
			return err
		}
		if err := os.WriteFile(fs.Arg(1), privPEM, 0o600); err != nil {
			return err
		}
		fmt.Printf("Generated %s keypair: %s, %s (mode 0600)\n", strings.ToUpper(*kty), fs.Arg(0), fs.Arg(1))
		return nil
	case "rand":
		fs := flag.NewFlagSet("crypto rand", flag.ContinueOnError)
		format := fs.String("format", "hex", "Format: hex, base64, alphanumeric")
		length := fs.Int("length", 32, "Output length")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		v, err := certutil.RandomString(*format, *length)
		if err != nil {
			return err
		}
		fmt.Println(v)
		return nil
	default:
		return fmt.Errorf("unknown crypto subcommand %q", args[0])
	}
}

// ============================================================================
// `wimotek-cli context ...`
// ============================================================================

func runContext(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Print("Usage: wimotek-cli context <list|select|current|remove> [name]\n")
		return nil
	}
	fs := flag.NewFlagSet("context", flag.ContinueOnError)
	pathDir := fs.String("path", "", "Override config directory")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		cur, list, err := mgr.ListContexts(true)
		if err != nil {
			return err
		}
		if len(list) == 0 {
			fmt.Println("No CA contexts configured.")
			return nil
		}
		for _, c := range list {
			mark := " "
			if c.Name == cur {
				mark = "*"
			}
			fmt.Printf("%s %-16s %s  (fp:%s)\n", mark, c.Name, c.CAURL, c.Fingerprint)
		}
		return nil
	case "current":
		c, err := mgr.GetContext("")
		if err != nil {
			return err
		}
		fmt.Printf("%s (%s)\n", c.Name, c.CAURL)
		return nil
	case "select":
		if fs.NArg() < 1 {
			return errors.New("usage: wimotek-cli context select <name>")
		}
		c, err := mgr.SelectContext(fs.Arg(0))
		if err != nil {
			return err
		}
		fmt.Printf("Active context set to %q (%s)\n", c.Name, c.CAURL)
		return nil
	case "remove":
		if fs.NArg() < 1 {
			return errors.New("usage: wimotek-cli context remove <name>")
		}
		if err := mgr.RemoveContext(fs.Arg(0)); err != nil {
			return err
		}
		fmt.Printf("Removed context %q\n", fs.Arg(0))
		return nil
	default:
		return fmt.Errorf("unknown context subcommand %q", args[0])
	}
}

// ============================================================================
// `wimotek-cli web ...`
// ============================================================================

func runWeb(args []string) error {
	fs := flag.NewFlagSet("web", flag.ContinueOnError)
	listen := fs.String("listen", envOr("WIMOTEK_CLI_LISTEN", "127.0.0.1:9443"), "Listen address (defaults to localhost)")
	webPass := fs.String("web-password", os.Getenv("WIMOTEK_CLI_WEB_PASSWORD"), "Optional password protecting Web UI & APIs")
	interval := fs.Duration("auto-renew-interval", 15*time.Minute, "Background renewal scan interval (0 to disable)")
	pathDir := fs.String("path", "", "Override config directory (default ~/.wimotek)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		return fmt.Errorf("invalid --listen address %q: %w", *listen, err)
	}
	if !isLoopbackHost(host) && strings.TrimSpace(*webPass) == "" {
		return errors.New("refusing to bind Web Management Console to non-loopback address without --web-password / WIMOTEK_CLI_WEB_PASSWORD")
	}

	mgr, err := config.Open(*pathDir)
	if err != nil {
		return err
	}
	ren := renewer.New(mgr)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *interval > 0 {
		ren.StartDaemon(ctx, *interval)
		log.Printf("[wimotek-cli] background auto-renewal daemon active (interval=%s)", *interval)
	}

	srv := webui.NewServer(webui.Options{
		Manager:     mgr,
		Renewer:     ren,
		WebPassword: *webPass,
		Version:     Version,
	})
	httpSrv := &http.Server{
		Addr:              *listen,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	}()

	log.Printf("[wimotek-cli] Web Management Console listening on http://%s (config dir: %s)", *listen, mgr.BaseDir)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func isLoopbackHost(host string) bool {
	h := strings.TrimSpace(strings.ToLower(host))
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func envOr(k, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return fallback
}
