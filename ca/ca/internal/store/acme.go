package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ACMEEABRecord stores a user's External Account Binding (RFC 8555 §7.3.4) credential.
type ACMEEABRecord struct {
	KID           string `json:"kid"`
	OwnerUsername string `json:"owner_username"`
	Label         string `json:"label"`
	HMACKeyEnc    string `json:"-"`
	HMACPrefix    string `json:"hmac_prefix"`
	BoundCount    int    `json:"bound_count"`
	LastUsedAt    int64  `json:"last_used_at"`
	Enabled       bool   `json:"enabled"`
	CreatedAt     int64  `json:"created_at"`
}

// ACMEAccountRecord stores an RFC 8555 ACME client account bound via EAB.
type ACMEAccountRecord struct {
	ID            string `json:"id"`
	OwnerUsername string `json:"owner_username"`
	EABKID        string `json:"eab_kid"`
	JWKThumbprint string `json:"jwk_thumbprint"`
	JWKJSON       string `json:"-"`
	ContactsJSON  string `json:"contacts_json"`
	Status        string `json:"status"`
	CreatedAt     int64  `json:"created_at"`
}

// ACMEOrderRecord stores an RFC 8555 ACME certificate order.
type ACMEOrderRecord struct {
	ID              string `json:"id"`
	AccountID       string `json:"account_id"`
	OwnerUsername   string `json:"owner_username"`
	Status          string `json:"status"`
	IdentifiersJSON string `json:"identifiers_json"`
	ExpiresAt       int64  `json:"expires_at"`
	CertSerial      string `json:"cert_serial"`
	ErrorJSON       string `json:"error_json"`
	CreatedAt       int64  `json:"created_at"`
}

// ACMEAuthorizationRecord stores an RFC 8555 identifier authorization and its HTTP-01/DNS-01 challenges.
type ACMEAuthorizationRecord struct {
	ID              string `json:"id"`
	OrderID         string `json:"order_id"`
	AccountID       string `json:"account_id"`
	IdentifierType  string `json:"identifier_type"`
	IdentifierValue string `json:"identifier_value"`
	Wildcard        bool   `json:"wildcard"`
	Status          string `json:"status"`
	ExpiresAt       int64  `json:"expires_at"`
	ChallengesJSON  string `json:"challenges_json"`
	CreatedAt       int64  `json:"created_at"`
}

// InsertACMEEAB persists a new EAB credential inside WithTx.
func (s *Store) InsertACMEEAB(ctx context.Context, rec ACMEEABRecord) error {
	enabled := 0
	if rec.Enabled {
		enabled = 1
	}
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO acme_eab_credentials (kid, owner_username, label, hmac_key_enc, hmac_prefix, bound_count, last_used_at, enabled, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.KID, rec.OwnerUsername, rec.Label, rec.HMACKeyEnc, rec.HMACPrefix, rec.BoundCount, rec.LastUsedAt, enabled, rec.CreatedAt)
		return err
	})
}

// GetACMEEAB fetches a single EAB credential by KID.
func (s *Store) GetACMEEAB(ctx context.Context, kid string) (*ACMEEABRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT kid, owner_username, label, hmac_key_enc, hmac_prefix, bound_count, last_used_at, enabled, created_at
		FROM acme_eab_credentials WHERE kid = ?
	`, kid)
	var r ACMEEABRecord
	var enabled int
	if err := row.Scan(&r.KID, &r.OwnerUsername, &r.Label, &r.HMACKeyEnc, &r.HMACPrefix, &r.BoundCount, &r.LastUsedAt, &enabled, &r.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Enabled = enabled == 1
	return &r, nil
}

// ListACMEEAB lists EAB credentials (filtered by owner when ownerUsername != "").
func (s *Store) ListACMEEAB(ctx context.Context, ownerUsername string) ([]ACMEEABRecord, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if ownerUsername != "" {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT kid, owner_username, label, hmac_key_enc, hmac_prefix, bound_count, last_used_at, enabled, created_at
			FROM acme_eab_credentials WHERE owner_username = ? ORDER BY created_at DESC
		`, ownerUsername)
	} else {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT kid, owner_username, label, hmac_key_enc, hmac_prefix, bound_count, last_used_at, enabled, created_at
			FROM acme_eab_credentials ORDER BY created_at DESC
		`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ACMEEABRecord, 0)
	for rows.Next() {
		var r ACMEEABRecord
		var enabled int
		if err := rows.Scan(&r.KID, &r.OwnerUsername, &r.Label, &r.HMACKeyEnc, &r.HMACPrefix, &r.BoundCount, &r.LastUsedAt, &enabled, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Enabled = enabled == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// TouchACMEEABUsage increments bound_count and updates last_used_at when an ACME client registers with an EAB credential.
func (s *Store) TouchACMEEABUsage(ctx context.Context, kid string) error {
	now := time.Now().Unix()
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE acme_eab_credentials SET bound_count = bound_count + 1, last_used_at = ?
			WHERE kid = ?
		`, now, kid)
		return err
	})
}

