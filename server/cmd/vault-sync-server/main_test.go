package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/ama156/native-vault-sync/server/internal/syncserver"
)

func TestStatusReachesWildcardListenerWithoutProxy(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("NO_PROXY", "")
	for _, network := range []string{"tcp4", "tcp6"} {
		t.Run(network, func(t *testing.T) {
			host, wildcard := "127.0.0.1", "0.0.0.0"
			if network == "tcp6" {
				host, wildcard = "::1", "::"
			}
			listener, err := net.Listen(network, net.JoinHostPort(host, "0"))
			if err != nil {
				t.Skipf("network unavailable: %v", err)
			}
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/healthz" {
					t.Errorf("unexpected status request: %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"service":"vault-sync-server","ready":true}`)
			}))
			server.Listener.Close()
			server.Listener = listener
			server.Start()
			defer server.Close()
			_, port, _ := net.SplitHostPort(listener.Addr().String())
			config := syncserver.DefaultConfig()
			config.Listen = net.JoinHostPort(wildcard, port)
			config.PublicURL = "https://test.invalid"
			config.DataDir = t.TempDir()
			file := filepath.Join(t.TempDir(), "config.json")
			if err := syncserver.SaveConfig(file, config); err != nil {
				t.Fatal(err)
			}
			if err := run([]string{"status", "--config", file}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestInitPersistsExplicitContainerListenAddress(t *testing.T) {
	input, err := os.CreateTemp(t.TempDir(), "password")
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	if _, err := input.WriteString("disposable-container-password\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := input.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	previous := os.Stdin
	os.Stdin = input
	defer func() { os.Stdin = previous }()
	file, data := filepath.Join(t.TempDir(), "config.json"), t.TempDir()
	if e := os.Chmod(data, 0700); e != nil {
		t.Fatal(e)
	}
	if err := run([]string{"init", "--config", file, "--data-dir", data, "--listen", "0.0.0.0:8080", "--public-url", "https://test.invalid", "--email", "test@local.invalid", "--password-stdin"}); err != nil {
		t.Fatal(err)
	}
	config, err := syncserver.LoadConfig(file)
	if err != nil {
		t.Fatal(err)
	}
	if config.Listen != "0.0.0.0:8080" {
		t.Fatalf("container address not persisted: %s", config.Listen)
	}
	store, err := syncserver.Open(config, false)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.SignIn("test@local.invalid", "disposable-container-password"); err != nil {
		t.Fatalf("initialized owner cannot sign in: %v", err)
	}
}

func TestRuntimeConfigurationAndFlags(t *testing.T) {
	t.Setenv("VAULT_SYNC_PUBLIC_URL", "https://env.invalid")
	t.Setenv("VAULT_SYNC_LISTEN", "0.0.0.0:8080")
	t.Setenv("VAULT_SYNC_MAX_STORAGE_BYTES", "21474836480")
	secret := filepath.Join(t.TempDir(), "password")
	if e := os.WriteFile(secret, []byte("a secret file password\n"), 0600); e != nil {
		t.Fatal(e)
	}
	config := filepath.Join(t.TempDir(), "config.json")
	data := t.TempDir()
	if e := os.Chmod(data, 0700); e != nil {
		t.Fatal(e)
	}
	if e := run([]string{"init", "--config", config, "--data-dir", data, "--listen", "127.0.0.1:8099", "--email", "env@local.invalid", "--password-file", secret}); e != nil {
		t.Fatal(e)
	}
	var saved syncserver.Config
	b, e := os.ReadFile(config)
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(b, &saved); e != nil {
		t.Fatal(e)
	}
	if saved.Listen != "127.0.0.1:8099" || saved.PublicURL != "https://env.invalid" || saved.MaxStorage != 21474836480 {
		t.Fatal("precedence", saved)
	}
	// An explicitly supplied runtime env wins over the persisted value on load.
	runtime, e := syncserver.LoadConfig(config)
	if e != nil || runtime.Listen != "0.0.0.0:8080" {
		t.Fatal(runtime, e)
	}
	t.Setenv("VAULT_SYNC_MAX_STORAGE_BYTES", "invalid")
	if _, e = syncserver.LoadConfig(config); e == nil {
		t.Fatal("invalid env silently accepted")
	}
}
