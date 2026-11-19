package syncserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/coder/websocket"
)

type message struct {
	Op              string `json:"op"`
	Token           string `json:"token"`
	ID              string `json:"id"`
	KeyHash         string `json:"keyhash"`
	Encryption      int    `json:"encryption_version"`
	Version         int64  `json:"version"`
	Initial         bool   `json:"initial"`
	Device          string `json:"device"`
	Path            string `json:"path"`
	Related         string `json:"relatedpath"`
	Extension       string `json:"extension"`
	Hash            string `json:"hash"`
	Ctime           int64  `json:"ctime"`
	Mtime           int64  `json:"mtime"`
	Folder          bool   `json:"folder"`
	Deleted         bool   `json:"deleted"`
	Size            *int64 `json:"size"`
	Pieces          *int64 `json:"pieces"`
	UID             int64  `json:"uid"`
	Last            int64  `json:"last"`
	SuppressRenames bool   `json:"suppressrenames"`
}
type outbound struct {
	JSON any
	File string
	Size int64
	Done chan error
}
type upload struct {
	file                          *os.File
	record                        Record
	size, received, pieces, count int64
}
type client struct {
	server               *Server
	conn                 *websocket.Conn
	ctx                  context.Context
	cancel               context.CancelFunc
	out                  chan outbound
	vault, token, device string
	user                 int
	authReady            chan struct{}
	authenticated        bool
	pending              *upload
}