// DeleteACMEEAB removes an EAB credential by KID.
func (s *Store) DeleteACMEEAB(ctx context.Context, kid string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM acme_eab_credentials WHERE kid = ?`, kid)
		return err
	})
}

// InsertACMEAccount persists a new ACME account.
func (s *Store) InsertACMEAccount(ctx context.Context, rec ACMEAccountRecord) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO acme_accounts (id, owner_username, eab_kid, jwk_thumbprint, jwk_json, contacts_json, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`, rec.ID, rec.OwnerUsername, rec.EABKID, rec.JWKThumbprint, rec.JWKJSON, rec.ContactsJSON, rec.Status, rec.CreatedAt)
		return err
	})
}

// GetACMEAccountByID fetches an ACME account by ID.
func (s *Store) GetACMEAccountByID(ctx context.Context, id string) (*ACMEAccountRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, owner_username, eab_kid, jwk_thumbprint, jwk_json, contacts_json, status, created_at
		FROM acme_accounts WHERE id = ?
	`, id)
	var r ACMEAccountRecord
	if err := row.Scan(&r.ID, &r.OwnerUsername, &r.EABKID, &r.JWKThumbprint, &r.JWKJSON, &r.ContactsJSON, &r.Status, &r.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// GetACMEAccountByThumbprint fetches an ACME account by RFC 7638 JWK SHA-256 thumbprint.
func (s *Store) GetACMEAccountByThumbprint(ctx context.Context, thumbprint string) (*ACMEAccountRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, owner_username, eab_kid, jwk_thumbprint, jwk_json, contacts_json, status, created_at
		FROM acme_accounts WHERE jwk_thumbprint = ?
	`, thumbprint)
	var r ACMEAccountRecord
	if err := row.Scan(&r.ID, &r.OwnerUsername, &r.EABKID, &r.JWKThumbprint, &r.JWKJSON, &r.ContactsJSON, &r.Status, &r.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// UpdateACMEAccount updates contacts and status for an existing ACME account.
func (s *Store) UpdateACMEAccount(ctx context.Context, id, contactsJSON, status string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE acme_accounts SET contacts_json = ?, status = ? WHERE id = ?
		`, contactsJSON, status, id)
		return err
	})
}

// UpdateACMEAccountKey rotates the JWK and thumbprint for an existing ACME account (RFC 8555 §7.3.5).
func (s *Store) UpdateACMEAccountKey(ctx context.Context, id, thumbprint, jwkJSON string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE acme_accounts SET jwk_thumbprint = ?, jwk_json = ? WHERE id = ?
		`, thumbprint, jwkJSON, id)
		return err
	})
}

