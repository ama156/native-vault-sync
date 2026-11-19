package syncserver

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUsersIsolationAndCoOwnership(t *testing.T) {
	f := setup(t)
	u, e := f.s.AddUser("second@local.invalid", "Second", "second disposable password")
	if e != nil {
		t.Fatal(e)
	}
	token, e := f.s.SignIn(u.Email, "second disposable password")
	if e != nil {
		t.Fatal(e)
	}
	if got := f.post(t, "/vault/list", map[string]any{"token": token}, 200); len(got["vaults"].([]any)) != 0 {
		t.Fatal("private vault leaked")
	}
	for _, route := range []string{"/vault/access", "/vault/rename", "/vault/delete"} {
		got := f.post(t, route, map[string]any{"token": token, "vault_uid": f.vault.ID, "name": "stolen", "keyhash": f.vault.KeyHash, "encryption_version": 3, "host": f.vault.Host}, 200)
		if got["error"] != "Vault not found" {
			t.Fatalf("unauthorized %s: %v", route, got)
		}
	}
	if e = f.s.SetMember(f.vault.ID, u.ID, true); e != nil {
		t.Fatal(e)
	}
	got := f.post(t, "/vault/list", map[string]any{"token": token}, 200)
	if len(got["vaults"].([]any)) != 1 {
		t.Fatal("co-owned vault missing")
	}
	got = f.post(t, "/vault/rename", map[string]any{"token": token, "vault_uid": f.vault.ID, "name": "Co-owner renamed"}, 200)
	if got["res"] != "ok" {
		t.Fatal(got)
	}
	copied := *f
	copied.token = token
	c := dial(t, &copied, 0, true)
	defer c.CloseNow()
	ready(t, c)
	uploadBytes(t, c, "second-user-file", "hash-second", []byte("ciphertext"))
	record, e := f.s.Record(f.vault.ID, 1)
	if e != nil || record.User != u.ID {
		t.Fatalf("wrong author: %+v %v", record, e)
	}
	if e = f.s.SetMember(f.vault.ID, u.ID, false); e != nil {
		t.Fatal(e)
	}
	send(t, c, map[string]any{"op": "pull", "uid": 1})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, e = c.Read(ctx); e == nil {
		t.Fatal("revoked member received data")
	}
	if e = f.s.SetDisabled(u.ID, true); e != nil {
		t.Fatal(e)
	}
	if f.s.Authorize(token) == nil {
		t.Fatal("disabled user session remains valid")
	}
	if _, e = f.s.SignIn(u.Email, "second disposable password"); e == nil {
		t.Fatal("disabled login succeeded")
	}
}
func TestQuotaEqualSharesReservationsAndRevocation(t *testing.T) {
	f := setup(t)
	two, e := f.s.AddUser("two@local.invalid", "Two", "second disposable password")
	if e != nil {
		t.Fatal(e)
	}
	three, e := f.s.AddUser("three@local.invalid", "Three", "third disposable password")
	if e != nil {
		t.Fatal(e)
	}
	f.s.DB.Exec("INSERT INTO blobs(vault,hash,size) VALUES(?,?,?)", f.vault.ID, strings.Repeat("a", 64), int64(101))
	for _, u := range []User{two, three} {
		if e = f.s.SetMember(f.vault.ID, u.ID, true); e != nil {
			t.Fatal(e)
		}
	}
	for id, want := range map[int]int64{1: 34, two.ID: 34, three.ID: 33} {
		got, e := f.s.Usage(id)
		if e != nil || got != want {
			t.Fatalf("charge %d: %d want %d (%v)", id, got, want, e)
		}
	}
	if e = f.s.SetQuota(two.ID, 34, 10, DefaultFileMax); e != nil {
		t.Fatal(e)
	}
	if e = f.s.reserveFor(f.vault.ID, 1, 3); e == nil {
		t.Fatal("pending bytes bypassed a co-owner quota")
	}
	if e = f.s.SetMember(f.vault.ID, two.ID, false); e != nil {
		t.Fatal("revocation must be allowed", e)
	}
	if n, _ := f.s.Usage(1); n != 51 {
		t.Fatal(n)
	}
	if e = f.s.SetQuota(1, 50, 10, DefaultFileMax); e != nil {
		t.Fatal(e)
	}
	if e = f.s.reserveFor(f.vault.ID, three.ID, 1); e == nil {
		t.Fatal("over-quota growth allowed")
	}
	if e = f.s.SetMember(f.vault.ID, three.ID, false); e != nil {
		t.Fatal(e)
	}
	if e = f.s.SetMember(f.vault.ID, 1, false); e == nil {
		t.Fatal("last owner removed")
	}
}
func TestPasswordFormatsAndProxyTrust(t *testing.T) {
	hash, e := PasswordHash("a fifteen character password")
	if e != nil {
		t.Fatal(e)
	}
	hash2, _ := PasswordHash("a fifteen character password")
	if hash == hash2 || !strings.HasPrefix(hash, "$argon2id$v=19$") {
		t.Fatal("bad salt/format")
	}
	if !verifyPassword(hash, "a fifteen character password") || verifyPassword(hash, "different password") {
		t.Fatal("verification")
	}
	if _, e = PasswordHash("short"); e == nil {
		t.Fatal("weak password accepted")
	}
	if verifyPassword("$argon2id$v=19$m=999999999,t=3,p=2$abc$def", "password") {
		t.Fatal("unsafe hash parameters")
	}
	c := DefaultConfig()
	r, _ := http.NewRequest("POST", "http://localhost/user/signin", nil)
	r.RemoteAddr = "203.0.113.5:1000"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if c.clientIP(r) != "203.0.113.5" {
		t.Fatal("spoofed header trusted")
	}
	c.TrustedProxies = []string{"127.0.0.0/8"}
	r.RemoteAddr = "127.0.0.1:1000"
	if c.clientIP(r) != "1.2.3.4" {
		t.Fatal("trusted proxy ignored")
	}
	var limiter rateLimiter
	for i := 0; i < 8192; i++ {
		limiter.allow(strings.Repeat("x", 1)+string(rune(i)), 1)
	}
	if len(limiter.entries) > 8192 {
		t.Fatal("limiter unbounded")
	}
}
func TestSnapshotFormatsAndControlSocket(t *testing.T) {
	t.Setenv("TMPDIR", "/tmp")
	f := setup(t)
	c := dial(t, f, 0, true)
	ready(t, c)
	uploadBytes(t, c, "backup-file", "hash-backup", []byte("opaque backup bytes"))
	c.CloseNow()
	stop, e := f.server.StartControl()
	if e != nil {
		t.Fatal(e)
	}
	_, e = Admin(f.s.Config, AdminRequest{Action: "users.add", Email: "admin-created@local.invalid", Name: "Created", Password: "admin created password"})
	if e != nil {
		t.Fatal(e)
	}
	st, e := os.Stat(filepath.Join(f.s.Config.DataDir, "admin.sock"))
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("control permissions", e)
	}
	stop()
	// fixture cleanup is idempotent; close it before offline snapshots.
	f.http.Close()
	f.server.Close()
	f.s.Close()
	for _, format := range []string{"zip", "directory", "tar.gz"} {
		t.Run(format, func(t *testing.T) {
			dir := t.TempDir()
			out := filepath.Join(dir, "snapshot")
			if e := BackupFormat(f.config, out, format); e != nil {
				t.Fatal(e)
			}
			newConfig := filepath.Join(dir, "restore.json")
			newData := filepath.Join(dir, "restored")
			var e error
			if format == "directory" {
				e = RestoreSource("", out, newConfig, newData)
			} else {
				e = RestoreSource(out, "", newConfig, newData)
			}
			if e != nil {
				t.Fatal(e)
			}
			cfg, e := LoadConfig(newConfig)
			if e != nil {
				t.Fatal(e)
			}
			s, e := Open(cfg, true)
			if e != nil {
				t.Fatal(e)
			}
			defer s.Close()
			if e = s.Authorize(f.token); e != nil {
				t.Fatal(e)
			}
			users, e := s.Users()
			if e != nil || len(users) != 2 {
				t.Fatal("users lost", e)
			}
			if e = s.CheckBlobs(true); e != nil {
				t.Fatal(e)
			}
			if format == "directory" {
				if e = os.WriteFile(filepath.Join(out, "metadata.sqlite"), []byte("corrupt"), 0600); e != nil {
					t.Fatal(e)
				}
				if e = RestoreSource("", out, filepath.Join(dir, "bad.json"), filepath.Join(dir, "bad")); e == nil {
					t.Fatal("corruption accepted")
				}
			}
		})
	}
}

