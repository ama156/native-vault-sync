package syncserver

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type snapshotEntry struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type snapshotManifest struct {
	Version int                      `json:"version"`
	Files   map[string]snapshotEntry `json:"files"`
}

func regularDigest(path string) (snapshotEntry, error) {
	if e := regularFile(path); e != nil {
		return snapshotEntry{}, e
	}
	f, e := os.Open(path)
	if e != nil {
		return snapshotEntry{}, e
	}
	defer f.Close()
	h := sha256.New()
	n, e := io.Copy(h, f)
	return snapshotEntry{n, hex.EncodeToString(h.Sum(nil))}, e
}
func writePrivate(path string, r io.Reader) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = io.Copy(f, r)
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	return ce
}
func copyPrivate(src, dst string) error {
	if e := regularFile(src); e != nil {
		return e
	}
	f, e := os.Open(src)
	if e != nil {
		return e
	}
	defer f.Close()
	return writePrivate(dst, f)
}
func safeEntry(n string) bool {
	return !strings.Contains(n, "\\") && !filepath.IsAbs(n) && filepath.ToSlash(filepath.Clean(n)) == n && !strings.Contains(n, "..") && (n == "config.json" || n == "metadata.sqlite" || n == "manifest.json" || strings.HasPrefix(n, "blobs/"))
}
func snapshotFiles(dir string) ([]string, error) {
	out := []string{}
	e := filepath.WalkDir(dir, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		n, e := filepath.Rel(dir, p)
		if e != nil {
			return e
		}
		n = filepath.ToSlash(n)
		if !safeEntry(n) {
			return errors.New("unexpected snapshot entry")
		}
		if e = regularFile(p); e != nil {
			return e
		}
		out = append(out, n)
		return nil
	})
	sort.Strings(out)
	return out, e
}
func snapshotStore(s *Store, dir string) error {
	if e := os.Mkdir(dir, 0700); e != nil {
		return e
	}
	if _, e := s.DB.Exec("VACUUM INTO ?", filepath.Join(dir, "metadata.sqlite")); e != nil {
		return e
	}
	database, e := os.OpenFile(filepath.Join(dir, "metadata.sqlite"), os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	e = database.Sync()
	database.Close()
	if e != nil {
		return e
	}
	b, e := json.MarshalIndent(s.Config, "", "  ")
	if e != nil {
		return e
	}
	if e = writePrivate(filepath.Join(dir, "config.json"), strings.NewReader(string(b))); e != nil {
		return e
	}
	if e = os.Mkdir(filepath.Join(dir, "blobs"), 0700); e != nil {
		return e
	}
	e = filepath.WalkDir(filepath.Join(s.Config.DataDir, "blobs"), func(p string, d os.DirEntry, e error) error {
		if os.IsNotExist(e) {
			return nil
		}
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		n, e := filepath.Rel(s.Config.DataDir, p)
		if e != nil {
			return e
		}
		return copyPrivate(p, filepath.Join(dir, n))
	})
	if e != nil {
		return e
	}
	names, e := snapshotFiles(dir)
	if e != nil {
		return e
	}
	m := snapshotManifest{1, map[string]snapshotEntry{}}
	for _, n := range names {
		v, e := regularDigest(filepath.Join(dir, n))
		if e != nil {
			return e
		}
		m.Files[n] = v
	}
	b, e = json.MarshalIndent(m, "", "  ")
	if e != nil {
		return e
	}
	if e = writePrivate(filepath.Join(dir, "manifest.json"), strings.NewReader(string(b))); e != nil {
		return e
	}
	return syncSnapshotTree(dir)
}
func snapshotConfig(dir string) (Config, error) {
	c := DefaultConfig()
	b, e := os.ReadFile(filepath.Join(dir, "config.json"))
	if e != nil {
		return c, e
	}
	if len(b) > 65536 {
		return c, errors.New("config too large")
	}
	if e = json.Unmarshal(b, &c); e != nil {
		return c, e
	}
	return c, c.Validate()
}
func verifySnapshot(dir string, requireManifest bool) error {
	names, e := snapshotFiles(dir)
	if e != nil {
		return e
	}
	b, e := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if e == nil {
		if len(b) > 64<<20 {
			return errors.New("manifest too large")
		}
		var m snapshotManifest
		if e = json.Unmarshal(b, &m); e != nil {
			return e
		}
		if m.Version != 1 || len(names) != len(m.Files)+1 {
			return errors.New("invalid snapshot manifest")
		}
		for _, n := range names {
			if n == "manifest.json" {
				continue
			}
			got, e := regularDigest(filepath.Join(dir, n))
			if e != nil {
				return e
			}
			if want, ok := m.Files[n]; !ok || got != want {
				return errors.New("snapshot checksum mismatch")
			}
		}
	} else if !os.IsNotExist(e) || requireManifest {
		return errors.New("snapshot manifest missing")
	}
	c, e := snapshotConfig(dir)
	if e != nil {
		return e
	}
	u := url.URL{Scheme: "file", Path: filepath.Join(dir, "metadata.sqlite")}
	db, e := sql.Open("sqlite", u.String()+"?mode=ro")
	if e != nil {
		return e
	}
	defer db.Close()
	var integrity string
	if e = db.QueryRow("PRAGMA integrity_check").Scan(&integrity); e != nil {
		return e
	}
	if integrity != "ok" {
		return errors.New("database integrity failure")
	}
	c.DataDir = dir
	s := &Store{Config: c, DB: db}
	return s.CheckBlobs(true)
}
func BackupFormat(configFile, output, format string) error {
	if format != "tar.gz" && format != "zip" && format != "directory" {
		return errors.New("format must be tar.gz, zip or directory")
	}
	c, e := LoadConfig(configFile)
	if e != nil {
		return e
	}
	abs, e := filepath.Abs(output)
	if e != nil {
		return e
	}
	rel, e := filepath.Rel(c.DataDir, abs)
	if e != nil {
		return e
	}
	if rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..") {
		return errors.New("backup must be outside live data directory")
	}
	if _, e = os.Lstat(abs); !os.IsNotExist(e) {
		return errors.New("backup output exists")
	}
	s, e := Open(c, true)
	if e != nil {
		return e
	}
	defer s.Close()
	dir, e := os.MkdirTemp(filepath.Dir(abs), ".snapshot-")
	if e != nil {
		return e
	}
	os.Remove(dir)
	defer os.RemoveAll(dir)
	if e = snapshotStore(s, dir); e != nil {
		return e
	}
	if e = verifySnapshot(dir, true); e != nil {
		return e
	}
	if format == "directory" {
		if e = os.Rename(dir, abs); e != nil {
			return e
		}
		return syncDir(filepath.Dir(abs))
	}
	f, e := os.CreateTemp(filepath.Dir(abs), ".backup-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	names, e := snapshotFiles(dir)
	if e != nil {
		f.Close()
		return e
	}
	// Legacy tar readers require configuration before any data entries.
	ordered := []string{"config.json"}
	for _, n := range names {
		if n != "config.json" {
			ordered = append(ordered, n)
		}
	}
	if format == "zip" {
		z := zip.NewWriter(f)
		for _, n := range ordered {
			w, err := z.CreateHeader(&zip.FileHeader{Name: n, Method: zip.Store})
			if err != nil {
				e = err
				break
			}
			in, err := os.Open(filepath.Join(dir, n))
			if err != nil {
				e = err
				break
			}
			_, e = io.Copy(w, in)
			in.Close()
			if e != nil {
				break
			}
		}
		if ce := z.Close(); e == nil {
			e = ce
		}
	} else {
		gz := gzip.NewWriter(f)
		t := tar.NewWriter(gz)
		for _, n := range ordered {
			st, err := os.Stat(filepath.Join(dir, n))
			if err != nil {
				e = err
				break
			}
			if e = t.WriteHeader(&tar.Header{Name: n, Mode: 0600, Size: st.Size(), Typeflag: tar.TypeReg}); e != nil {
				break
			}
			in, err := os.Open(filepath.Join(dir, n))
			if err != nil {
				e = err
				break
			}
			_, e = io.Copy(t, in)
			in.Close()
			if e != nil {
				break
			}
		}
		if ce := t.Close(); e == nil {
			e = ce
		}
		if ce := gz.Close(); e == nil {
			e = ce
		}
	}
	if e == nil {
		e = f.Sync()
	}
	if ce := f.Close(); e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Link(f.Name(), abs); e != nil {
		return e
	}
	return syncDir(filepath.Dir(abs))
}
func RestoreSource(archive, snapshot, configFile, dataDir string) error {
	if (archive == "") == (snapshot == "") {
		return errors.New("choose archive or snapshot")
	}
	if archive != "" {
		if archive == "-" {
			return Restore(archive, configFile, dataDir)
		}
		f, e := os.Open(archive)
		if e != nil {
			return e
		}
		var head [4]byte
		_, e = f.Read(head[:])
		f.Close()
		if e != nil {
			return e
		}
		if string(head[:]) != "PK\x03\x04" {
			return Restore(archive, configFile, dataDir)
		}
	}
	if !filepath.IsAbs(dataDir) {
		return errors.New("restore data directory must be absolute")
	}
	for _, p := range []string{configFile, dataDir} {
		if _, e := os.Lstat(p); !os.IsNotExist(e) {
			return errors.New("restore requires new destinations")
		}
	}
	if e := os.MkdirAll(filepath.Dir(dataDir), 0700); e != nil {
		return e
	}
	temp, e := os.MkdirTemp(filepath.Dir(dataDir), ".restore-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(temp)
	if snapshot != "" {
		if e = verifySnapshot(snapshot, true); e != nil {
			return e
		}
		names, e := snapshotFiles(snapshot)
		if e != nil {
			return e
		}
		for _, n := range names {
			if e = copyPrivate(filepath.Join(snapshot, n), filepath.Join(temp, n)); e != nil {
				return e
			}
		}
	} else {
		z, e := zip.OpenReader(archive)
		if e != nil {
			return e
		}
		defer z.Close()
		var cf *zip.File
		for _, f := range z.File {
			if f.Name == "config.json" {
				if cf != nil {
					return errors.New("duplicate configuration")
				}
				cf = f
			}
		}
		if cf == nil || !cf.Mode().IsRegular() || cf.UncompressedSize64 > 65536 {
			return errors.New("configuration missing or too large")
		}
		r, e := cf.Open()
		if e != nil {
			return e
		}
		e = writePrivate(filepath.Join(temp, "config.json"), io.LimitReader(r, 65537))
		r.Close()
		if e != nil {
			return e
		}
		c, e := snapshotConfig(temp)
		if e != nil {
			return e
		}
		var total uint64
		seen := map[string]bool{"config.json": true}
		for _, f := range z.File {
			if f == cf {
				continue
			}
			if !safeEntry(f.Name) || seen[f.Name] || !f.Mode().IsRegular() {
				return errors.New("unsafe ZIP entry")
			}
			seen[f.Name] = true
			if f.UncompressedSize64 > uint64(c.MaxStorage+(1<<30))-total {
				return errors.New("archive exceeds limit")
			}
			total += f.UncompressedSize64
			r, e := f.Open()
			if e != nil {
				return e
			}
			e = writePrivate(filepath.Join(temp, filepath.FromSlash(f.Name)), io.LimitReader(r, int64(f.UncompressedSize64)+1))
			r.Close()
			if e != nil {
				return e
			}
		}
	}
	if e = verifySnapshot(temp, true); e != nil {
		return e
	}
	c, e := snapshotConfig(temp)
	if e != nil {
		return e
	}
	c.DataDir = temp
	s, e := Open(c, true)
	if e != nil {
		return e
	}
	e = s.CheckBlobs(true)
	s.Close()
	if e != nil {
		return e
	}
	os.Remove(filepath.Join(temp, "manifest.json"))
	os.Remove(filepath.Join(temp, "config.json"))
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

func Backup(configFile, output string) error { return BackupFormat(configFile, output, "tar.gz") }

func syncSnapshotTree(root string) error {
	dirs := []string{}
	if e := filepath.WalkDir(root, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	}); e != nil {
		return e
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if e := syncDir(dirs[i]); e != nil {
			return e
		}
	}
	return nil
}
