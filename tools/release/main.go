// release writes and signs release.json for a GitHub release (docs/release.md):
//
//	RELEASE_SIGNING_KEY=... go run ./tools/release -version 0.2.0 -dir dist -changelog CHANGELOG.md
//	go run ./tools/release -notes -version 0.2.0   # just print the notes
//
// Every file in -dir goes into the manifest (size + SHA-256); the notes are
// the version's CHANGELOG section. The signature must match the public key
// built into this source tree (internal/release.PublicKey), so a release
// can't go out signed with a key the apps won't accept.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/OzakiJUN/am/internal/release"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

func run() error {
	version := flag.String("version", "", "version, e.g. 0.2.0")
	dir := flag.String("dir", "dist", "folder with the release files")
	changelog := flag.String("changelog", "CHANGELOG.md", "changelog to take the notes from")
	onlyNotes := flag.Bool("notes", false, "only print the version's notes")
	flag.Parse()
	if !release.Valid(*version) || (*version)[0] == 'v' {
		return fmt.Errorf("bad -version %q (like 0.2.0)", *version)
	}
	log, err := os.ReadFile(*changelog)
	if err != nil {
		return err
	}
	notes := release.Notes(string(log), *version)
	if notes == "" {
		return fmt.Errorf("%s has no \"## %s\" section", *changelog, *version)
	}
	if *onlyNotes {
		fmt.Println(notes)
		return nil
	}
	seed := os.Getenv("RELEASE_SIGNING_KEY")
	if seed == "" {
		return errors.New("RELEASE_SIGNING_KEY is not set")
	}
	entries, err := os.ReadDir(*dir)
	if err != nil {
		return err
	}
	m := release.Manifest{Version: *version, Date: time.Now().UTC().Format("2006-01-02"), Notes: notes}
	for _, e := range entries {
		if !e.Type().IsRegular() || e.Name() == release.ManifestName || e.Name() == release.SignatureName {
			continue
		}
		f, err := hashFile(filepath.Join(*dir, e.Name()))
		if err != nil {
			return err
		}
		m.Files = append(m.Files, f)
	}
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Name < m.Files[j].Name })
	if len(m.Files) == 0 {
		return fmt.Errorf("no files in %s", *dir)
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if _, err := release.Parse(data); err != nil {
		return err
	}
	sig, pub, err := release.Sign(data, seed)
	if err != nil {
		return err
	}
	if release.PublicKey == "" {
		return errors.New("internal/release.PublicKey is empty: build the public key in first")
	}
	if pub != release.PublicKey {
		return errors.New("RELEASE_SIGNING_KEY does not match internal/release.PublicKey")
	}
	if err := os.WriteFile(filepath.Join(*dir, release.ManifestName), data, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(*dir, release.SignatureName), []byte(sig+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Printf("signed %s %s: %d files\n", release.ManifestName, *version, len(m.Files))
	return nil
}

func hashFile(path string) (release.File, error) {
	f, err := os.Open(path)
	if err != nil {
		return release.File{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return release.File{}, err
	}
	return release.File{Name: filepath.Base(path), Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}
