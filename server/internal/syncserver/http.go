package syncserver

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Server struct {
	Store      *Store
	Log        *slog.Logger
	clientsMu  sync.Mutex
	clients    map[*client]bool
	slots      chan struct{}
	loginSlots chan struct{}
	loginMu    sync.Mutex
	attempts   []time.Time
	closing    bool
	wg         sync.WaitGroup
}

func NewServer(store *Store, log *slog.Logger) *Server {
	return &Server{Store: store, Log: log, clients: map[*client]bool{}, slots: make(chan struct{}, 64), loginSlots: make(chan struct{}, 2)}
}
func (s *Server) Close() {
	s.clientsMu.Lock()
	s.closing = true
	for c := range s.clients {
		c.cancel()
	}
	s.clientsMu.Unlock()
	s.wg.Wait()
}
func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	allowed := origin == "app://obsidian.md" || origin == "capacitor://localhost" || origin == "null" || origin == strings.TrimSuffix(s.Store.Config.PublicURL, "/")
	if origin != "" && allowed {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	}
	if origin != "" && !allowed {
		reply(w, 403, map[string]any{"error": "Origin not allowed"})
		return
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/healthz" {
		_, e := s.Store.Account()
		if e != nil {
			reply(w, 503, map[string]any{"service": Service, "bridge_protocol": 1, "ready": false})
			return
		}
		reply(w, 200, map[string]any{"service": Service, "bridge_protocol": 1, "ready": true, "version": Version})
		return
	}
	if r.URL.Path == "/sync" {
		if r.Method != "GET" {
			reply(w, 405, map[string]any{"error": "WebSocket upgrade required"})
			return
		}
		s.websocket(w, r)
		return
	}
	if r.Method != "POST" {
		reply(w, 404, map[string]any{"error": "Unknown route"})
		return
	}
	var m struct {
		Token      string `json:"token"`
		Email      string `json:"email"`
		Password   string `json:"password"`
		MFA        string `json:"mfa"`
		Name       string `json:"name"`
		Vault      string `json:"vault_uid"`
		KeyHash    string `json:"keyhash"`
		Salt       string `json:"salt"`
		Host       string `json:"host"`
		Encryption int    `json:"encryption_version"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
	if e := decoder.Decode(&m); e != nil {
		reply(w, 400, map[string]any{"error": "Invalid JSON body"})
		return
	}
	if e := decoder.Decode(&struct{}{}); e != io.EOF {
		reply(w, 400, map[string]any{"error": "Expected one JSON object"})
		return
	}
	fail := func(e error) {
		s.Log.Warn("account operation rejected")
		// Both native helpers understand application errors in JSON. Newer
		// clients skip JSON parsing for non-2xx replies and lose this message.
		reply(w, 200, map[string]any{"error": e.Error()})
	}
	if r.URL.Path == "/user/signin" {
		s.loginMu.Lock()
		now := time.Now()
		kept := s.attempts[:0]
		for _, t := range s.attempts {
			if now.Sub(t) < time.Minute {
				kept = append(kept, t)
			}
		}
		s.attempts = kept
		if len(s.attempts) >= 10 {
			s.loginMu.Unlock()
			reply(w, 429, map[string]any{"error": "Too many login attempts; retry in one minute"})
			return
		}
		s.attempts = append(s.attempts, now)
		s.loginMu.Unlock()
		select {
		case s.loginSlots <- struct{}{}:
			defer func() { <-s.loginSlots }()
		default:
			reply(w, 429, map[string]any{"error": "Login busy; retry shortly"})
			return
		}
		if m.MFA != "" {
			fail(errors.New("MFA is not enabled on this personal server"))
			return
		}
		token, e := s.Store.SignIn(m.Email, m.Password)
		if e != nil {
			fail(e)
			return
		}
		account, e := s.Store.Account()
		if e != nil {
			fail(errors.New("Account unavailable"))
			return
		}
		account["token"] = token
		reply(w, 200, account)
		return
	}
	if e := s.Store.Authorize(m.Token); e != nil {
		if errors.Is(e, ErrAuth) {
			fail(ErrAuth)
		} else {
			fail(errors.New("Authentication temporarily unavailable"))
		}
		return
	}
	switch r.URL.Path {
	case "/user/info":
		a, e := s.Store.Account()
		if e != nil {
			fail(errors.New("Account unavailable"))
			return
		}
		reply(w, 200, a)
	case "/user/signout":
		if e := s.Store.SignOut(m.Token); e != nil {
			fail(errors.New("Could not revoke session"))
			return
		}
		reply(w, 200, map[string]any{"res": "ok"})
	case "/subscription/list":
		reply(w, 200, map[string]any{"sync": true})
	case "/vault/list":
		v, e := s.Store.Vaults()
		if e != nil {
			fail(errors.New("Could not list vaults"))
			return
		}
		reply(w, 200, map[string]any{"vaults": v, "shared": []any{}, "limit": s.Store.Config.MaxVaults})
	case "/vault/regions":
		reply(w, 200, map[string]any{"regions": []any{map[string]any{"value": "self-hosted", "name": "Self-hosted"}}})
	case "/vault/create":
		if strings.TrimSpace(m.Name) == "" || len(m.Name) > 256 || len(m.Salt) == 0 || len(m.Salt) > 1024 || len(m.KeyHash) == 0 || len(m.KeyHash) > 1024 || !Supported(m.Encryption) {
			fail(errors.New("Vault requires a name, salt, keyhash, and supported end-to-end encryption version"))
			return
		}
		var count int
		if e := s.Store.DB.QueryRow("SELECT COUNT(*) FROM vaults WHERE deleted=0").Scan(&count); e != nil {
			fail(errors.New("Database unavailable"))
			return
		}
		if count >= s.Store.Config.MaxVaults {
			fail(errors.New("Vault limit reached"))
			return
		}
		v, e := s.Store.CreateVault(m.Name, m.Salt, m.KeyHash, m.Encryption)
		if e != nil {
			fail(errors.New("Could not create vault"))
			return
		}
		reply(w, 200, v)
	case "/vault/access":
		v, e := s.Store.Vault(m.Vault)
		if e != nil {
			if errors.Is(e, sql.ErrNoRows) {
				fail(errors.New("Vault not found"))
			} else {
				fail(errors.New("Vault temporarily unavailable"))
			}
			return
		}
		if m.KeyHash != v.KeyHash || m.Encryption != v.Encryption {
			fail(errors.New("Vault encryption mismatch"))
			return
		}
		u, e := url.Parse(s.Store.Config.PublicURL)
		if e != nil {
			fail(errors.New("Server configuration invalid"))
			return
		}
		expected := u.Host + "/sync"
		if m.Host != expected {
			fail(errors.New("Vault host mismatch"))
			return
		}
		reply(w, 200, map[string]any{"res": "ok"})
	case "/vault/rename":
		if strings.TrimSpace(m.Name) == "" || len(m.Name) > 256 {
			fail(errors.New("Invalid vault name"))
			return
		}
		s.Store.mu.Lock()
		result, e := s.Store.DB.Exec("UPDATE vaults SET name=? WHERE id=? AND deleted=0", m.Name, m.Vault)
		s.Store.mu.Unlock()
		if e != nil {
			fail(errors.New("Could not rename vault"))
			return
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			fail(errors.New("Vault not found"))
			return
		}
		reply(w, 200, map[string]any{"res": "ok"})
	case "/vault/delete":
		s.Store.mu.Lock()
		result, e := s.Store.DB.Exec("UPDATE vaults SET deleted=1 WHERE id=? AND deleted=0", m.Vault)
		if e == nil {
			s.disconnectVault(m.Vault)
		}
		s.Store.mu.Unlock()
		if e != nil {
			fail(errors.New("Could not delete vault"))
			return
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			fail(errors.New("Vault not found"))
			return
		}
		reply(w, 200, map[string]any{"res": "ok"})
	default:
		reply(w, 501, map[string]any{"error": "Unsupported account operation"})
	}
}
