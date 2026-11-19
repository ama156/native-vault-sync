package syncserver

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/argon2"
	_ "modernc.org/sqlite"
)

type Store struct {
	DB           *sql.DB
	Config       Config
	lock         *os.File
	mu           sync.Mutex
	reserved     int64
	reservations map[string]int64
	userUploads  map[int]int
	uploads      int
}
type Vault struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Host       string `json:"host"`
	Salt       string `json:"salt"`
	Encryption int    `json:"encryption_version"`
	Region     string `json:"region"`
	Size       int64  `json:"size"`
	Created    int64  `json:"created"`
	KeyHash    string `json:"-"`
	Version    int64  `json:"-"`
}
type Record struct {
	Path      string `json:"path"`
	Related   string `json:"relatedpath"`
	Extension string `json:"extension"`
	Hash      string `json:"hash"`
	Ctime     int64  `json:"ctime"`
	Mtime     int64  `json:"mtime"`
	Folder    bool   `json:"folder"`
	Deleted   bool   `json:"deleted"`
	Size      int64  `json:"size"`
	Pieces    int64  `json:"pieces"`
	UID       int64  `json:"uid"`
	TS        int64  `json:"ts"`
	Device    string `json:"device"`
	User      int    `json:"user"`
	Blob      string `json:"-"`
}

var ErrAuth = errors.New("Not logged in")

func RandomHex(n int) string {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
func Supported(v int) bool { return v == 0 || v == 2 || v == 3 }
func Pieces(n int64) int64 { return (n + Chunk - 1) / Chunk }
func PasswordHash(password string) (string, error) {
	if e := passwordPolicy(password); e != nil {
		return "", e
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	h := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return encodeHash(salt, h), nil
}
func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, ":")
	if strings.HasPrefix(encoded, "$argon2id$") {
		p := strings.Split(encoded, "$")
		if len(p) != 6 || p[2] != "v=19" || p[3] != "m=65536,t=3,p=2" {
			return false
		}
		parts = p[4:]
	}
	if len(parts) != 2 || len(password) > 1024 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[0])
	if e != nil || len(salt) != 16 {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(parts[1])
	if e != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}