func (c *client) send(body any) bool {
	select {
	case c.out <- outbound{JSON: body}:
		return true
	default:
		c.cancel()
		return false
	}
}
func (c *client) fail(err error) {
	c.server.Log.Warn("sync operation rejected")
	c.send(map[string]any{"res": "err", "msg": err.Error(), "err": err.Error()})
}
func (c *client) reject(err error) {
	done := make(chan error, 1)
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case c.out <- outbound{JSON: map[string]any{"res": "err", "msg": err.Error(), "err": err.Error()}, Done: done}:
	case <-c.ctx.Done():
		return
	case <-timer.C:
		return
	}
	select {
	case <-done:
	case <-c.ctx.Done():
	case <-timer.C:
	}
}
func (c *client) replay(body any) error {
	timer := time.NewTimer(45 * time.Second)
	defer timer.Stop()
	select {
	case c.out <- outbound{JSON: body}:
		return nil
	case <-c.ctx.Done():
		return c.ctx.Err()
	case <-timer.C:
		return errors.New("Client replay too slow")
	}
}
func (c *client) cleanupUpload() {
	if p := c.pending; p != nil {
		p.file.Close()
		os.Remove(p.file.Name())
		c.server.Store.releaseFor(c.vault, c.user, p.size)
		c.pending = nil
	}
}
func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		reply(w, 503, map[string]any{"error": "Connection limit reached"})
		return
	}
	// ServeHTTP already validates Origin. InsecureSkipVerify here is the
	// WebSocket library's origin-check option, not a TLS setting.
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if e != nil {
		return
	}
	conn.SetReadLimit(Chunk)
	ctx, cancel := context.WithCancel(r.Context())
	c := &client{server: s, conn: conn, ctx: ctx, cancel: cancel, out: make(chan outbound, 64), authReady: make(chan struct{})}
	defer cancel()
	defer conn.CloseNow()
	defer c.cleanupUpload()
	s.clientsMu.Lock()
	if s.closing {
		s.clientsMu.Unlock()
		return
	}
	s.clients[c] = false
	s.wg.Add(1)
	s.clientsMu.Unlock()
	defer s.wg.Done()
	s.Log.Info("sync connection opened")
	go c.writer()
	defer func() {
		s.clientsMu.Lock()
		delete(s.clients, c)
		s.clientsMu.Unlock()
		s.Log.Info("sync connection closed")
	}()
	for {
		timeout := 130 * time.Second
		if !c.authenticated {
			timeout = 10 * time.Second
		}
		if c.pending != nil {
			timeout = 60 * time.Second
		}
		readctx, done := context.WithTimeout(ctx, timeout)
		kind, data, e := conn.Read(readctx)
		done()
		if e != nil {
			return
		}
		if c.authenticated {
			if e = s.Store.Authorize(c.token); e != nil {
				if errors.Is(e, ErrAuth) {
					c.reject(ErrAuth)
				} else {
					c.reject(errors.New("Authentication temporarily unavailable"))
				}
				return
			}
			if _, e = s.Store.Vault(c.vault); e != nil {
				if errors.Is(e, sql.ErrNoRows) {
					c.reject(errors.New("Vault not found"))
				} else {
					c.reject(errors.New("Vault temporarily unavailable"))
				}
				return
			}
		}
		if kind == websocket.MessageBinary {
			if e = c.binary(data); e != nil {
				c.cleanupUpload()
				c.fail(e)
			}
			continue
		}
		if len(data) > 65536 {
			c.fail(errors.New("Metadata frame too large"))
			return
		}
		if c.authenticated && (!s.limiter.allow("requests-global", s.Store.Config.GlobalRequestsPerMinute) || !s.limiter.allow(fmt.Sprintf("requests:%d", c.user), s.Store.Config.RequestsPerMinute)) {
			c.reject(errors.New("Request limit reached"))
			return
		}
		var m message
		if e = json.Unmarshal(data, &m); e != nil {
			c.fail(errors.New("Invalid JSON message"))
			continue
		}
		if !c.authenticated {
			if m.Op != "init" {
				c.reject(errors.New("Initialize first"))
				return
			}
			if e = c.init(m); e != nil {
				c.reject(e)
				return
			}
			continue
		}
		if !c.server.authorizedClient(c) {
			c.cancel()
			return
		}
		if m.Op == "ping" {
			c.send(map[string]any{"op": "pong"})
			continue
		}
		if c.pending != nil {
			c.fail(errors.New("Upload awaiting binary pieces"))
			continue
		}
		if e = c.operation(m); e != nil {
			c.fail(e)
		}
	}
}
func (c *client) writer() {
	defer c.cancel()
	defer c.conn.CloseNow()
	for {
		select {
		case <-c.ctx.Done():
			return
		case item := <-c.out:
			select {
			case <-c.authReady:
				if !c.server.authorizedClient(c) {
					return
				}
			default:
			}
			data, e := json.Marshal(item.JSON)
			if e != nil {
				return
			}
			ctx, done := context.WithTimeout(c.ctx, 60*time.Second)
			c.server.policyMu.RLock()
			select {
			case <-c.authReady:
				if !c.server.authorizedClient(c) {
					c.server.policyMu.RUnlock()
					done()
					return
				}
			default:
			}
			e = c.conn.Write(ctx, websocket.MessageText, data)
			c.server.policyMu.RUnlock()
			done()
			if item.Done != nil {
				item.Done <- e
			}
			if e != nil {
				return
			}
			if item.File != "" {
				f, e := os.Open(item.File)
				if e != nil {
					return
				}
				buffer := make([]byte, Chunk)
				remaining := item.Size
				for remaining > 0 {
					size := int64(Chunk)
					if remaining < size {
						size = remaining
					}
					if _, e = io.ReadFull(f, buffer[:size]); e != nil {
						f.Close()
						return
					}
					ctx, done := context.WithTimeout(c.ctx, 60*time.Second)
					c.server.policyMu.RLock()
					if !c.server.authorizedClient(c) {
						c.server.policyMu.RUnlock()
						done()
						f.Close()
						return
					}
					e = c.conn.Write(ctx, websocket.MessageBinary, buffer[:size])
					c.server.policyMu.RUnlock()
					done()
					if e != nil {
						f.Close()
						return
					}
					remaining -= size
				}
				f.Close()
			}
		}
	}
}
func (c *client) init(m message) error {
	principal, e := c.server.Store.Principal(m.Token)
	if e != nil {
		if errors.Is(e, ErrAuth) {
			return ErrAuth
		}
		return errors.New("Authentication temporarily unavailable")
	}
	if m.Version < 0 || m.Version > 9007199254740991 {
		return errors.New("Invalid revision cursor")
	}
	if len(m.Device) > 200 {
		return errors.New("Device name too long")
	}
	s := c.server.Store
	s.mu.Lock()
	defer s.mu.Unlock()
	if e = s.Access(principal.ID, m.ID); e != nil {
		return errors.New("Vault not found")
	}
	v, e := s.Vault(m.ID)
	if e != nil {
		if errors.Is(e, sql.ErrNoRows) {
			return errors.New("Vault not found")
		}
		return errors.New("Vault temporarily unavailable")
	}
	if m.KeyHash != v.KeyHash || m.Encryption != v.Encryption || !Supported(m.Encryption) {
		return errors.New("Encryption mismatch")
	}
	if m.Version > v.Version {
		return errors.New("Client cursor exceeds server history; reconnect this vault after restoring server state")
	}
	c.server.clientsMu.Lock()
	count := 0
	for other := range c.server.clients {
		select {
		case <-other.authReady:
			if other.user == principal.ID {
				count++
			}
		default:
		}
	}
	if count >= s.Config.UserConnections {
		c.server.clientsMu.Unlock()
		return errors.New("User connection limit reached")
	}
	c.user = principal.ID
	c.vault = m.ID
	c.token = m.Token
	c.device = m.Device
	c.authenticated = true
	close(c.authReady)
	c.server.clientsMu.Unlock()
	if e = c.replay(map[string]any{"res": "ok", "userId": principal.ID, "perFileMax": min(s.Config.MaxFile, principal.MaxFile)}); e != nil {
		return e
	}
	var records []Record
	if m.Initial {
		records, e = s.Latest(m.ID)
	} else {
		records, e = s.Records(m.ID, "AND uid>? ORDER BY uid", m.Version)
	}
	if e != nil {
		return errors.New("Could not replay vault history")
	}
	for _, r := range records {
		if m.Initial && r.Deleted {
			continue
		}
		if e = c.replay(pushJSON(r)); e != nil {
			return e
		}
	}
	if e = c.replay(map[string]any{"op": "ready", "version": v.Version}); e != nil {
		return e
	}
	c.server.clientsMu.Lock()
	c.server.clients[c] = true
	c.server.clientsMu.Unlock()
	return nil
}
func pushJSON(r Record) map[string]any {
	b, _ := json.Marshal(r)
	out := map[string]any{}
	_ = json.Unmarshal(b, &out)
	out["op"] = "push"
	return out
}
func (s *Server) broadcast(vault string, r Record) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	for c, active := range s.clients {
		if active && c.vault == vault {
			if s.Store.Authorize(c.token) != nil {
				c.cancel()
				continue
			}
			c.send(pushJSON(r))
		}
	}
}
func (s *Server) disconnectVault(vault string) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	for c := range s.clients {
		if c.vault == vault {
			c.cancel()
		}
	}
}
func (c *client) commit(r Record) error {
	s := c.server.Store
	s.mu.Lock()
	defer s.mu.Unlock()
	r.Device = c.device
	if r.Blob != "" {
		var exists int
		if e := s.DB.QueryRow("SELECT COUNT(*) FROM blobs WHERE vault=? AND hash=?", c.vault, r.Blob).Scan(&exists); e != nil {
			return e
		}
		if exists == 0 {
			if e := s.quotaCheck(c.vault, 0); e != nil {
				return e
			}
		}
	}
	record, e := s.commit(c.vault, r, c.token)
	if e != nil {
		return errors.New("Could not persist revision")
	}
	c.server.broadcast(c.vault, record)
	return nil
}
func (c *client) binary(data []byte) error {
	if !c.server.authorizedClient(c) {
		return ErrAuth
	}
	p := c.pending
	if !c.authenticated || p == nil {
		return errors.New("Unexpected binary frame")
	}
	remaining := p.size - p.received
	expected := int64(Chunk)
	if remaining < expected {
		expected = remaining
	}
	if int64(len(data)) != expected {
		return errors.New("Incorrect piece size")
	}
	if _, e := p.file.Write(data); e != nil {
		return errors.New("Could not write upload")
	}
	p.received += int64(len(data))
	p.count++
	if p.count == p.pieces {
		if p.received != p.size {
			return errors.New("Incomplete upload")
		}
		blob, e := c.server.Store.InstallBlob(c.vault, p.file)
		if e != nil {
			return errors.New("Could not persist ciphertext")
		}
		p.record.Blob = blob
		if e = c.commit(p.record); e != nil {
			return e
		}
		c.server.Store.releaseFor(c.vault, c.user, p.size)
		c.pending = nil
	}
	c.send(map[string]any{"res": "ok"})
	return nil
}
func (c *client) operation(m message) error {
	if !c.server.authorizedClient(c) {
		return ErrAuth
	}

	s := c.server.Store
	switch m.Op {
	case "push":
		if m.Path == "" || len(m.Path) > 20000 || len(m.Related) > 20000 || len(m.Hash) > 20000 || len(m.Extension) > 32 {
			return errors.New("Invalid opaque metadata")
		}
		r := Record{Path: m.Path, Related: m.Related, Extension: m.Extension, Hash: m.Hash, Ctime: m.Ctime, Mtime: m.Mtime, Folder: m.Folder, Deleted: m.Deleted}
		if m.Folder || m.Deleted {
			if e := c.commit(r); e != nil {
				return e
			}
			c.send(map[string]any{"res": "ok"})
			return nil
		}
		// Native perFileMax is checked against plaintext file size. Nonempty
		// v0/v2/v3 content adds a 12-byte IV and 16-byte authentication tag.
		if m.Size == nil || m.Pieces == nil || *m.Size < 0 || *m.Size > s.Config.MaxFile+28 || *m.Pieces != Pieces(*m.Size) {
			return errors.New("Invalid ciphertext size or piece count")
		}
		principal, e := s.User(c.user)
		if e != nil {
			return e
		}
		if *m.Size > principal.MaxFile+28 {
			return errors.New("File limit reached")
		}
		r.Size = *m.Size
		if m.Hash != "" {
			old, e := s.Records(c.vault, "AND path=? AND hash=? AND size=? AND deleted=0 AND folder=0 ORDER BY uid DESC LIMIT 1", m.Path, m.Hash, r.Size)
			if e != nil {
				return errors.New("Could not check existing content")
			}
			if len(old) > 0 && old[0].Blob != "" {
				r.Blob = old[0].Blob
				if e = c.commit(r); e != nil {
					return e
				}
				c.send(map[string]any{"res": "ok"})
				return nil
			}
		}
		if r.Size == 0 {
			if e := c.commit(r); e != nil {
				return e
			}
			c.send(map[string]any{"res": "ok"})
			return nil
		}
		if e := s.reserveFor(c.vault, c.user, r.Size); e != nil {
			return e
		}
		f, e := os.CreateTemp(filepath.Join(s.Config.DataDir, "uploads"), "upload-")
		if e != nil {
			s.releaseFor(c.vault, c.user, r.Size)
			return errors.New("Could not create upload")
		}
		c.pending = &upload{file: f, record: r, size: r.Size, pieces: *m.Pieces}
		c.send(map[string]any{"res": "upload"})
	case "pull":
		r, e := s.Record(c.vault, m.UID)
		if e != nil {
			return errors.New("Revision not found")
		}
		item := outbound{JSON: map[string]any{"res": "ok", "deleted": r.Deleted, "size": r.Size, "pieces": Pieces(r.Size)}, Size: r.Size}
		if r.Blob != "" && r.Size > 0 {
			item.File = s.BlobPath(c.vault, r.Blob)
		}
		select {
		case c.out <- item:
		default:
			c.cancel()
		}
	case "history":
		where := "AND path=? ORDER BY uid DESC LIMIT 101"
		args := []any{m.Path}
		if m.Last > 0 {
			where = "AND path=? AND uid<? ORDER BY uid DESC LIMIT 101"
			args = append(args, m.Last)
		}
		items, e := s.Records(c.vault, where, args...)
		if e != nil {
			return errors.New("Could not read history")
		}
		more := len(items) > 100
		if more {
			items = items[:100]
		}
		c.send(map[string]any{"res": "ok", "items": items, "more": more})
	case "deleted":
		items, e := s.Latest(c.vault)
		if e != nil {
			return errors.New("Could not read deleted files")
		}
		deleted := []Record{}
		for _, r := range items {
			if r.Deleted && (!m.SuppressRenames || r.Related == "") {
				deleted = append(deleted, r)
			}
		}
		c.send(map[string]any{"res": "ok", "items": deleted})
	case "restore":
		r, e := s.Record(c.vault, m.UID)
		if e != nil || r.Deleted {
			return errors.New("Restorable revision not found")
		}
		r.Mtime = time.Now().UnixMilli()
		if e = c.commit(r); e != nil {
			return e
		}
		c.send(map[string]any{"res": "ok"})
	case "size":
		used, e := s.Usage(c.user)
		if e != nil {
			return errors.New("Could not read storage usage")
		}
		vaultSize, e := s.VaultSize(c.vault)
		if e != nil {
			return errors.New("Could not read vault usage")
		}
		c.send(map[string]any{"res": "ok", "size": used, "limit": func() int64 { u, _ := s.User(c.user); return u.MaxStorage }(), "vault_size": vaultSize})
	case "usernames":
		rows, e := s.DB.Query("SELECT DISTINCT u.id,u.name FROM users u WHERE u.id IN (SELECT user_id FROM memberships WHERE vault_id=? UNION SELECT user_id FROM revisions WHERE vault=?)", c.vault, c.vault)
		if e != nil {
			return errors.New("Could not read contributors")
		}
		users := map[string]string{}
		for rows.Next() {
			var id int
			var name string
			if e = rows.Scan(&id, &name); e != nil {
				rows.Close()
				return e
			}
			users[fmt.Sprint(id)] = name
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		c.send(map[string]any{"res": "ok", "users": users})
	case "purge":
		return errors.New("Purge is not supported; history is retained indefinitely")
	default:
		return errors.New("Unsupported Sync operation")
	}
	return nil
}
