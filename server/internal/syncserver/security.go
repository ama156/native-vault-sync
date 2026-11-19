package syncserver

import (
	"crypto/sha256"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type rateBucket struct {
	Start time.Time
	Count int
}
type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]rateBucket
}

func (l *rateLimiter) allow(key string, limit int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.entries == nil {
		l.entries = map[string]rateBucket{}
	}
	b, ok := l.entries[key]
	if !ok && len(l.entries) >= 8192 {
		for k, v := range l.entries {
			if now.Sub(v.Start) >= time.Minute {
				delete(l.entries, k)
			}
		}
		if len(l.entries) >= 8192 {
			return false
		}
	}
	if now.Sub(b.Start) >= time.Minute {
		b = rateBucket{Start: now}
	}
	b.Count++
	l.entries[key] = b
	return b.Count <= limit
}
func (c Config) trusted(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	for _, cidr := range c.TrustedProxies {
		_, n, e := net.ParseCIDR(cidr)
		if e == nil && n.Contains(parsed) {
			return true
		}
	}
	return false
}
func (c Config) clientIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	if !c.trusted(host) {
		return host
	}
	h := r.Header.Get("X-Forwarded-For")
	if len(h) > 2048 {
		return host
	}
	chain := strings.Split(h, ",")
	if len(chain) > 32 {
		return host
	}
	for i := len(chain) - 1; i >= 0; i-- {
		ip := strings.TrimSpace(chain[i])
		if net.ParseIP(ip) == nil {
			return host
		}
		if !c.trusted(ip) {
			return ip
		}
	}
	return host
}
func accountRateKey(email string) string {
	return fmt.Sprintf("account:%x", sha256.Sum256([]byte(normalizeEmail(email))))
}
func (s *Server) authorizedClient(c *client) bool {
	u, e := s.Store.Principal(c.token)
	return e == nil && u.ID == c.user && s.Store.Access(u.ID, c.vault) == nil
}
func (s *Server) disconnectUnauthorized() {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	for c := range s.clients {
		select {
		case <-c.authReady:
			if !s.authorizedClient(c) {
				c.cancel()
			}
		default:
		}
	}
}
