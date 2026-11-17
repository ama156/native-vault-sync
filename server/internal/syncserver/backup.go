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
func Backup(configFile, output string) error {
	c, e := LoadConfig(configFile)
	if e != nil {
		return e
	}
	s, e := Open(c, true)
	if e != nil {
		return e
	}
	defer s.Close()
	// VACUUM INTO creates a consistent SQLite snapshot even if an administrative
	// CLI changes a session while the (stopped) service's data lock is held.
	snapshot := filepath.Join(c.DataDir, "backup-"+RandomHex(12)+".sqlite")
	defer os.Remove(snapshot)
	if _, e = s.DB.Exec("VACUUM INTO ?", snapshot); e != nil {
		return e
	}
	f, e := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	success := false
	defer func() {
		f.Close()
		if !success {
			os.Remove(output)
		}
	}()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	add := func(name string, reader io.Reader, size int64) error {
		if e := tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: size, Typeflag: tar.TypeReg}); e != nil {
			return e
		}
		_, e := io.CopyN(tw, reader, size)
		return e
	}
	b, e := json.MarshalIndent(c, "", "  ")
	if e != nil {
		return e
	}
	if e = add("config.json", strings.NewReader(string(b)), int64(len(b))); e != nil {
		return e
	}
	for _, entry := range []string{"metadata.sqlite", "blobs"} {
		walkPath := filepath.Join(c.DataDir, entry)
		if entry == "metadata.sqlite" {
			walkPath = snapshot
		}
		e = filepath.WalkDir(walkPath, func(p string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				return nil
			}
			info, e := d.Info()
			if e != nil {
				return e
			}
			if !info.Mode().IsRegular() {
				return errors.New("backup contains a nonregular file")
			}
			in, e := os.Open(p)
			if e != nil {
				return e
			}
			defer in.Close()
			relative, e := filepath.Rel(c.DataDir, p)
			if e != nil {
				return e
			}
			if entry == "metadata.sqlite" {
				relative = "metadata.sqlite"
			}
			return add(filepath.ToSlash(relative), in, info.Size())
		})
		if e != nil {
			return e
		}
	}
	if e = tw.Close(); e != nil {
		return e
	}
	if e = gz.Close(); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	success = true
	return nil
}
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
	f, e := os.Open(archive)
	if e != nil {
		return e
	}
	defer f.Close()
	gz, e := gzip.NewReader(f)
	if e != nil {
		return e
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var c Config
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
			continue
		}
		if !seen["config.json"] || (name != "metadata.sqlite" && !strings.HasPrefix(name, "blobs/")) {
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
	if e = os.Rename(temp, dataDir); e != nil {
		return e
	}
	if e = SaveConfig(configFile, c); e != nil {
		os.RemoveAll(dataDir)
		return e
	}
	return syncDir(filepath.Dir(dataDir))
}
