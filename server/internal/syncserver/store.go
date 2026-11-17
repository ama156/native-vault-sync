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
	DB       *sql.DB
	Config   Config
	lock     *os.File
	mu       sync.Mutex
	reserved int64
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
	if len(password) < 12 || len(password) > 1024 {
		return "", errors.New("account password must contain 12–1024 bytes")
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	h := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return base64.RawStdEncoding.EncodeToString(salt) + ":" + base64.RawStdEncoding.EncodeToString(h), nil
}
func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, ":")
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
	s := &Store{Config: c}
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
	var schema int
	if e = db.QueryRow("PRAGMA user_version").Scan(&schema); e != nil {
		s.Close()
		return nil, e
	}
	if schema > 1 {
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
	hash, e := PasswordHash(password)
	if e != nil {
		return e
	}
	if !strings.Contains(email, "@") || len(email) > 320 {
		return errors.New("invalid owner email")
	}
	_, e = s.DB.Exec("INSERT INTO owner(id,email,name,password) VALUES(1,?,?,?)", strings.ToLower(strings.TrimSpace(email)), name, hash)
	return e
}
func (s *Store) Account() (map[string]any, error) {
	var email, name string
	e := s.DB.QueryRow("SELECT email,name FROM owner WHERE id=1").Scan(&email, &name)
	return map[string]any{"email": email, "name": name, "license": ""}, e
}
func (s *Store) SignIn(email, password string) (string, error) {
	var actual, hash string
	e := s.DB.QueryRow("SELECT email,password FROM owner WHERE id=1").Scan(&actual, &hash)
	if e != nil {
		return "", e
	}
	valid := verifyPassword(hash, password)
	if !valid || strings.ToLower(strings.TrimSpace(email)) != actual {
		return "", errors.New("Invalid email or password")
	}
	token := "vs1_" + RandomHex(32)
	now := time.Now()
	_, e = s.DB.Exec("INSERT INTO sessions(hash,created,expires) VALUES(?,?,?)", tokenHash(token), now.UnixMilli(), now.Add(90*24*time.Hour).UnixMilli())
	return token, e
}
func (s *Store) Authorize(token string) error {
	if !strings.HasPrefix(token, "vs1_") || len(token) != 68 {
		return ErrAuth
	}
	var n int
	e := s.DB.QueryRow("SELECT COUNT(*) FROM sessions WHERE hash=? AND expires>?", tokenHash(token), time.Now().UnixMilli()).Scan(&n)
	if e != nil {
		return e
	}
	if n != 1 {
		return ErrAuth
	}
	return nil
}
func (s *Store) SignOut(token string) error {
	_, e := s.DB.Exec("DELETE FROM sessions WHERE hash=?", tokenHash(token))
	return e
}
func (s *Store) ResetPassword(password string) error {
	hash, e := PasswordHash(password)
	if e != nil {
		return e
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec("UPDATE owner SET password=? WHERE id=1", hash); e != nil {
		return e
	}
	if _, e = tx.Exec("DELETE FROM sessions"); e != nil {
		return e
	}
	return tx.Commit()
}
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
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int
	if e := s.DB.QueryRow("SELECT COUNT(*) FROM vaults WHERE deleted=0").Scan(&count); e != nil {
		return Vault{}, e
	}
	if count >= s.Config.MaxVaults {
		return Vault{}, errors.New("Vault limit reached")
	}
	if strings.TrimSpace(name) == "" || len(name) > 200 || salt == "" || len(salt) > 1024 || keyhash == "" || len(keyhash) > 1024 || !Supported(encryption) {
		return Vault{}, errors.New("Require a name and end-to-end encryption with a supported version")
	}
	var n int
	if e := s.DB.QueryRow("SELECT COUNT(*) FROM vaults WHERE deleted=0").Scan(&n); e != nil {
		return Vault{}, e
	}
	if n >= s.Config.MaxVaults {
		return Vault{}, errors.New("Remote vault limit reached")
	}
	id := RandomHex(16)
	_, e := s.DB.Exec("INSERT INTO vaults(id,name,salt,keyhash,encryption,created) VALUES(?,?,?,?,?,?)", id, name, salt, keyhash, encryption, time.Now().UnixMilli())
	if e != nil {
		return Vault{}, e
	}
	return s.Vault(id)
}

const recordColumns = "path,relatedpath,extension,hash,ctime,mtime,folder,deleted,size,uid,ts,device,blob"

func scanRecord(scan func(...any) error) (Record, error) {
	var r Record
	e := scan(&r.Path, &r.Related, &r.Extension, &r.Hash, &r.Ctime, &r.Mtime, &r.Folder, &r.Deleted, &r.Size, &r.UID, &r.TS, &r.Device, &r.Blob)
	r.Pieces = Pieces(r.Size)
	r.User = 1
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
	if e = tx.QueryRow("SELECT COUNT(*) FROM sessions WHERE hash=? AND expires>?", tokenHash(token), time.Now().UnixMilli()).Scan(&authorized); e != nil {
		return r, e
	}
	if authorized != 1 {
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
	r.User = 1
	r.Pieces = Pieces(r.Size)
	if _, e = tx.Exec("INSERT INTO revisions(vault,uid,path,relatedpath,extension,hash,ctime,mtime,folder,deleted,size,ts,device,blob) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", vault, r.UID, r.Path, r.Related, r.Extension, r.Hash, r.Ctime, r.Mtime, r.Folder, r.Deleted, r.Size, r.TS, r.Device, r.Blob); e != nil {
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
