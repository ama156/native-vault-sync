package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ama156/native-vault-sync/server/internal/syncserver"
	"golang.org/x/term"
)

func main() {
	if e := run(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, "Error:", e)
		os.Exit(1)
	}
}
func flags(name string) (*flag.FlagSet, *string) {
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	config := f.String("config", "/etc/vault-sync/config.json", "configuration file")
	return f, config
}
func password(stdin bool) (string, error) {
	if stdin {
		b := bufio.NewReader(os.Stdin)
		s, e := b.ReadString('\n')
		if e != nil && s == "" {
			return "", e
		}
		return strings.TrimSuffix(strings.TrimSuffix(s, "\n"), "\r"), nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", errors.New("password prompt requires a terminal; use --password-stdin for automation")
	}
	fmt.Fprint(os.Stderr, "Account password (minimum 12 characters): ")
	b, e := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	return string(b), e
}
func output(v any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(v)
}
func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: vault-sync-server init|serve|status|password-reset|sessions|backup|restore|version")
	}
	if args[0] == "version" {
		fmt.Println(syncserver.Version)
		return nil
	}
	command := args[0]
	rest := args[1:]
	action := ""
	if command == "sessions" {
		if len(rest) == 0 {
			return errors.New("usage: sessions list|revoke --config FILE [--id ID]")
		}
		action = rest[0]
		rest = rest[1:]
	}
	f, configFile := flags(command)
	var email, publicURL, dataDir, name, archive, backupFile, id *string
	var stdin *bool
	switch command {
	case "init":
		email = f.String("email", "", "owner email")
		name = f.String("name", "Owner", "owner display name")
		publicURL = f.String("public-url", "", "public HTTPS origin")
		dataDir = f.String("data-dir", "/var/lib/vault-sync", "persistent data directory")
		stdin = f.Bool("password-stdin", false, "read password from stdin")
	case "password-reset":
		stdin = f.Bool("password-stdin", false, "read password from stdin")
	case "sessions":
		id = f.String("id", "", "full hashed session ID returned by sessions list")
	case "backup":
		backupFile = f.String("output", "", "new .tar.gz backup filename")
	case "restore":
		archive = f.String("archive", "", "backup .tar.gz filename")
		dataDir = f.String("data-dir", "", "new absolute data directory")
	case "serve", "status":
	default:
		return errors.New("unknown command")
	}
	if e := f.Parse(rest); e != nil {
		return e
	}
	if f.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if command == "init" {
		if _, e := os.Stat(*configFile); !os.IsNotExist(e) {
			return errors.New("configuration already exists")
		}
		reader := bufio.NewReader(os.Stdin)
		if *email == "" {
			if *stdin {
				return errors.New("--email is required with --password-stdin")
			}
			fmt.Fprint(os.Stderr, "Owner email: ")
			v, e := reader.ReadString('\n')
			if e != nil {
				return e
			}
			*email = strings.TrimSpace(v)
		}
		if *publicURL == "" {
			return errors.New("--public-url is required")
		}
		c := syncserver.DefaultConfig()
		c.PublicURL = strings.TrimSuffix(*publicURL, "/")
		abs, e := filepath.Abs(*dataDir)
		if e != nil {
			return e
		}
		c.DataDir = abs
		p, e := password(*stdin)
		if e != nil {
			return e
		}
		s, e := syncserver.Open(c, true)
		if e != nil {
			return e
		}
		defer s.Close()
		if e = s.InitOwner(*email, *name, p); e != nil {
			return e
		}
		if e = syncserver.SaveConfig(*configFile, c); e != nil {
			return e
		}
		fmt.Println("Initialized. Keep the account password separate from your vault encryption passwords.")
		return nil
	}
	if command == "restore" {
		if *archive == "" || *dataDir == "" {
			return errors.New("--archive and --data-dir are required")
		}
		return syncserver.Restore(*archive, *configFile, *dataDir)
	}
	if command == "backup" {
		if *backupFile == "" {
			return errors.New("--output is required")
		}
		return syncserver.Backup(*configFile, *backupFile)
	}
	c, e := syncserver.LoadConfig(*configFile)
	if e != nil {
		return e
	}
	if command == "status" {
		client := http.Client{Timeout: 3 * time.Second}
		resp, e := client.Get("http://" + c.Listen + "/healthz")
		if e != nil {
			return errors.New("service is not reachable on the configured listen address")
		}
		defer resp.Body.Close()
		var health any
		if e = json.NewDecoder(resp.Body).Decode(&health); e != nil {
			return e
		}
		if resp.StatusCode != 200 {
			return errors.New("service is not ready")
		}
		return output(health)
	}
	s, e := syncserver.Open(c, command == "serve")
	if e != nil {
		return e
	}
	defer s.Close()
	switch command {
	case "password-reset":
		p, e := password(*stdin)
		if e != nil {
			return e
		}
		return s.ResetPassword(p)
	case "sessions":
		if action == "revoke" {
			if len(*id) != 64 {
				return errors.New("--id must be the full session ID from sessions list")
			}
			result, e := s.DB.Exec("DELETE FROM sessions WHERE hash=?", *id)
			if e != nil {
				return e
			}
			n, _ := result.RowsAffected()
			if n != 1 {
				return errors.New("session not found")
			}
			return nil
		}
		if action != "list" {
			return errors.New("unknown sessions action")
		}
		rows, e := s.DB.Query("SELECT hash,created,expires FROM sessions ORDER BY created")
		if e != nil {
			return e
		}
		defer rows.Close()
		sessions := []map[string]any{}
		for rows.Next() {
			var id string
			var created, expires int64
			if e = rows.Scan(&id, &created, &expires); e != nil {
				return e
			}
			sessions = append(sessions, map[string]any{"id": id, "created": created, "expires": expires})
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return output(sessions)
	case "serve":
		if _, e = s.Account(); e != nil {
			return errors.New("initialize an owner account first")
		}
		logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
		handler := syncserver.NewServer(s, logger)
		defer handler.Close()
		listener, e := net.Listen("tcp", c.Listen)
		if e != nil {
			return e
		}
		server := http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		go func() {
			<-ctx.Done()
			handler.Close()
			shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
			defer done()
			server.Shutdown(shutdown)
		}()
		used, _ := s.Storage()
		logger.Info("server ready", "listen", listener.Addr().String(), "storage_bytes", used, "version", syncserver.Version)
		e = server.Serve(listener)
		if e == http.ErrServerClosed {
			return nil
		}
		return e
	}
	return nil
}
