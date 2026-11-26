package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// OWASP recommended Argon2id minimum parameters (19 MiB, t=2, p=1) — resistant to GPU/ASIC
// cracking while remaining safe for low-memory Docker containers (VerifyPasswordArgon2id reads
// m, t, p dynamically from each stored PHC string so existing 64 MiB hashes remain fully valid).
const (
	argonMemory  uint32 = 19 * 1024 // 19 MiB
	argonTime    uint32 = 2
	argonThreads uint8  = 1
	argonKeyLen  uint32 = 32
)

func HashPasswordArgon2id(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		argonMemory,
		argonTime,
		argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	), nil
}

func VerifyPasswordArgon2id(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("invalid argon2id PHC format")
	}
	var mem, iter uint32
	var par uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &iter, &par); err != nil {
		return false, err
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	computed := argon2.IDKey([]byte(password), salt, iter, mem, par, uint32(len(expected)))
	return subtle.ConstantTimeCompare(computed, expected) == 1, nil
}