func Open(c Config, exclusive bool) (*Store, error) {
	if e := c.Validate(); e != nil {
		return nil, e
	}
	if e := os.MkdirAll(c.DataDir, 0700); e != nil {
		return nil, e
	}
	info, err := os.Stat(c.DataDir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("data directory must be private (mode 0700)")
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && os.Geteuid() != 0 && st.Uid != uint32(os.Geteuid()) {
		return nil, errors.New("data directory must belong to the service user")
	}
	if err := regularFile(filepath.Join(c.DataDir, "metadata.sqlite")); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	s := &Store{Config: c, reservations: map[string]int64{}, userUploads: map[int]int{}}
	if exclusive {
		f, e := os.OpenFile(filepath.Join(c.DataDir, "server.lock"), os.O_CREATE|os.O_RDWR, 0600)
		if e != nil {
			return nil, e
		}
		if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
			f.Close()
			return nil, errors.New("data directory is in use; stop the service first")
		}
		s.lock = f
	}
	db, e := sql.Open("sqlite", filepath.Join(c.DataDir, "metadata.sqlite"))
	if e != nil {
		s.Close()
		return nil, e
	}
	s.DB = db
	db.SetMaxOpenConns(1)
	for _, q := range []string{"PRAGMA busy_timeout=5000", "PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "PRAGMA foreign_keys=ON"} {
		if _, e = db.Exec(q); e != nil {
			s.Close()
			return nil, e
		}
	}
	if e = os.Chmod(filepath.Join(c.DataDir, "metadata.sqlite"), 0600); e != nil {
		s.Close()
		return nil, e
	}
	var schema int
	if e = db.QueryRow("PRAGMA user_version").Scan(&schema); e != nil {
		s.Close()
		return nil, e
	}
	if schema > 2 {
		s.Close()
		return nil, errors.New("database was created by a newer server")
	}
	if schema == 0 {
		_, e = db.Exec(`BEGIN;
 CREATE TABLE owner(id INTEGER PRIMARY KEY CHECK(id=1),email TEXT NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL);
 CREATE TABLE sessions(hash TEXT PRIMARY KEY,created INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT NOT NULL,salt TEXT NOT NULL,keyhash TEXT NOT NULL,encryption INTEGER NOT NULL,created INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE blobs(vault TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(vault,hash));
 CREATE TABLE revisions(vault TEXT NOT NULL,uid INTEGER NOT NULL,path TEXT NOT NULL,relatedpath TEXT NOT NULL,extension TEXT NOT NULL,hash TEXT NOT NULL,ctime INTEGER NOT NULL,mtime INTEGER NOT NULL,folder INTEGER NOT NULL,deleted INTEGER NOT NULL,size INTEGER NOT NULL,ts INTEGER NOT NULL,device TEXT NOT NULL,blob TEXT NOT NULL,PRIMARY KEY(vault,uid));
 CREATE INDEX revisions_path ON revisions(vault,path,uid);
 PRAGMA user_version=1;COMMIT;`)
		if e != nil {
			s.Close()
			return nil, e
		}
	}
	if e = s.migrateUsers(exclusive); e != nil {
		s.Close()
		return nil, e
	}

	if exclusive {
		for _, dir := range []string{"uploads", "blobs"} {
			if e = os.MkdirAll(filepath.Join(c.DataDir, dir), 0700); e != nil {
				s.Close()
				return nil, e
			}
		}
		entries, e := os.ReadDir(filepath.Join(c.DataDir, "uploads"))
		if e != nil {
			s.Close()
			return nil, e
		}
		for _, entry := range entries {
			if e = os.Remove(filepath.Join(c.DataDir, "uploads", entry.Name())); e != nil {
				s.Close()
				return nil, e
			}
		}
	}
	if exclusive {
		if e = s.Recover(); e != nil {
			s.Close()
			return nil, e
		}
	}
	return s, nil
}
func (s *Store) Close() error {
	var e error
	if s.DB != nil {
		e = s.DB.Close()
	}
	if s.lock != nil {
		syscall.Flock(int(s.lock.Fd()), syscall.LOCK_UN)
		s.lock.Close()
	}
	return e
}
func (s *Store) InitOwner(email, name, password string) error {
	var count int
	if e := s.DB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); e != nil {
		return e
	}
	if count != 0 {
		return errors.New("server accounts already initialized")
	}
	_, e := s.AddUser(email, name, password)
	return e
}
func (s *Store) Account() (map[string]any, error) { return s.AccountFor(1) }
func (s *Store) SignIn(email, password string) (string, error) {
	var id int
	var hash string
	var disabled bool
	e := s.DB.QueryRow("SELECT id,password,disabled FROM users WHERE email=?", normalizeEmail(email)).Scan(&id, &hash, &disabled)
	if e != nil && e != sql.ErrNoRows {
		return "", errors.New("Authentication temporarily unavailable")
	}
	if e == sql.ErrNoRows {
		hash = dummyPasswordHash
	}
	valid := verifyPassword(hash, password)
	if !valid || e == sql.ErrNoRows || disabled {
		return "", errors.New("Invalid email or password")
	}
	if !strings.HasPrefix(hash, "$argon2id$") {
		salt := make([]byte, 16)
		if _, e = rand.Read(salt); e != nil {
			return "", e
		}
		upgraded := encodeHash(salt, argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32))
		if _, e = s.DB.Exec("UPDATE users SET password=? WHERE id=? AND password=?", upgraded, id, hash); e != nil {
			return "", e
		}
		hash = upgraded
	}
	token := "vs1_" + RandomHex(32)
	now := time.Now()
	result, e := s.DB.Exec("INSERT INTO sessions(hash,created,expires,user_id) SELECT ?,?,?,id FROM users WHERE id=? AND disabled=0 AND password=?", tokenHash(token), now.UnixMilli(), now.Add(time.Duration(s.Config.SessionDays)*24*time.Hour).UnixMilli(), id, hash)
	if e != nil {
		return "", e
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return "", ErrAuth
	}
	return token, nil
}
func (s *Store) Authorize(token string) error { _, e := s.Principal(token); return e }
func (s *Store) SignOut(token string) error {
	_, e := s.DB.Exec("DELETE FROM sessions WHERE hash=?", tokenHash(token))
	return e
}
func (s *Store) ResetPassword(password string) error { return s.ChangePassword(1, password) }

// Fixed-cost dummy verifier prevents a missing user from skipping Argon2.
var dummyPasswordHash = encodeHash(make([]byte, 16), make([]byte, 32))

func (s *Store) vaultRow(row *sql.Row) (Vault, error) {
	var v Vault
	e := row.Scan(&v.ID, &v.Name, &v.Salt, &v.KeyHash, &v.Encryption, &v.Created, &v.Version)
	v.Host = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(s.Config.PublicURL, "https://"), "http://"), "/") + "/sync"
	v.Region = "self-hosted"
	return v, e
}
func (s *Store) Vault(id string) (Vault, error) {
	return s.vaultRow(s.DB.QueryRow("SELECT id,name,salt,keyhash,encryption,created,version FROM vaults WHERE id=? AND deleted=0", id))
}
func (s *Store) Vaults() ([]Vault, error) {
	rows, e := s.DB.Query("SELECT id FROM vaults WHERE deleted=0 ORDER BY created,id")
	if e != nil {
		return nil, e
	}
	var ids []string
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	out := make([]Vault, 0, len(ids))
	for _, id := range ids {
		v, e := s.Vault(id)
		if e != nil {
			return nil, e
		}
		v.Size, _ = s.VaultSize(id)
		out = append(out, v)
	}
	return out, nil
}
func (s *Store) CreateVault(name, salt, keyhash string, encryption int) (Vault, error) {
	return s.CreateVaultFor(1, name, salt, keyhash, encryption)
}

const recordColumns = "path,relatedpath,extension,hash,ctime,mtime,folder,deleted,size,uid,ts,device,blob,user_id"