// Build the exact legacy tables with populated rows, then verify transactional
// migration and a separate verified, pre-migration recovery snapshot.
func TestLegacyMigrationPreservesIdentityAndSession(t *testing.T) {
	c := DefaultConfig()
	c.PublicURL = "https://test.invalid"
	c.DataDir = filepath.Join(t.TempDir(), "data")
	os.MkdirAll(filepath.Join(c.DataDir, "blobs"), 0700)
	db, e := sql.Open("sqlite", filepath.Join(c.DataDir, "metadata.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	schema := `CREATE TABLE owner(id INTEGER PRIMARY KEY CHECK(id=1),email TEXT,name TEXT,password TEXT);CREATE TABLE sessions(hash TEXT PRIMARY KEY,created INTEGER,expires INTEGER);CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT,salt TEXT,keyhash TEXT,encryption INTEGER,created INTEGER,version INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0);CREATE TABLE blobs(vault TEXT,hash TEXT,size INTEGER,PRIMARY KEY(vault,hash));CREATE TABLE revisions(vault TEXT,uid INTEGER,path TEXT,relatedpath TEXT,extension TEXT,hash TEXT,ctime INTEGER,mtime INTEGER,folder INTEGER,deleted INTEGER,size INTEGER,ts INTEGER,device TEXT,blob TEXT,PRIMARY KEY(vault,uid));PRAGMA user_version=1;`
	if _, e = db.Exec(schema); e != nil {
		t.Fatal(e)
	}
	hash, _ := PasswordHash("legacy compatible password")
	parts := strings.Split(hash, "$")
	legacy := parts[4] + ":" + parts[5]
	token := "vs1_" + RandomHex(32)
	sum := sha256.Sum256([]byte(token))
	expiry := time.Now().Add(time.Hour).UnixMilli()
	db.Exec("INSERT INTO owner VALUES(1,?,?,?)", "legacy@local.invalid", "Legacy", legacy)
	db.Exec("INSERT INTO sessions VALUES(?,?,?)", hex.EncodeToString(sum[:]), time.Now().UnixMilli(), expiry)
	db.Exec("INSERT INTO vaults VALUES('0123456789abcdef0123456789abcdef','Old','salt','key',3,1,0,0)")
	db.Close()
	s, e := Open(c, true)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if e = s.Authorize(token); e != nil {
		t.Fatal(e)
	}
	vs, e := s.VaultsFor(1)
	if e != nil || len(vs) != 1 {
		t.Fatal("vault lost", e)
	}
	var after int64
	s.DB.QueryRow("SELECT expires FROM sessions").Scan(&after)
	if after != expiry {
		t.Fatal("expiry changed")
	}
	if _, e = s.SignIn("legacy@local.invalid", "legacy compatible password"); e != nil {
		t.Fatal(e)
	}
	s.DB.QueryRow("SELECT password FROM users WHERE id=1").Scan(&hash)
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatal("legacy hash not upgraded")
	}
	snapshots, _ := filepath.Glob(filepath.Join(c.DataDir, "pre-multiuser-*"))
	if len(snapshots) != 1 {
		t.Fatal("missing pre-upgrade snapshot")
	}
	if e = verifySnapshot(snapshots[0], true); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(filepath.Join(snapshots[0], "manifest.json"))
	var m snapshotManifest
	if json.Unmarshal(b, &m) != nil || m.Version != 1 {
		t.Fatal("manifest")
	}
}

func TestConcurrentSharedReservationsAndMidUploadRevocation(t *testing.T) {
	t.Setenv("TMPDIR", "/tmp")
	f := setup(t)
	u, e := f.s.AddUser("other@local.invalid", "Other", "other user's password")
	if e != nil {
		t.Fatal(e)
	}
	if e = f.s.SetMember(f.vault.ID, u.ID, true); e != nil {
		t.Fatal(e)
	}
	if e = f.s.SetQuota(1, 4, 10, DefaultFileMax); e != nil {
		t.Fatal(e)
	}
	if e = f.s.SetQuota(u.ID, 4, 10, DefaultFileMax); e != nil {
		t.Fatal(e)
	}
	f.s.Config.MaxStorage = 10
	var wg sync.WaitGroup
	var accepted atomic.Int32
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if f.s.reserveFor(f.vault.ID, 1, 3) == nil {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 2 || f.s.reserved != 6 {
		t.Fatalf("concurrent quota bypass: %d/%d", accepted.Load(), f.s.reserved)
	}
	for i := int32(0); i < accepted.Load(); i++ {
		f.s.releaseFor(f.vault.ID, 1, 3)
	}
	f.s.Config.MaxStorage = 10 << 30
	f.s.SetQuota(1, 10<<30, 10, DefaultFileMax)
	f.s.SetQuota(u.ID, 10<<30, 10, DefaultFileMax)
	token, e := f.s.SignIn(u.Email, "other user's password")
	if e != nil {
		t.Fatal(e)
	}
	other := *f
	other.token = token
	c := dial(t, &other, 0, true)
	defer c.CloseNow()
	ready(t, c)
	send(t, c, map[string]any{"op": "push", "path": "opaque-interrupted", "hash": "opaque-hash", "extension": "png", "size": Chunk + 1, "pieces": 2})
	if response(t, c)["res"] != "upload" {
		t.Fatal("upload denied")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if e = c.Write(ctx, websocket.MessageBinary, make([]byte, Chunk)); e != nil {
		t.Fatal(e)
	}
	if response(t, c)["res"] != "ok" {
		t.Fatal("piece ack")
	}
	stop, e := f.server.StartControl()
	if e != nil {
		t.Fatal(e)
	}
	defer stop()
	if _, e = Admin(f.s.Config, AdminRequest{Action: "vaults.revoke", Vault: f.vault.ID, User: u.ID}); e != nil {
		t.Fatal(e)
	}
	if _, _, e = c.Read(ctx); e == nil {
		t.Fatal("revoked upload remained open")
	}
	var n int
	if e = f.s.DB.QueryRow("SELECT COUNT(*) FROM revisions WHERE vault=?", f.vault.ID).Scan(&n); e != nil || n != 0 {
		t.Fatal("partial upload visible", n, e)
	}
}
func TestCoOwnerCanDeleteRemoteVault(t *testing.T) {
	f := setup(t)
	u, e := f.s.AddUser("delete@local.invalid", "Co-owner", "co-owner's password")
	if e != nil {
		t.Fatal(e)
	}
	if e = f.s.SetMember(f.vault.ID, u.ID, true); e != nil {
		t.Fatal(e)
	}
	token, e := f.s.SignIn(u.Email, "co-owner's password")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.DB.Exec("INSERT INTO blobs(vault,hash,size) VALUES(?,?,?)", f.vault.ID, strings.Repeat("b", 64), 101); e != nil {
		t.Fatal(e)
	}
	got := f.post(t, "/vault/delete", map[string]any{"token": token, "vault_uid": f.vault.ID}, 200)
	if got["res"] != "ok" {
		t.Fatal(got)
	}
	vs, e := f.s.VaultsFor(1)
	if e != nil || len(vs) != 0 {
		t.Fatal("delete did not apply to all", e)
	}
	if n, e := f.s.Usage(u.ID); e != nil || n != 50 {
		t.Fatal("deletion reclaimed retained history", n, e)
	}
	if e = f.s.SetMember(f.vault.ID, u.ID, false); e != nil {
		t.Fatal("cannot revoke retained deleted-vault ownership", e)
	}
	if n, e := f.s.Usage(1); e != nil || n != 101 {
		t.Fatal("deleted-vault charge was not redistributed", n, e)
	}
}

func TestLiveAccountChangesCancelUploads(t *testing.T) {
	for _, action := range []string{"users.disable", "users.password-reset", "users.quota"} {
		t.Run(action, func(t *testing.T) {
			t.Setenv("TMPDIR", "/tmp")
			f := setup(t)
			c := dial(t, f, 0, true)
			defer c.CloseNow()
			ready(t, c)
			send(t, c, map[string]any{"op": "push", "path": "interrupted", "hash": "pending", "size": Chunk + 1, "pieces": 2})
			if response(t, c)["res"] != "upload" {
				t.Fatal("upload denied")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if e := c.Write(ctx, websocket.MessageBinary, make([]byte, Chunk)); e != nil {
				t.Fatal(e)
			}
			if response(t, c)["res"] != "ok" {
				t.Fatal("missing piece ack")
			}
			stop, e := f.server.StartControl()
			if e != nil {
				t.Fatal(e)
			}
			defer stop()
			if _, e = Admin(f.s.Config, AdminRequest{Action: action, User: 1, Password: "a replacement password", File: 1}); e != nil {
				t.Fatal(e)
			}
			if action == "users.quota" {
				if e = c.Write(ctx, websocket.MessageBinary, []byte{0}); e != nil {
					t.Fatal(e)
				}
				if response(t, c)["res"] != "err" {
					t.Fatal("new file limit ignored at commit")
				}
			} else {
				if f.s.Authorize(f.token) == nil {
					t.Fatal("old session survived administrative change")
				}
				if _, _, e = c.Read(ctx); e == nil {
					t.Fatal("active upload survived administrative change")
				}
			}
			var count int
			if e = f.s.DB.QueryRow("SELECT COUNT(*) FROM revisions").Scan(&count); e != nil || count != 0 {
				t.Fatal("unfinished upload became visible", e)
			}
			if action == "users.password-reset" {
				if _, e = f.s.SignIn("owner@local.invalid", "a replacement password"); e != nil {
					t.Fatal(e)
				}
			}
		})
	}
}

func TestLegacyArchiveAndUnsafeSnapshots(t *testing.T) {
	f := setup(t)
	c := dial(t, f, 0, true)
	ready(t, c)
	uploadBytes(t, c, "archived", "opaque", []byte("retained ciphertext"))
	c.CloseNow()
	f.http.Close()
	f.server.Close()
	f.s.Close()
	root := t.TempDir()
	snap := filepath.Join(root, "snapshot")
	if e := BackupFormat(f.config, snap, "directory"); e != nil {
		t.Fatal(e)
	}
	// The original tar format has no checksum manifest and configuration first.
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	names, e := snapshotFiles(snap)
	if e != nil {
		t.Fatal(e)
	}
	ordered := []string{"config.json"}
	for _, n := range names {
		if n != "config.json" && n != "manifest.json" {
			ordered = append(ordered, n)
		}
	}
	for _, n := range ordered {
		b, e := os.ReadFile(filepath.Join(snap, n))
		if e != nil {
			t.Fatal(e)
		}
		if e = tw.WriteHeader(&tar.Header{Name: n, Mode: 0600, Size: int64(len(b)), Typeflag: tar.TypeReg}); e != nil {
			t.Fatal(e)
		}
		if _, e = tw.Write(b); e != nil {
			t.Fatal(e)
		}
	}
	if e = tw.Close(); e != nil {
		t.Fatal(e)
	}
	if e = gz.Close(); e != nil {
		t.Fatal(e)
	}
	archive := filepath.Join(root, "legacy.tar.gz")
	if e = os.WriteFile(archive, buffer.Bytes(), 0600); e != nil {
		t.Fatal(e)
	}
	if e = Restore(archive, filepath.Join(root, "legacy.json"), filepath.Join(root, "legacy")); e != nil {
		t.Fatal("legacy archive rejected", e)
	}
	for _, unsafe := range []string{"../escaped", "/absolute", "blobs/../../escaped"} {
		t.Run(unsafe, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "bad.zip")
			out, e := os.Create(file)
			if e != nil {
				t.Fatal(e)
			}
			zw := zip.NewWriter(out)
			b, _ := os.ReadFile(filepath.Join(snap, "config.json"))
			w, _ := zw.Create("config.json")
			w.Write(b)
			w, _ = zw.Create(unsafe)
			w.Write([]byte("bad"))
			zw.Close()
			out.Close()
			if e = RestoreSource(file, "", filepath.Join(root, "bad.json"), filepath.Join(root, "bad")); e == nil {
				t.Fatal("unsafe ZIP entry accepted")
			}
		})
	}
	var missing string
	filepath.WalkDir(filepath.Join(snap, "blobs"), func(p string, d os.DirEntry, e error) error {
		if e == nil && !d.IsDir() {
			missing = p
		}
		return e
	})
	if missing == "" {
		t.Fatal("fixture blob missing")
	}
	if e = os.Remove(missing); e != nil {
		t.Fatal(e)
	}
	if e = RestoreSource("", snap, filepath.Join(root, "missing.json"), filepath.Join(root, "missing")); e == nil {
		t.Fatal("snapshot with missing blob accepted")
	}
}

func TestMissingRevisionBlobReferenceFailsRecovery(t *testing.T) {
	f := setup(t)
	c := dial(t, f, 0, true)
	ready(t, c)
	uploadBytes(t, c, "opaque-reference", "opaque-reference-hash", []byte("opaque ciphertext"))
	c.CloseNow()
	r, e := f.s.Record(f.vault.ID, 1)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.DB.Exec("DELETE FROM blobs WHERE vault=?", f.vault.ID); e != nil {
		t.Fatal(e)
	}
	if e = f.s.CheckBlobs(true); e == nil {
		t.Fatal("missing revision blob index accepted")
	}
	if e = f.s.Recover(); e == nil {
		t.Fatal("recovery accepted inconsistent revision")
	}
	if _, e = os.Stat(f.s.BlobPath(f.vault.ID, r.Blob)); e != nil {
		t.Fatal("recovery removed acknowledged ciphertext", e)
	}
}
