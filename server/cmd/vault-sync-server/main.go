package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
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
	fmt.Fprint(os.Stderr, "Account password (minimum 15 characters): ")
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
		return errors.New("usage: vault-sync-server init|serve|status|users|vaults|password-reset|sessions|backup|restore|version")
	}
	if args[0] == "version" {
		fmt.Println(syncserver.Version)
		return nil
	}
	command := args[0]
	rest := args[1:]
	action := ""
	if command == "sessions" || command == "users" || command == "vaults" {
		if len(rest) == 0 {
			return errors.New("usage: sessions list|revoke --config FILE [--id ID]")
		}
		action = rest[0]
		rest = rest[1:]
	}
	f, configFile := flags(command)
	var email, publicURL, dataDir, name, archive, backupFile, id, listen *string
	var stdin *bool
	var passwordFile, format, snapshot, user, vault *string
	var storage, fileLimit *int64
	var vaultLimit *int
	switch command {
	case "init":
		email = f.String("email", "", "owner email")
		name = f.String("name", "Owner", "owner display name")
		publicURL = f.String("public-url", "", "public HTTPS origin")
		dataDir = f.String("data-dir", "/var/lib/vault-sync", "persistent data directory")
		listen = f.String("listen", syncserver.DefaultConfig().Listen, "listen IP:port (containers: 0.0.0.0:8080)")
		stdin = f.Bool("password-stdin", false, "read password from stdin")
		passwordFile = f.String("password-file", "", "read password from a mounted secret file")
	case "password-reset":
		stdin = f.Bool("password-stdin", false, "read password from stdin")
		passwordFile = f.String("password-file", "", "read password from a mounted secret file")
	case "users", "vaults", "sessions":
		user = f.String("user", "", "user email or numeric ID")
		email = f.String("email", "", "email for new user")
		name = f.String("name", "User", "display name")
		vault = f.String("vault", "", "vault ID")
		storage = f.Int64("max-storage-bytes", 0, "user ciphertext allowance")
		fileLimit = f.Int64("max-file-bytes", 0, "user file limit")
		vaultLimit = f.Int("max-vaults", 0, "user vault limit")
		stdin = f.Bool("password-stdin", false, "read password from stdin")
		passwordFile = f.String("password-file", "", "read password from mounted secret file")
		id = f.String("id", "", "full hashed session ID returned by sessions list")
	case "backup":
		backupFile = f.String("output", "", "new backup destination")
		format = f.String("format", "tar.gz", "tar.gz, zip or directory")
	case "restore":
		archive = f.String("archive", "", "backup archive, or - for legacy tar stdin")
		snapshot = f.String("snapshot", "", "snapshot directory")
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
	if command == "users" || command == "vaults" || command == "sessions" {
		c, e := syncserver.LoadConfig(*configFile)
		if e != nil {
			return e
		}
		request := syncserver.AdminRequest{Action: command + "." + action, Email: *email, Name: *name, Vault: *vault, Session: *id, Storage: *storage, File: *fileLimit, Vaults: *vaultLimit}
		if *user != "" {
			if n, e := strconv.Atoi(*user); e == nil {
				request.User = n
			} else {
				request.Email = *user
			}
		}
		if command == "users" && (action == "add" || action == "password-reset") {
			request.Password, e = readPassword(*stdin, *passwordFile)
			if e != nil {
				return e
			}
		}
		data, e := syncserver.Admin(c, request)
		if e != nil {
			return e
		}
		return output(data)
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

		c := syncserver.DefaultConfig()
		if e := c.ApplyEnv(); e != nil {
			return e
		}
		f.Visit(func(flag *flag.Flag) {
			switch flag.Name {
			case "listen":
				c.Listen = *listen
			case "public-url":
				c.PublicURL = strings.TrimSuffix(*publicURL, "/")
			case "data-dir":
				c.DataDir = *dataDir
			}
		})
		if c.DataDir == "" {
			c.DataDir = *dataDir
		}
		if c.PublicURL == "" {
			return errors.New("--public-url or VAULT_SYNC_PUBLIC_URL is required")
		}
		/* effective configuration already includes explicit flags */
		_ = listen

		abs, e := filepath.Abs(c.DataDir)
		if e != nil {
			return e
		}
		c.DataDir = abs
		p, e := readPassword(*stdin, *passwordFile)
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
		if (*archive == "" && *snapshot == "") || *dataDir == "" {
			return errors.New("--archive and --data-dir are required")
		}
		return syncserver.RestoreSource(*archive, *snapshot, *configFile, *dataDir)
	}
	if command == "backup" {
		if *backupFile == "" {
			return errors.New("--output is required")
		}
		return syncserver.BackupFormat(*configFile, *backupFile, *format)
	}
	c, e := syncserver.LoadConfig(*configFile)
	if e != nil {
		return e
	}
	if command == "status" {
		// Wildcard addresses are bind destinations, not health-check targets.
		// Loopback also keeps local checks out of HTTP_PROXY configurations.
		host, port, e := net.SplitHostPort(c.Listen)
		if e != nil {
			return e
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
			if ip.To4() != nil {
				host = "127.0.0.1"
			} else {
				host = "::1"
			}
		}
		client := http.Client{Timeout: 3 * time.Second}
		resp, e := client.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
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
	if command == "password-reset" {
		p, e := readPassword(*stdin, *passwordFile)
		if e != nil {
			return e
		}
		_, e = syncserver.Admin(c, syncserver.AdminRequest{Action: "users.password-reset", User: 1, Password: p})
		return e
	}
	s, e := syncserver.Open(c, command == "serve")
	if e != nil {
		return e
	}
	defer s.Close()
	switch command {
	case "password-reset":
		p, e := readPassword(*stdin, *passwordFile)
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
		stopControl, e := handler.StartControl()
		if e != nil {
			return e
		}
		defer stopControl()
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

func readPassword(stdin bool, file string) (string, error) {
	if file == "" {
		return password(stdin)
	}
	if stdin {
		return "", errors.New("choose stdin or password file")
	}
	f, e := os.Open(file)
	if e != nil {
		return "", e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 1027))
	if e != nil {
		return "", e
	}
	if len(b) > 1026 {
		return "", errors.New("password file too large")
	}
	return strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r"), nil
}