func scanRecord(scan func(...any) error) (Record, error) {
	var r Record
	e := scan(&r.Path, &r.Related, &r.Extension, &r.Hash, &r.Ctime, &r.Mtime, &r.Folder, &r.Deleted, &r.Size, &r.UID, &r.TS, &r.Device, &r.Blob, &r.User)
	r.Pieces = Pieces(r.Size)
	return r, e
}
func (s *Store) Record(vault string, uid int64) (Record, error) {
	return scanRecord(s.DB.QueryRow("SELECT "+recordColumns+" FROM revisions WHERE vault=? AND uid=?", vault, uid).Scan)
}
func (s *Store) Records(vault, where string, args ...any) ([]Record, error) {
	a := append([]any{vault}, args...)
	rows, e := s.DB.Query("SELECT "+recordColumns+" FROM revisions WHERE vault=? "+where, a...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		r, e := scanRecord(rows.Scan)
		if e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func (s *Store) Latest(vault string) ([]Record, error) {
	return s.Records(vault, "AND uid IN (SELECT MAX(uid) FROM revisions WHERE vault=? GROUP BY path) ORDER BY uid", vault)
}
func (s *Store) VaultSize(id string) (int64, error) {
	var n int64
	e := s.DB.QueryRow("SELECT COALESCE(SUM(size),0) FROM revisions WHERE vault=? AND deleted=0 AND uid IN (SELECT MAX(uid) FROM revisions WHERE vault=? GROUP BY path)", id, id).Scan(&n)
	return n, e
}
func (s *Store) Storage() (int64, error) {
	var n int64
	e := s.DB.QueryRow("SELECT COALESCE(SUM(size),0) FROM blobs").Scan(&n)
	return n, e
}
func (s *Store) BlobPath(vault, blob string) string {
	return filepath.Join(s.Config.DataDir, "blobs", vault, blob)
}
func (s *Store) commit(vault string, r Record, token string) (Record, error) {
	tx, e := s.DB.Begin()
	if e != nil {
		return r, e
	}
	defer tx.Rollback()
	var authorized int
	if e = tx.QueryRow("SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id JOIN vaults v ON v.id=m.vault_id WHERE s.hash=? AND s.expires>? AND u.disabled=0 AND m.vault_id=? AND v.deleted=0", tokenHash(token), time.Now().UnixMilli(), vault).Scan(&authorized); e != nil {
		return r, e
	}
	if authorized < 1 {
		return r, ErrAuth
	}
	var version int64
	if e = tx.QueryRow("SELECT version FROM vaults WHERE id=? AND deleted=0", vault).Scan(&version); e != nil {
		return r, e
	}
	if version >= 9007199254740990 {
		return r, errors.New("revision range exhausted")
	}
	r.UID = version + 1
	r.TS = time.Now().UnixMilli()
	r.User = authorized
	r.Pieces = Pieces(r.Size)
	if _, e = tx.Exec("INSERT INTO revisions(vault,uid,path,relatedpath,extension,hash,ctime,mtime,folder,deleted,size,ts,device,blob,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", vault, r.UID, r.Path, r.Related, r.Extension, r.Hash, r.Ctime, r.Mtime, r.Folder, r.Deleted, r.Size, r.TS, r.Device, r.Blob, r.User); e != nil {
		return r, e
	}
	if r.Blob != "" {
		if _, e = tx.Exec("INSERT OR IGNORE INTO blobs(vault,hash,size) VALUES(?,?,?)", vault, r.Blob, r.Size); e != nil {
			return r, e
		}
	}
	if _, e = tx.Exec("UPDATE vaults SET version=? WHERE id=?", r.UID, vault); e != nil {
		return r, e
	}
	return r, tx.Commit()
}
func (s *Store) reserve(n int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	used, e := s.Storage()
	if e != nil {
		return e
	}
	if used+s.reserved+n > s.Config.MaxStorage {
		return errors.New("Storage limit reached")
	}
	s.reserved += n
	return nil
}
func (s *Store) release(n int64) { s.mu.Lock(); s.reserved -= n; s.mu.Unlock() }
func syncDir(dir string) error {
	f, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
func (s *Store) InstallBlob(vault string, f *os.File) (string, error) {
	if e := f.Sync(); e != nil {
		return "", e
	}
	if _, e := f.Seek(0, 0); e != nil {
		return "", e
	}
	h := sha256.New()
	if _, e := io.Copy(h, f); e != nil {
		return "", e
	}
	blob := fmt.Sprintf("%x", h.Sum(nil))
	if e := f.Close(); e != nil {
		return "", e
	}
	dir := filepath.Dir(s.BlobPath(vault, blob))
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	if e := syncDir(filepath.Dir(dir)); e != nil {
		return "", e
	}
	target := s.BlobPath(vault, blob)
	if _, e := os.Stat(target); e == nil {
		if e = os.Remove(f.Name()); e != nil {
			return "", e
		}
	} else if !os.IsNotExist(e) {
		return "", e
	} else if e = os.Rename(f.Name(), target); e != nil {
		return "", e
	}
	if e := syncDir(dir); e != nil {
		return "", e
	}
	return blob, nil
}