// ListACMEAccounts lists ACME accounts (filtered by owner when ownerUsername != "").
func (s *Store) ListACMEAccounts(ctx context.Context, ownerUsername string) ([]ACMEAccountRecord, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if ownerUsername != "" {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, owner_username, eab_kid, jwk_thumbprint, jwk_json, contacts_json, status, created_at
			FROM acme_accounts WHERE owner_username = ? ORDER BY created_at DESC LIMIT 100
		`, ownerUsername)
	} else {
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, owner_username, eab_kid, jwk_thumbprint, jwk_json, contacts_json, status, created_at
			FROM acme_accounts ORDER BY created_at DESC LIMIT 100
		`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ACMEAccountRecord, 0)
	for rows.Next() {
		var r ACMEAccountRecord
		if err := rows.Scan(&r.ID, &r.OwnerUsername, &r.EABKID, &r.JWKThumbprint, &r.JWKJSON, &r.ContactsJSON, &r.Status, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// InsertACMEOrder persists a new ACME order and its initial authorizations atomically.
func (s *Store) InsertACMEOrder(ctx context.Context, order ACMEOrderRecord, authzs []ACMEAuthorizationRecord) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO acme_orders (id, account_id, owner_username, status, identifiers_json, expires_at, cert_serial, error_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, order.ID, order.AccountID, order.OwnerUsername, order.Status, order.IdentifiersJSON, order.ExpiresAt, order.CertSerial, order.ErrorJSON, order.CreatedAt); err != nil {
			return err
		}
		for _, a := range authzs {
			wc := 0
			if a.Wildcard {
				wc = 1
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO acme_authorizations (id, order_id, account_id, identifier_type, identifier_value, wildcard, status, expires_at, challenges_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`, a.ID, a.OrderID, a.AccountID, a.IdentifierType, a.IdentifierValue, wc, a.Status, a.ExpiresAt, a.ChallengesJSON, a.CreatedAt); err != nil {
				return err
			}
		}
		return nil
	})
}

// GetACMEOrder fetches an ACME order by ID.
func (s *Store) GetACMEOrder(ctx context.Context, id string) (*ACMEOrderRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, account_id, owner_username, status, identifiers_json, expires_at, cert_serial, error_json, created_at
		FROM acme_orders WHERE id = ?
	`, id)
	var r ACMEOrderRecord
	if err := row.Scan(&r.ID, &r.AccountID, &r.OwnerUsername, &r.Status, &r.IdentifiersJSON, &r.ExpiresAt, &r.CertSerial, &r.ErrorJSON, &r.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// GetACMEOrderByCertSerial fetches an ACME order by its finalized certificate serial hex.
func (s *Store) GetACMEOrderByCertSerial(ctx context.Context, serialHex string) (*ACMEOrderRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, account_id, owner_username, status, identifiers_json, expires_at, cert_serial, error_json, created_at
		FROM acme_orders WHERE cert_serial = ? LIMIT 1
	`, serialHex)
	var r ACMEOrderRecord
	if err := row.Scan(&r.ID, &r.AccountID, &r.OwnerUsername, &r.Status, &r.IdentifiersJSON, &r.ExpiresAt, &r.CertSerial, &r.ErrorJSON, &r.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// UpdateACMEOrder updates order status, cert_serial, and error_json.
func (s *Store) UpdateACMEOrder(ctx context.Context, id, status, certSerial, errorJSON string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE acme_orders SET status = ?, cert_serial = ?, error_json = ? WHERE id = ?
		`, status, certSerial, errorJSON, id)
		return err
	})
}

// CountACMEOrdersSince counts orders placed by an account since a Unix timestamp (for sliding-window rate limiting).
func (s *Store) CountACMEOrdersSince(ctx context.Context, accountID string, sinceUnix int64) (int, error) {
	var cnt int
	err := s.ReadDB.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM acme_orders WHERE account_id = ? AND created_at >= ?
	`, accountID, sinceUnix).Scan(&cnt)
	return cnt, err
}

// ListACMEOrders lists ACME orders filtered by ownerUsername or accountID.
func (s *Store) ListACMEOrders(ctx context.Context, ownerUsername, accountID string, limit int) ([]ACMEOrderRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var (
		rows *sql.Rows
		err  error
	)
	switch {
	case accountID != "":
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, account_id, owner_username, status, identifiers_json, expires_at, cert_serial, error_json, created_at
			FROM acme_orders WHERE account_id = ? ORDER BY created_at DESC LIMIT ?
		`, accountID, limit)
	case ownerUsername != "":
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, account_id, owner_username, status, identifiers_json, expires_at, cert_serial, error_json, created_at
			FROM acme_orders WHERE owner_username = ? ORDER BY created_at DESC LIMIT ?
		`, ownerUsername, limit)
	default:
		rows, err = s.ReadDB.QueryContext(ctx, `
			SELECT id, account_id, owner_username, status, identifiers_json, expires_at, cert_serial, error_json, created_at
			FROM acme_orders ORDER BY created_at DESC LIMIT ?
		`, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ACMEOrderRecord, 0)
	for rows.Next() {
		var r ACMEOrderRecord
		if err := rows.Scan(&r.ID, &r.AccountID, &r.OwnerUsername, &r.Status, &r.IdentifiersJSON, &r.ExpiresAt, &r.CertSerial, &r.ErrorJSON, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetACMEAuthorization fetches an authorization by ID.
func (s *Store) GetACMEAuthorization(ctx context.Context, id string) (*ACMEAuthorizationRecord, error) {
	row := s.ReadDB.QueryRowContext(ctx, `
		SELECT id, order_id, account_id, identifier_type, identifier_value, wildcard, status, expires_at, challenges_json, created_at
		FROM acme_authorizations WHERE id = ?
	`, id)
	var r ACMEAuthorizationRecord
	var wc int
	if err := row.Scan(&r.ID, &r.OrderID, &r.AccountID, &r.IdentifierType, &r.IdentifierValue, &wc, &r.Status, &r.ExpiresAt, &r.ChallengesJSON, &r.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	r.Wildcard = wc == 1
	return &r, nil
}

// ListACMEAuthorizationsByOrder returns all authorizations for a given order ID.
func (s *Store) ListACMEAuthorizationsByOrder(ctx context.Context, orderID string) ([]ACMEAuthorizationRecord, error) {
	rows, err := s.ReadDB.QueryContext(ctx, `
		SELECT id, order_id, account_id, identifier_type, identifier_value, wildcard, status, expires_at, challenges_json, created_at
		FROM acme_authorizations WHERE order_id = ? ORDER BY created_at ASC
	`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ACMEAuthorizationRecord, 0)
	for rows.Next() {
		var r ACMEAuthorizationRecord
		var wc int
		if err := rows.Scan(&r.ID, &r.OrderID, &r.AccountID, &r.IdentifierType, &r.IdentifierValue, &wc, &r.Status, &r.ExpiresAt, &r.ChallengesJSON, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Wildcard = wc == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpdateACMEAuthorization updates status and challenges JSON for an authorization.
func (s *Store) UpdateACMEAuthorization(ctx context.Context, id, status, challengesJSON string) error {
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE acme_authorizations SET status = ?, challenges_json = ? WHERE id = ?
		`, status, challengesJSON, id)
		return err
	})
}
