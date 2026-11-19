package syncserver

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type User struct {
	ID         int    `json:"id"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	Disabled   bool   `json:"disabled"`
	MaxStorage int64  `json:"max_storage_bytes"`
	MaxVaults  int    `json:"max_vaults"`
	MaxFile    int64  `json:"max_file_bytes"`
}

const userColumns = "id,email,name,disabled,max_storage,max_vaults,max_file"

func readUser(scan func(...any) error) (User, error) {
	var u User
	e := scan(&u.ID, &u.Email, &u.Name, &u.Disabled, &u.MaxStorage, &u.MaxVaults, &u.MaxFile)
	return u, e
}
func (s *Store) User(id int) (User, error) {
	return readUser(s.DB.QueryRow("SELECT "+userColumns+" FROM users WHERE id=?", id).Scan)
}
func (s *Store) UserByEmail(email string) (User, error) {
	return readUser(s.DB.QueryRow("SELECT "+userColumns+" FROM users WHERE email=?", normalizeEmail(email)).Scan)
}
func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }
func validUser(email, name string) bool {
	return len(email) <= 320 && strings.Contains(email, "@") && !strings.ContainsAny(email, "\r\n\x00") && len(name) > 0 && len(name) <= 200
}
func (s *Store) AddUser(email, name, password string) (User, error) {
	email = normalizeEmail(email)
	if !validUser(email, name) {
		return User{}, errors.New("invalid email or display name")
	}
	hash, e := PasswordHash(password)
	if e != nil {
		return User{}, e
	}
	r, e := s.DB.Exec("INSERT INTO users(email,name,password,max_storage,max_vaults,max_file) VALUES(?,?,?,?,?,?)", email, name, hash, s.Config.DefaultUserStorage, s.Config.MaxVaults, s.Config.MaxFile)
	if e != nil {
		return User{}, errors.New("could not create user; email must be unique")
	}
	id, e := r.LastInsertId()
	if e != nil {
		return User{}, e
	}
	return s.User(int(id))
}
func (s *Store) Users() ([]User, error) {
	rows, e := s.DB.Query("SELECT " + userColumns + " FROM users ORDER BY id")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		u, e := readUser(rows.Scan)
		if e != nil {
			return nil, e
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
func (s *Store) AccountFor(id int) (map[string]any, error) {
	u, e := s.User(id)
	return map[string]any{"email": u.Email, "name": u.Name, "license": ""}, e
}
func (s *Store) Principal(token string) (User, error) {
	if !strings.HasPrefix(token, "vs1_") || len(token) != 68 {
		return User{}, ErrAuth
	}
	u, e := readUser(s.DB.QueryRow("SELECT u."+strings.ReplaceAll(userColumns, ",", ",u.")+" FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>? AND u.disabled=0", tokenHash(token), time.Now().UnixMilli()).Scan)
	if e == sql.ErrNoRows {
		return User{}, ErrAuth
	}
	return u, e
}
func (s *Store) Access(user int, vault string) error {
	var n int
	e := s.DB.QueryRow("SELECT COUNT(*) FROM memberships m JOIN users u ON u.id=m.user_id JOIN vaults v ON v.id=m.vault_id WHERE m.user_id=? AND m.vault_id=? AND u.disabled=0 AND v.deleted=0", user, vault).Scan(&n)
	if e != nil {
		return e
	}
	if n != 1 {
		return errors.New("Vault not found")
	}
	return nil
}
func (s *Store) ChangePassword(user int, password string) error {
	hash, e := PasswordHash(password)
	if e != nil {
		return e
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	r, e := tx.Exec("UPDATE users SET password=? WHERE id=?", hash, user)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n != 1 {
		return errors.New("user not found")
	}
	if _, e = tx.Exec("DELETE FROM sessions WHERE user_id=?", user); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) SetDisabled(user int, disabled bool) error {
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	r, e := tx.Exec("UPDATE users SET disabled=? WHERE id=?", disabled, user)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n != 1 {
		return errors.New("user not found")
	}
	if disabled {
		if _, e = tx.Exec("DELETE FROM sessions WHERE user_id=?", user); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func (s *Store) SetQuota(user int, storage int64, vaults int, file int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if storage < 1 || storage > 1<<60 || vaults < 1 || file < 1 || file > s.Config.MaxFile {
		return errors.New("invalid user quotas")
	}
	r, e := s.DB.Exec("UPDATE users SET max_storage=?,max_vaults=?,max_file=? WHERE id=?", storage, vaults, file, user)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n != 1 {
		return errors.New("user not found")
	}
	return nil
}
func (s *Store) Members(vault string) ([]int, error) {
	rows, e := s.DB.Query("SELECT user_id FROM memberships WHERE vault_id=? ORDER BY user_id", vault)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []int{}
	for rows.Next() {
		var id int
		if e = rows.Scan(&id); e != nil {
			return nil, e
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Charges use retained ciphertext, including soft-deleted vaults. Pending bytes
// are allocated under the same mutex and current membership as committed bytes.
func (s *Store) charges(extraVault string, extra int64) (map[int]int64, int64, error) {
	rows, e := s.DB.Query("SELECT id FROM vaults")
	if e != nil {
		return nil, 0, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, 0, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, 0, e
	}
	charges := map[int]int64{}
	var total int64
	for _, v := range ids {
		var bytes int64
		if e = s.DB.QueryRow("SELECT COALESCE(SUM(size),0) FROM blobs WHERE vault=?", v).Scan(&bytes); e != nil {
			return nil, 0, e
		}
		bytes += s.reservations[v]
		if v == extraVault {
			bytes += extra
		}
		total += bytes
		members, e := s.Members(v)
		if e != nil {
			return nil, 0, e
		}
		if len(members) == 0 && bytes > 0 {
			return nil, 0, errors.New("unowned stored vault")
		}
		for i, id := range members {
			share := bytes / int64(len(members))
			if int64(i) < bytes%int64(len(members)) {
				share++
			}
			charges[id] += share
		}
	}
	return charges, total, nil
}
func (s *Store) quotaCheck(vault string, extra int64) error {
	charges, total, e := s.charges(vault, extra)
	if e != nil {
		return e
	}
	if total > s.Config.MaxStorage {
		return errors.New("Server storage limit reached")
	}
	members, e := s.Members(vault)
	if e != nil {
		return e
	}
	for _, id := range members {
		n := charges[id]
		u, e := s.User(id)
		if e != nil {
			return e
		}
		if n > u.MaxStorage {
			return errors.New("Co-owner storage limit reached")
		}
	}
	return nil
}
func (s *Store) Usage(user int) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	charges, _, e := s.charges("", 0)
	return charges[user], e
}
func (s *Store) SetMember(vault string, user int, add bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, e := s.Vault(vault); e != nil {
		return errors.New("Vault not found")
	}
	u, e := s.User(user)
	if e != nil {
		return errors.New("user not found")
	}
	members, e := s.Members(vault)
	if e != nil {
		return e
	}
	has := false
	for _, id := range members {
		if id == user {
			has = true
		}
	}
	if has == add {
		return nil
	}
	if !add && len(members) == 1 {
		return errors.New("cannot remove the last co-owner")
	}
	if add {
		var count int
		if e = s.DB.QueryRow("SELECT COUNT(*) FROM memberships m JOIN vaults v ON v.id=m.vault_id WHERE user_id=? AND v.deleted=0", user).Scan(&count); e != nil {
			return e
		}
		if u.Disabled || count >= u.MaxVaults {
			return errors.New("user disabled or vault limit reached")
		}
		charges, _, e := s.charges("", 0)
		if e != nil {
			return e
		}
		var bytes int64
		if e = s.DB.QueryRow("SELECT COALESCE(SUM(size),0) FROM blobs WHERE vault=?", vault).Scan(&bytes); e != nil {
			return e
		}
		bytes += s.reservations[vault]
		next := append(append([]int{}, members...), user)
		sort.Ints(next)
		var share int64
		for i, id := range next {
			if id == user {
				share = bytes / int64(len(next))
				if int64(i) < bytes%int64(len(next)) {
					share++
				}
			}
		}
		if charges[user]+share > u.MaxStorage {
			return errors.New("new co-owner storage limit reached")
		}
		_, e = s.DB.Exec("INSERT INTO memberships(vault_id,user_id) VALUES(?,?)", vault, user)
		if e != nil {
			return e
		}
		return nil
	}
	_, e = s.DB.Exec("DELETE FROM memberships WHERE vault_id=? AND user_id=?", vault, user)
	return e
}
func (s *Store) VaultsFor(user int) ([]Vault, error) {
	all, e := s.Vaults()
	if e != nil {
		return nil, e
	}
	out := []Vault{}
	for _, v := range all {
		if s.Access(user, v.ID) == nil {
			out = append(out, v)
		}
	}
	return out, nil
}
func (s *Store) CreateVaultFor(user int, name, salt, keyhash string, encryption int) (Vault, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, e := s.User(user)
	if e != nil || u.Disabled {
		return Vault{}, ErrAuth
	}
	var count, total int
	if e = s.DB.QueryRow("SELECT COUNT(*) FROM memberships m JOIN vaults v ON v.id=m.vault_id WHERE user_id=? AND v.deleted=0", user).Scan(&count); e != nil {
		return Vault{}, e
	}
	if e = s.DB.QueryRow("SELECT COUNT(*) FROM vaults WHERE deleted=0").Scan(&total); e != nil {
		return Vault{}, e
	}
	if count >= u.MaxVaults || total >= s.Config.MaxTotalVaults {
		return Vault{}, errors.New("Vault limit reached")
	}
	if strings.TrimSpace(name) == "" || len(name) > 200 || salt == "" || len(salt) > 1024 || keyhash == "" || len(keyhash) > 1024 || !Supported(encryption) {
		return Vault{}, errors.New("invalid encrypted vault metadata")
	}
	id := RandomHex(16)
	tx, e := s.DB.Begin()
	if e != nil {
		return Vault{}, e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("INSERT INTO vaults(id,name,salt,keyhash,encryption,created) VALUES(?,?,?,?,?,?)", id, name, salt, keyhash, encryption, time.Now().UnixMilli()); e != nil {
		return Vault{}, e
	}
	if _, e = tx.Exec("INSERT INTO memberships(vault_id,user_id) VALUES(?,?)", id, user); e != nil {
		return Vault{}, e
	}
	if e = tx.Commit(); e != nil {
		return Vault{}, e
	}
	return s.Vault(id)
}
func (s *Store) reserveFor(vault string, user int, n int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, e := s.User(user)
	if e != nil {
		return e
	}
	if n > u.MaxFile+28 {
		return errors.New("File limit reached")
	}
	if s.uploads >= s.Config.MaxUploads || s.userUploads[user] >= s.Config.UserUploads {
		return errors.New("Upload limit reached")
	}
	if e = s.quotaCheck(vault, n); e != nil {
		return e
	}
	s.reservations[vault] += n
	s.reserved += n
	s.uploads++
	s.userUploads[user]++
	return nil
}
func (s *Store) releaseFor(vault string, user int, n int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reservations[vault] -= n
	s.reserved -= n
	s.uploads--
	s.userUploads[user]--
}
func passwordPolicy(password string) error {
	if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 15 || len(password) > 1024 {
		return errors.New("password requires at least 15 characters and at most 1024 UTF-8 bytes")
	}
	return nil
}
func encodeHash(salt, hash []byte) string {
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=2$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash))
}
