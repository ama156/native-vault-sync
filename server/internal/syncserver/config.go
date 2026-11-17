package syncserver

import (
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
)

const Chunk = 2097152
const DefaultFileMax int64 = 208666624
const Service = "vault-sync-server"
const Version = "0.1.0"

type Config struct {
	Listen     string `json:"listen"`
	PublicURL  string `json:"public_url"`
	DataDir    string `json:"data_dir"`
	MaxVaults  int    `json:"max_vaults"`
	MaxStorage int64  `json:"max_storage_bytes"`
	MaxFile    int64  `json:"max_file_bytes"`
}

func DefaultConfig() Config {
	return Config{Listen: "127.0.0.1:8080", MaxVaults: 10, MaxStorage: 10 << 30, MaxFile: DefaultFileMax}
}
func (c Config) Validate() error {
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
