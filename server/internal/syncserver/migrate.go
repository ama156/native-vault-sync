package syncserver

import (
	"errors"
	"os"
	"path/filepath"
)

func (s *Store) migrateUsers(exclusive bool) error {
	var version int
	if e := s.DB.QueryRow("PRAGMA user_version").Scan(&version); e != nil {
		return e
	}
	if version == 2 {
		return nil
	}
	if !exclusive {
		return errors.New("schema upgrade requires exclusive offline access")
	}
	var owners int
	if e := s.DB.QueryRow("SELECT COUNT(*) FROM owner").Scan(&owners); e != nil {
		return e
	}
	if owners > 0 {
		// Capture and verify the old schema before changing any account/revision data.
		dest := filepath.Join(s.Config.DataDir, "pre-multiuser-"+RandomHex(8))
		if e := snapshotStore(s, dest); e != nil {
			os.RemoveAll(dest)
			return e
		}
		if e := verifySnapshot(dest, true); e != nil {
			os.RemoveAll(dest)
			return e
		}
		if e := syncDir(filepath.Dir(dest)); e != nil {
			return e
		}
	}
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	statements := []string{
		`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,max_storage INTEGER NOT NULL,max_vaults INTEGER NOT NULL,max_file INTEGER NOT NULL)`,
		`CREATE TABLE memberships(vault_id TEXT NOT NULL REFERENCES vaults(id),user_id INTEGER NOT NULL REFERENCES users(id),PRIMARY KEY(vault_id,user_id))`,
		`ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE revisions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`,
		`INSERT INTO memberships(vault_id,user_id) SELECT id,1 FROM vaults`,
		`CREATE INDEX sessions_user ON sessions(user_id)`,
		`CREATE INDEX memberships_user ON memberships(user_id)`,
		`PRAGMA user_version=2`,
	}
	// Populate the user before adding foreign-key references for existing rows.
	if _, e = tx.Exec(statements[0]); e != nil {
		return e
	}
	if _, e = tx.Exec("INSERT INTO users(id,email,name,password,max_storage,max_vaults,max_file) SELECT id,email,name,password,?,?,? FROM owner", s.Config.DefaultUserStorage, s.Config.MaxVaults, s.Config.MaxFile); e != nil {
		return e
	}
	for _, q := range statements[1:] {
		if _, e = tx.Exec(q); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("DROP TABLE owner"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	return syncDir(s.Config.DataDir)
}

// Used by tests and restore validation without ever following symlinks.
func regularFile(path string) error {
	st, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() {
		return errors.New("expected a regular file")
	}
	return nil
}
