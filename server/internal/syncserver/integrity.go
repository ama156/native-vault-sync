package syncserver

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func (s *Store) CheckBlobs(verifyHash bool) error {
	// Refuse inconsistent references before recovery can remove unindexed files.
	var broken int
	if e := s.DB.QueryRow(`SELECT COUNT(*) FROM revisions r LEFT JOIN blobs b ON b.vault=r.vault AND b.hash=r.blob WHERE r.size<0 OR (r.blob<>'' AND (b.hash IS NULL OR b.size<>r.size)) OR (r.size>0 AND r.blob='')`).Scan(&broken); e != nil {
		return e
	}
	if broken != 0 {
		return errors.New("invalid revision ciphertext reference")
	}
	rows, e := s.DB.Query("SELECT vault,hash,size FROM blobs")
	if e != nil {
		return e
	}
	expected := map[string]int64{}
	for rows.Next() {
		var vault, hash string
		var size int64
		if e = rows.Scan(&vault, &hash, &size); e != nil {
			rows.Close()
			return e
		}
		if _, e = hex.DecodeString(vault); e != nil {
			rows.Close()
			return errors.New("invalid stored vault identifier")
		}
		if len(hash) != 64 {
			rows.Close()
			return errors.New("invalid stored blob identifier")
		}
		if _, e = hex.DecodeString(hash); e != nil {
			rows.Close()
			return e
		}
		expected[s.BlobPath(vault, hash)] = size
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for file, size := range expected {
		info, e := os.Lstat(file)
		if e != nil {
			return fmt.Errorf("required ciphertext is missing: %w", e)
		}
		if !info.Mode().IsRegular() || info.Size() != size {
			return errors.New("stored ciphertext size/type mismatch")
		}
		if verifyHash {
			f, e := os.Open(file)
			if e != nil {
				return e
			}
			h := sha256.New()
			_, e = io.Copy(h, f)
			f.Close()
			if e != nil {
				return e
			}
			if hex.EncodeToString(h.Sum(nil)) != filepath.Base(file) {
				return errors.New("ciphertext checksum mismatch")
			}
		}
	}
	return nil
}
func (s *Store) Recover() error {
	if e := s.CheckBlobs(false); e != nil {
		return e
	}
	rows, e := s.DB.Query("SELECT vault,hash FROM blobs")
	if e != nil {
		return e
	}
	known := map[string]bool{}
	for rows.Next() {
		var vault, hash string
		if e = rows.Scan(&vault, &hash); e != nil {
			rows.Close()
			return e
		}
		known[s.BlobPath(vault, hash)] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	return filepath.WalkDir(filepath.Join(s.Config.DataDir, "blobs"), func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		if !known[p] {
			if e = os.Remove(p); e != nil {
				return e
			}
			return syncDir(filepath.Dir(p))
		}
		return nil
	})
}
