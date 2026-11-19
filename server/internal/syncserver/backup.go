package syncserver

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Offline backup uses the same exclusive data-directory lock as the service.
func Restore(archive, configFile, dataDir string) error {
	if !filepath.IsAbs(dataDir) {
		return errors.New("restore data directory must be absolute")
	}
	if _, e := os.Stat(dataDir); !os.IsNotExist(e) {
		return errors.New("restore requires a nonexistent destination directory")
	}
	if _, e := os.Stat(configFile); !os.IsNotExist(e) {
		return errors.New("restore requires a new configuration filename")
	}
	if e := os.MkdirAll(filepath.Dir(dataDir), 0700); e != nil {
		return e
	}
	temp, e := os.MkdirTemp(filepath.Dir(dataDir), ".vault-sync-restore-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(temp)
	var input io.Reader = os.Stdin
	if archive != "-" {
		f, e := os.Open(archive)
		if e != nil {
			return e
		}
		defer f.Close()
		input = f
	}
	gz, e := gzip.NewReader(input)
	if e != nil {
		return e
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	c := DefaultConfig()
	seen := map[string]bool{}
	var total int64
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		name := h.Name
		if seen[name] || h.Typeflag != tar.TypeReg || h.Size < 0 || strings.Contains(name, "\\") || filepath.IsAbs(name) || strings.Contains(name, "..") || filepath.ToSlash(filepath.Clean(name)) != name {
			return errors.New("unsafe backup entry")
		}
		seen[name] = true
		if name == "config.json" {
			if h.Size > 65536 {
				return errors.New("backup configuration too large")
			}
			b, e := io.ReadAll(io.LimitReader(tr, 65537))
			if e != nil {
				return e
			}
			if e = json.Unmarshal(b, &c); e != nil {
				return e
			}
			if e = c.Validate(); e != nil {
				return e
			}
			if e = writePrivate(filepath.Join(temp, "config.json"), strings.NewReader(string(b))); e != nil {
				return e
			}
			continue
		}
		if !seen["config.json"] || (name != "metadata.sqlite" && name != "manifest.json" && !strings.HasPrefix(name, "blobs/")) {
			return errors.New("unexpected backup entry")
		}
		total += h.Size
		if total > c.MaxStorage+(1<<30) {
			return errors.New("backup exceeds configured storage plus metadata allowance")
		}
		target := filepath.Join(temp, filepath.FromSlash(name))
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return e
		}
		out, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		_, copyErr := io.CopyN(out, tr, h.Size)
		syncErr := out.Sync()
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if !seen["config.json"] || !seen["metadata.sqlite"] {
		return errors.New("incomplete backup")
	}
	if _, e = io.Copy(io.Discard, gz); e != nil {
		return e
	}
	if e = verifySnapshot(temp, false); e != nil {
		return e
	}
	os.Remove(filepath.Join(temp, "config.json"))
	os.Remove(filepath.Join(temp, "manifest.json"))
	c.DataDir = temp
	check, e := Open(c, true)
	if e != nil {
		return e
	}
	e = check.CheckBlobs(true)
	if e == nil {
		var integrity string
		e = check.DB.QueryRow("PRAGMA integrity_check").Scan(&integrity)
		if e == nil && integrity != "ok" {
			e = errors.New("backup database integrity check failed")
		}
	}
	check.Close()
	if e != nil {
		return e
	}
	c.DataDir = dataDir
	if e = syncSnapshotTree(temp); e != nil {
		return e
	}
	if e = os.Rename(temp, dataDir); e != nil {
		return e
	}
	if e = SaveConfig(configFile, c); e != nil {
		os.RemoveAll(dataDir)
		return e
	}
	return syncDir(filepath.Dir(dataDir))
}
