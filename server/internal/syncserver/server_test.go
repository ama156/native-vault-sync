package syncserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fixture struct {
	s      *Store
	server *Server
	http   *httptest.Server
	token  string
	vault  Vault
	config string
}

func setup(t *testing.T) *fixture {
	t.Helper()
	c := DefaultConfig()
	c.DataDir = filepath.Join(t.TempDir(), "data")
	c.PublicURL = "http://127.0.0.1:8080"
	s, e := Open(c, true)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.InitOwner("owner@local.invalid", "Owner", "long-disposable-password"); e != nil {
		t.Fatal(e)
	}
	server := NewServer(s, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h := httptest.NewServer(server)
	s.Config.PublicURL = h.URL
	file := filepath.Join(filepath.Dir(c.DataDir), "config.json")
	if e = SaveConfig(file, s.Config); e != nil {
		t.Fatal(e)
	}
	f := &fixture{s: s, server: server, http: h, config: file}
	login := f.post(t, "/user/signin", map[string]any{"email": "owner@local.invalid", "password": "long-disposable-password"}, 200)
	f.token = login["token"].(string)
	v, e := s.CreateVault("Test vault", "test-salt", "opaque-keyhash", 3)
	if e != nil {
		t.Fatal(e)
	}
	f.vault = v
	t.Cleanup(func() { server.Close(); h.Close(); s.Close() })
	return f
}
func (f *fixture) post(t *testing.T, path string, m map[string]any, status int) map[string]any {
	t.Helper()
	b, _ := json.Marshal(m)
	r, e := http.Post(f.http.URL+path, "application/json", bytes.NewReader(b))
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	out := map[string]any{}
	if e = json.NewDecoder(r.Body).Decode(&out); e != nil {
		t.Fatal(e)
	}
	if r.StatusCode != status {
		t.Fatalf("%s: status %d: %v", path, r.StatusCode, out)
	}
	return out
}
func dial(t *testing.T, f *fixture, cursor int64, initial bool) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, e := websocket.Dial(ctx, strings.Replace(f.http.URL, "http", "ws", 1)+"/sync", nil)
	if e != nil {
		t.Fatal(e)
	}
	c.SetReadLimit(Chunk)
	send(t, c, map[string]any{"op": "init", "token": f.token, "id": f.vault.ID, "keyhash": f.vault.KeyHash, "encryption_version": f.vault.Encryption, "version": cursor, "initial": initial, "device": "test"})
	m := read(t, c)
	if m["res"] != "ok" {
		t.Fatalf("login: %v", m)
	}
	return c
}
func send(t *testing.T, c *websocket.Conn, m any) {
	t.Helper()
	b, _ := json.Marshal(m)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e := c.Write(ctx, websocket.MessageText, b); e != nil {
		t.Fatal(e)
	}
}
func read(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	kind, b, e := c.Read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if kind != websocket.MessageText {
		t.Fatal("expected JSON frame")
	}
	m := map[string]any{}
	if e = json.Unmarshal(b, &m); e != nil {
		t.Fatal(e)
	}
	return m
}
func response(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	for {
		m := read(t, c)
		if m["op"] == nil {
			return m
		}
	}
}
func ready(t *testing.T, c *websocket.Conn) []map[string]any {
	t.Helper()
	var records []map[string]any
	for {
		m := read(t, c)
		if m["op"] == "ready" {
			return records
		}
		records = append(records, m)
	}
}
func uploadBytes(t *testing.T, c *websocket.Conn, path, hash string, b []byte) int64 {
	t.Helper()
	send(t, c, map[string]any{"op": "push", "path": path, "hash": hash, "extension": "md", "ctime": 1, "mtime": 2, "size": len(b), "pieces": Pieces(int64(len(b)))})
	m := response(t, c)
	if m["res"] == "upload" {
		for start := 0; start < len(b); start += Chunk {
			end := start + Chunk
			if end > len(b) {
				end = len(b)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			e := c.Write(ctx, websocket.MessageBinary, b[start:end])
			cancel()
			if e != nil {
				t.Fatal(e)
			}
			m = response(t, c)
			if m["res"] != "ok" {
				t.Fatalf("upload acknowledgment: %v", m)
			}
		}
	} else if m["res"] != "ok" {
		t.Fatalf("push: %v", m)
	}
	return 0
}
func pullBytes(t *testing.T, c *websocket.Conn, uid int64) []byte {
	t.Helper()
	send(t, c, map[string]any{"op": "pull", "uid": uid})
	m := response(t, c)
	if m["res"] != "ok" {
		t.Fatal(m)
	}
	var out []byte
	for i := 0; i < int(m["pieces"].(float64)); i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		kind, b, e := c.Read(ctx)
		cancel()
		if e != nil {
			t.Fatal(e)
		}
		if kind != websocket.MessageBinary {
			t.Fatal("notification interrupted download")
		}
		out = append(out, b...)
	}
	return out
}
func TestNativeHTTPContractsAndPersistentSessions(t *testing.T) {
	f := setup(t)
	if len(f.token) != 68 {
		t.Fatal("invalid token")
	}
	var stored string
	if e := f.s.DB.QueryRow("SELECT hash FROM sessions").Scan(&stored); e != nil || stored == f.token {
		t.Fatal("raw session token persisted")
	}
	list := f.post(t, "/vault/list", map[string]any{"token": f.token, "supported_encryption_version": 3}, 200)
	if list["limit"] != float64(10) || len(list["vaults"].([]any)) != 1 {
		t.Fatal(list)
	}
	if f.post(t, "/subscription/list", map[string]any{"token": f.token}, 200)["sync"] != true {
		t.Fatal("missing native subscription capability")
	}
	if f.post(t, "/vault/access", map[string]any{"token": f.token, "vault_uid": f.vault.ID, "keyhash": "wrong", "encryption_version": 3, "host": f.vault.Host}, 200)["error"] == nil {
		t.Fatal("wrong key accepted")
	}
	f.post(t, "/vault/access", map[string]any{"token": f.token, "vault_uid": f.vault.ID, "keyhash": f.vault.KeyHash, "encryption_version": 3, "host": f.vault.Host}, 200)
	if f.post(t, "/vault/create", map[string]any{"token": f.token, "name": "Invalid", "encryption_version": 1}, 200)["error"] == nil {
		t.Fatal("invalid vault accepted")
	}
	admin, e := Open(f.s.Config, false)
	if e != nil {
		t.Fatal(e)
	}
	if e = admin.Authorize(f.token); e != nil {
		t.Fatal("session not persistent", e)
	}
	admin.Close()
	f.post(t, "/user/signout", map[string]any{"token": f.token}, 200)
	if f.post(t, "/user/info", map[string]any{"token": f.token}, 200)["error"] != "Not logged in" {
		t.Fatal("revoked token accepted")
	}
}
func TestMultipartRevisionHistoryDeletionRestore(t *testing.T) {
	f := setup(t)
	a := dial(t, f, 0, true)
	defer a.CloseNow()
	ready(t, a)
	data := bytes.Repeat([]byte{19, 27, 42}, (Chunk/3)+300)
	uploadBytes(t, a, "aabb", "ccdd", data)
	if got := pullBytes(t, a, 1); !bytes.Equal(got, data) {
		t.Fatal("ciphertext changed")
	}
	uploadBytes(t, a, "aabb", "eeff", []byte("encrypted-other"))
	if got := pullBytes(t, a, 1); !bytes.Equal(got, data) {
		t.Fatal("old revision was overwritten")
	}
	send(t, a, map[string]any{"op": "history", "path": "aabb", "last": 0})
	if len(response(t, a)["items"].([]any)) != 2 {
		t.Fatal("history lost")
	}
	send(t, a, map[string]any{"op": "push", "path": "aabb", "deleted": true})
	if response(t, a)["res"] != "ok" {
		t.Fatal("delete failed")
	}
	send(t, a, map[string]any{"op": "deleted", "suppressrenames": true})
	if len(response(t, a)["items"].([]any)) != 1 {
		t.Fatal("tombstone lost")
	}
	send(t, a, map[string]any{"op": "restore", "uid": 1})
	if response(t, a)["res"] != "ok" {
		t.Fatal("restore failed")
	}
	if got := pullBytes(t, a, 4); !bytes.Equal(got, data) {
		t.Fatal("restored wrong bytes")
	}
	b := dial(t, f, 2, false)
	defer b.CloseNow()
	records := ready(t, b)
	if len(records) != 2 || records[0]["uid"] != float64(3) || records[1]["uid"] != float64(4) {
		t.Fatal("cursor replay", records)
	}
}
func TestInterruptedUploadAndLimits(t *testing.T) {
	f := setup(t)
	a := dial(t, f, 0, true)
	ready(t, a)
	send(t, a, map[string]any{"op": "push", "path": "aa", "size": Chunk + 1, "pieces": 1})
	if response(t, a)["res"] != "err" {
		t.Fatal("bad count accepted")
	}
	send(t, a, map[string]any{"op": "push", "path": "aa", "hash": "cc", "size": Chunk + 1, "pieces": 2})
	if response(t, a)["res"] != "upload" {
		t.Fatal("upload not requested")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if e := a.Write(ctx, websocket.MessageBinary, make([]byte, Chunk)); e != nil {
		t.Fatal(e)
	}
	cancel()
	response(t, a)
	a.CloseNow()
	for i := 0; i < 100; i++ {
		f.s.mu.Lock()
		reserved := f.s.reserved
		f.s.mu.Unlock()
		if reserved == 0 {
			break
		}
		time.Sleep(time.Millisecond * 10)
	}
	v, e := f.s.Vault(f.vault.ID)
	if e != nil || v.Version != 0 {
		t.Fatal("partial upload committed")
	}
	files, _ := os.ReadDir(filepath.Join(f.s.Config.DataDir, "uploads"))
	if len(files) != 0 {
		t.Fatal("abandoned temp file")
	}
	f.s.Config.MaxStorage = 10
	b := dial(t, f, 0, true)
	defer b.CloseNow()
	ready(t, b)
	send(t, b, map[string]any{"op": "push", "path": "aa", "hash": "cc", "size": 20, "pieces": 1})
	if response(t, b)["res"] != "err" {
		t.Fatal("quota ignored")
	}
}
func TestReplayLargerThanQueueAndCrossVaultIsolation(t *testing.T) {
	f := setup(t)
	a := dial(t, f, 0, true)
	defer a.CloseNow()
	ready(t, a)
	for i := 0; i < 150; i++ {
		uploadBytes(t, a, fmt.Sprintf("%04x", i), "", nil)
	}
	b := dial(t, f, 0, true)
	defer b.CloseNow()
	records := ready(t, b)
	if len(records) != 150 {
		t.Fatalf("snapshot truncated at %d", len(records))
	}
	other, e := f.s.CreateVault("Other", "other-salt", "other-key", 3)
	if e != nil {
		t.Fatal(e)
	}
	f.vault = other
	c := dial(t, f, 0, true)
	defer c.CloseNow()
	if len(ready(t, c)) != 0 {
		t.Fatal("cross-vault replay")
	}
	send(t, c, map[string]any{"op": "pull", "uid": 1})
	if response(t, c)["res"] != "err" {
		t.Fatal("cross-vault revision access")
	}
}
func TestRevokedLiveSessionAndBadOrigin(t *testing.T) {
	f := setup(t)
	c := dial(t, f, 0, true)
	defer c.CloseNow()
	ready(t, c)
	if e := f.s.SignOut(f.token); e != nil {
		t.Fatal(e)
	}
	send(t, c, map[string]any{"op": "ping"})
	if read(t, c)["res"] != "err" {
		t.Fatal("revoked session still usable")
	}
	r, _ := http.NewRequest("GET", f.http.URL+"/healthz", nil)
	r.Header.Set("Origin", "https://untrusted.example")
	res, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal("untrusted website accepted")
	}
}
func TestBackupRestoreAndExclusiveLock(t *testing.T) {
	f := setup(t)
	c := dial(t, f, 0, true)
	ready(t, c)
	data := []byte("opaque-fixture-bytes")
	uploadBytes(t, c, "aa", "bb", data)
	c.CloseNow()
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	if e := Backup(f.config, archive); e == nil {
		t.Fatal("backup allowed while service owns data lock")
	}
	f.server.Close()
	f.http.Close()
	f.s.Close()
	if e := Backup(f.config, archive); e != nil {
		t.Fatal(e)
	}
	root := t.TempDir()
	config := filepath.Join(root, "restored.json")
	dir := filepath.Join(root, "restored")
	if e := Restore(archive, config, dir); e != nil {
		t.Fatal(e)
	}
	cfg, e := LoadConfig(config)
	if e != nil {
		t.Fatal(e)
	}
	s, e := Open(cfg, true)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	r, e := s.Record(f.vault.ID, 1)
	if e != nil {
		t.Fatal(e)
	}
	got, e := os.ReadFile(s.BlobPath(f.vault.ID, r.Blob))
	if e != nil || !bytes.Equal(got, data) {
		t.Fatal("restored ciphertext mismatch", e)
	}
	if e = s.Authorize(f.token); e != nil {
		t.Fatal("session not restored", e)
	}
	if e = Restore(archive, config, dir); e == nil {
		t.Fatal("restore overwrote existing data")
	}
}

