package syncserver

import (
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
)

const Chunk = 2097152
const DefaultFileMax int64 = 208666624
const Service = "vault-sync-server"
const Version = "0.2.0"

type Config struct {
	GlobalRequestsPerMinute int      `json:"global_requests_per_minute"`
	DefaultUserStorage      int64    `json:"default_user_storage_bytes"`
	SessionDays             int      `json:"session_days"`
	MaxConnections          int      `json:"max_connections"`
	UserConnections         int      `json:"user_connections"`
	MaxUploads              int      `json:"max_uploads"`
	UserUploads             int      `json:"user_uploads"`
	LoginConcurrency        int      `json:"login_concurrency"`
	RequestsPerMinute       int      `json:"requests_per_minute"`
	LoginIPPerMinute        int      `json:"login_ip_per_minute"`
	LoginAccountPerMinute   int      `json:"login_account_per_minute"`
	MaxTotalVaults          int      `json:"max_total_vaults"`
	TrustedProxies          []string `json:"trusted_proxies"`

	Listen     string `json:"listen"`
	PublicURL  string `json:"public_url"`
	DataDir    string `json:"data_dir"`
	MaxVaults  int    `json:"max_vaults"`
	MaxStorage int64  `json:"max_storage_bytes"`
	MaxFile    int64  `json:"max_file_bytes"`
}

func DefaultConfig() Config {
	return Config{GlobalRequestsPerMinute: 6000, DefaultUserStorage: 10 << 30, SessionDays: 30, MaxConnections: 64, UserConnections: 8, MaxUploads: 16, UserUploads: 4, LoginConcurrency: 2, RequestsPerMinute: 600, LoginIPPerMinute: 30, LoginAccountPerMinute: 10, MaxTotalVaults: 1000, Listen: "127.0.0.1:8080", MaxVaults: 10, MaxStorage: 10 << 30, MaxFile: DefaultFileMax}
}
func (c Config) Validate() error {
	for _, cidr := range c.TrustedProxies {
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return errors.New("trusted_proxies requires explicit CIDRs")
		}
	}
	if c.GlobalRequestsPerMinute < 1 || c.DefaultUserStorage < 1 || c.DefaultUserStorage > 1<<60 || c.MaxStorage > 1<<60 || c.SessionDays < 1 || c.SessionDays > 365 || c.MaxConnections < 1 || c.MaxConnections > 10000 || c.UserConnections < 1 || c.UserConnections > c.MaxConnections || c.MaxUploads < 1 || c.UserUploads < 1 || c.UserUploads > c.MaxUploads || c.LoginConcurrency < 1 || c.LoginConcurrency > 16 || c.RequestsPerMinute < 1 || c.LoginIPPerMinute < 1 || c.LoginAccountPerMinute < 1 || c.MaxTotalVaults < 1 {
		return errors.New("invalid resource or user limits")
	}

	u, e := url.Parse(c.PublicURL)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("public_url must be an HTTPS origin")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && u.Hostname() == "127.0.0.1") {
		return errors.New("public_url requires HTTPS; HTTP is allowed only for loopback development")
	}
	host, _, e := net.SplitHostPort(c.Listen)
	if e != nil || net.ParseIP(host) == nil {
		return errors.New("listen must be an explicit IP:port")
	}
	if !filepath.IsAbs(c.DataDir) || c.MaxVaults < 1 || c.MaxStorage < 1 || c.MaxFile < 1 || c.MaxFile > c.MaxStorage || c.MaxFile > 1<<40 {
		return errors.New("invalid data directory or limits")
	}
	return nil
}
func LoadConfig(file string) (Config, error) {
	c := DefaultConfig()
	b, e := os.ReadFile(file)
	if e != nil {
		return c, e
	}
	if len(b) > 65536 {
		return c, errors.New("configuration too large")
	}
	e = json.Unmarshal(b, &c)
	if e != nil {
		return c, e
	}
	if e = c.ApplyEnv(); e != nil {
		return c, e
	}
	return c, c.Validate()
}
func SaveConfig(file string, c Config) error {
	if e := c.Validate(); e != nil {
		return e
	}
	if e := os.MkdirAll(filepath.Dir(file), 0700); e != nil {
		return e
	}
	b, e := json.MarshalIndent(c, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if _, e = f.Write(append(b, '\n')); e != nil {
		return e
	}
	return f.Sync()
}

// Explicit runtime overrides are shared by native and container deployments.
func (c *Config) ApplyEnv() error {
	v := reflect.ValueOf(c).Elem()
	typ := v.Type()
	for i := 0; i < v.NumField(); i++ {
		name := "VAULT_SYNC_" + strings.ToUpper(typ.Field(i).Tag.Get("json"))
		raw, ok := os.LookupEnv(name)
		if !ok {
			continue
		}
		f := v.Field(i)
		switch f.Kind() {
		case reflect.String:
			f.SetString(raw)
		case reflect.Int, reflect.Int64:
			n, e := strconv.ParseInt(raw, 10, 64)
			if e != nil {
				return fmtConfig(name)
			}
			f.SetInt(n)
		case reflect.Slice:
			if raw == "" {
				f.Set(reflect.ValueOf([]string{}))
			} else {
				f.Set(reflect.ValueOf(strings.Split(raw, ",")))
			}
		}
	}
	return nil
}
func fmtConfig(name string) error { return errors.New("invalid environment setting: " + name) }
