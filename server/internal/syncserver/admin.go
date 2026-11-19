package syncserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type AdminRequest struct {
	Action   string `json:"action"`
	Email    string `json:"email,omitempty"`
	Name     string `json:"name,omitempty"`
	Password string `json:"password,omitempty"`
	User     int    `json:"user,omitempty"`
	Vault    string `json:"vault,omitempty"`
	Session  string `json:"session,omitempty"`
	Storage  int64  `json:"storage,omitempty"`
	Vaults   int    `json:"vaults,omitempty"`
	File     int64  `json:"file,omitempty"`
}
type adminResponse struct {
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

func (s *Store) admin(r AdminRequest) (any, error) {
	if r.User == 0 && r.Email != "" && r.Action != "users.add" {
		u, e := s.UserByEmail(r.Email)
		if e != nil {
			return nil, errors.New("user not found")
		}
		r.User = u.ID
	}
	switch r.Action {
	case "users.list":
		return s.Users()
	case "users.add":
		return s.AddUser(r.Email, r.Name, r.Password)
	case "users.disable":
		return nil, s.SetDisabled(r.User, true)
	case "users.enable":
		return nil, s.SetDisabled(r.User, false)
	case "users.password-reset":
		return nil, s.ChangePassword(r.User, r.Password)
	case "users.quota":
		u, e := s.User(r.User)
		if e != nil {
			return nil, e
		}
		if r.Storage == 0 {
			r.Storage = u.MaxStorage
		}
		if r.Vaults == 0 {
			r.Vaults = u.MaxVaults
		}
		if r.File == 0 {
			r.File = u.MaxFile
		}
		return nil, s.SetQuota(r.User, r.Storage, r.Vaults, r.File)
	case "users.usage":
		n, e := s.Usage(r.User)
		return map[string]any{"user": r.User, "charged_bytes": n}, e
	case "vaults.list":
		if r.User > 0 {
			return s.VaultsFor(r.User)
		}
		return s.Vaults()
	case "vaults.members":
		return s.Members(r.Vault)
	case "vaults.grant":
		return nil, s.SetMember(r.Vault, r.User, true)
	case "vaults.revoke":
		return nil, s.SetMember(r.Vault, r.User, false)
	case "sessions.revoke":
		if len(r.Session) != 64 {
			return nil, errors.New("full hashed session ID required")
		}
		query := "DELETE FROM sessions WHERE hash=?"
		args := []any{r.Session}
		if r.User > 0 {
			query += " AND user_id=?"
			args = append(args, r.User)
		}
		_, e := s.DB.Exec(query, args...)
		return nil, e
	case "sessions.list":
		query := "SELECT hash,user_id,created,expires FROM sessions"
		args := []any{}
		if r.User > 0 {
			query += " WHERE user_id=?"
			args = append(args, r.User)
		}
		query += " ORDER BY created"
		rows, e := s.DB.Query(query, args...)
		if e != nil {
			return nil, e
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var hash string
			var id int
			var created, expires int64
			if e = rows.Scan(&hash, &id, &created, &expires); e != nil {
				return nil, e
			}
			out = append(out, map[string]any{"id": hash, "user": id, "created": created, "expires": expires})
		}
		return out, rows.Err()
	}
	return nil, errors.New("unknown administrative action")
}
func (s *Server) StartControl() (func(), error) {
	path := filepath.Join(s.Store.Config.DataDir, "admin.sock")
	if len(path) > 100 {
		return nil, errors.New("data directory is too long for Unix control socket")
	}
	if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	ln, e := net.Listen("unix", path)
	if e != nil {
		return nil, e
	}
	if e = os.Chmod(path, 0600); e != nil {
		ln.Close()
		return nil, e
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/admin" {
			http.NotFound(w, r)
			return
		}
		var request AdminRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		decoder.DisallowUnknownFields()
		if e := decoder.Decode(&request); e != nil {
			reply(w, 400, adminResponse{Error: "invalid administrative request"})
			return
		}
		if decoder.Decode(&struct{}{}) != io.EOF {
			reply(w, 400, adminResponse{Error: "invalid administrative request"})
			return
		}
		select {
		case s.loginSlots <- struct{}{}:
			defer func() { <-s.loginSlots }()
		default:
			reply(w, 429, adminResponse{Error: "administration busy"})
			return
		}
		s.policyMu.Lock()
		defer s.policyMu.Unlock()
		data, e := s.Store.admin(request)
		s.disconnectUnauthorized()
		target := request.User
		if target == 0 && request.Email != "" {
			if u, err := s.Store.UserByEmail(request.Email); err == nil {
				target = u.ID
			}
		}
		s.Log.Info("administrative action", "action", request.Action, "user", target, "vault", request.Vault, "success", e == nil)
		if e != nil {
			reply(w, 200, adminResponse{Error: e.Error()})
			return
		}
		reply(w, 200, adminResponse{Data: data})
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 90 * time.Second, MaxHeaderBytes: 8192}
	go server.Serve(ln)
	return func() { server.Close(); os.Remove(path) }, nil
}
func Admin(c Config, r AdminRequest) (any, error) {
	data, e := json.Marshal(r)
	if e != nil {
		return nil, e
	}
	path := filepath.Join(c.DataDir, "admin.sock")
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "unix", path)
	}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 90 * time.Second}
	response, e := client.Post("http://unix/admin", "application/json", bytes.NewReader(data))
	if e == nil {
		defer response.Body.Close()
		var result adminResponse
		if e = json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(&result); e != nil {
			return nil, e
		}
		if result.Error != "" {
			return nil, errors.New(result.Error)
		}
		return result.Data, nil
	}
	// An unavailable socket never permits concurrent direct writes: Open must win
	// the service's exclusive data lock before any offline administrative action.
	if e := regularFile(filepath.Join(c.DataDir, "metadata.sqlite")); e != nil {
		return nil, e
	}
	store, e := Open(c, true)
	if e != nil {
		return nil, e
	}
	defer store.Close()
	result, adminErr := store.admin(r)
	target := r.User
	if target == 0 && r.Email != "" {
		if u, err := store.UserByEmail(r.Email); err == nil {
			target = u.ID
		}
	}
	slog.New(slog.NewJSONHandler(os.Stderr, nil)).Info("offline administrative action", "action", r.Action, "user", target, "vault", r.Vault, "success", adminErr == nil)
	return result, adminErr
}