func TestAdvertisedPlaintextLimitAllowsGCMOverhead(t *testing.T) {
	f := setup(t)
	f.s.Config.MaxFile = 16
	c := dial(t, f, 0, true)
	defer c.CloseNow()
	ready(t, c)
	uploadBytes(t, c, "aa", "bb", make([]byte, 44))
	send(t, c, map[string]any{"op": "push", "path": "cc", "size": 45, "pieces": 1})
	if response(t, c)["res"] != "err" {
		t.Fatal("file limit ignored")
	}
}
func TestCommitFailureAndStartupRecovery(t *testing.T) {
	f := setup(t)
	c := dial(t, f, 0, true)
	ready(t, c)
	if _, e := f.s.DB.Exec("PRAGMA query_only=ON"); e != nil {
		t.Fatal(e)
	}
	send(t, c, map[string]any{"op": "push", "path": "aa", "hash": "bb", "size": 3, "pieces": 1})
	if response(t, c)["res"] != "upload" {
		t.Fatal("upload not requested")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if e := c.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3}); e != nil {
		t.Fatal(e)
	}
	cancel()
	if response(t, c)["res"] != "err" {
		t.Fatal("failed commit was acknowledged")
	}
	if _, e := f.s.DB.Exec("PRAGMA query_only=OFF"); e != nil {
		t.Fatal(e)
	}
	v, e := f.s.Vault(f.vault.ID)
	if e != nil || v.Version != 0 {
		t.Fatal("failed commit became visible")
	}
	c.CloseNow()
	f.server.Close()
	f.http.Close()
	f.s.Close()
	reopened, e := Open(f.s.Config, true)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	var files int
	filepath.WalkDir(filepath.Join(reopened.Config.DataDir, "blobs"), func(_ string, d os.DirEntry, e error) error {
		if e == nil && !d.IsDir() {
			files++
		}
		return e
	})
	if files != 0 {
		t.Fatal("orphan ciphertext survived recovery")
	}
}

func TestDatabaseFailureDoesNotLogOutNativeAccount(t *testing.T) {
	f := setup(t)
	if _, e := f.s.DB.Exec("DROP TABLE sessions"); e != nil {
		t.Fatal(e)
	}
	result := f.post(t, "/user/info", map[string]any{"token": f.token}, 200)
	if result["error"] != "Authentication temporarily unavailable" {
		t.Fatal("database failure misclassified as expired account", result)
	}
}
