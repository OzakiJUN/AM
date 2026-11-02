// Package release describes an AM release for the updaters (docs/design.md §3
// 更新): CI publishes release.json (the manifest: version, date, notes, every
// file's size and SHA-256) and release.json.sig (Ed25519 over the exact bytes
// of release.json, base64) with each GitHub release. The server and the
// client verify the signature with the public key built into them, then each
// downloaded file against its SHA-256, so it doesn't matter who relays the
// files (GitHub, a mirror, the server's copy). Pure and tested; the client
// has the same rules in client/src/lib/release.ts.
package release

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// PublicKey verifies releases (base64 Ed25519). It is made by
// `am-server release-keygen`; the private key lives only in the GitHub
// Secret RELEASE_SIGNING_KEY. Empty = this build can't update itself.
// (A variable only so a local test build can use a test key with
// -ldflags "-X github.com/OzakiJUN/am/internal/release.PublicKey=...";
// releases use the one written here.)
var PublicKey = ""

// Manifest and signature file names, next to the release's other files.
const (
	ManifestName  = "release.json"
	SignatureName = "release.json.sig"
	// ClientInstaller is the Windows client's installer (NSIS).
	ClientInstaller = "AM-setup.exe"
)

// File is one file of a release.
type File struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is release.json.
type Manifest struct {
	Version string `json:"version"` // "0.2.0", no "v"
	Date    string `json:"date"`    // "2026-11-02"
	Notes   string `json:"notes"`   // this version's CHANGELOG section
	Files   []File `json:"files"`
}

// Tag is the git tag of a version ("v0.2.0").
func (m *Manifest) Tag() string { return "v" + m.Version }

// File returns the named file, or nil.
func (m *Manifest) File(name string) *File {
	for i := range m.Files {
		if m.Files[i].Name == name {
			return &m.Files[i]
		}
	}
	return nil
}

var (
	versionRe = regexp.MustCompile(`^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z.]{1,32}))?$`)
	nameRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
	shaRe     = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Parse reads and checks a manifest.
func Parse(data []byte) (*Manifest, error) {
	var m Manifest
	d := json.NewDecoder(bytes.NewReader(data))
	if err := d.Decode(&m); err != nil {
		return nil, fmt.Errorf("release.json: %w", err)
	}
	if !versionRe.MatchString(m.Version) {
		return nil, fmt.Errorf("release.json: bad version %q", m.Version)
	}
	seen := map[string]bool{}
	for _, f := range m.Files {
		if !nameRe.MatchString(f.Name) || seen[f.Name] {
			return nil, fmt.Errorf("release.json: bad file name %q", f.Name)
		}
		if f.Size <= 0 || !shaRe.MatchString(f.SHA256) {
			return nil, fmt.Errorf("release.json: bad size or sha256 for %s", f.Name)
		}
		seen[f.Name] = true
	}
	return &m, nil
}

// ErrNoKey: this build has no release public key built in.
var ErrNoKey = errors.New("这个版本没有内置发布公钥，不能自动更新")

// Verify checks sig (base64 Ed25519, as in release.json.sig) over data with
// pub (base64; "" = PublicKey).
func Verify(data []byte, sig, pub string) error {
	if pub == "" {
		pub = PublicKey
	}
	if pub == "" {
		return ErrNoKey
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pub))
	if err != nil || len(key) != ed25519.PublicKeySize {
		return errors.New("release public key is broken")
	}
	s, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sig))
	if err != nil || len(s) != ed25519.SignatureSize || !ed25519.Verify(key, data, s) {
		return errors.New("release.json 的签名不对（文件被改过，或者不是官方发布的）")
	}
	return nil
}

// Sign signs data with a base64 seed (the content of RELEASE_SIGNING_KEY)
// and returns the base64 signature and the matching public key.
func Sign(data []byte, seed string) (sig, pub string, err error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(seed))
	if err != nil || len(b) != ed25519.SeedSize {
		return "", "", errors.New("signing key must be a base64 32-byte seed")
	}
	k := ed25519.NewKeyFromSeed(b)
	return base64.StdEncoding.EncodeToString(ed25519.Sign(k, data)),
		base64.StdEncoding.EncodeToString(k.Public().(ed25519.PublicKey)), nil
}

// Load parses data after checking its signature.
func Load(data []byte, sig, pub string) (*Manifest, error) {
	if err := Verify(data, sig, pub); err != nil {
		return nil, err
	}
	return Parse(data)
}

// CheckFile compares a downloaded file with its entry.
func CheckFile(f *File, size int64, sum []byte) error {
	if size != f.Size || hex.EncodeToString(sum) != f.SHA256 {
		return fmt.Errorf("%s 下载得不对（大小或校验和对不上）", f.Name)
	}
	return nil
}

type semver struct {
	n   [3]int
	pre string
}

func parseVersion(v string) (semver, bool) {
	m := versionRe.FindStringSubmatch(strings.TrimPrefix(strings.TrimSpace(v), "v"))
	if m == nil {
		return semver{}, false
	}
	var s semver
	for i := 0; i < 3; i++ {
		s.n[i], _ = strconv.Atoi(m[i+1])
	}
	s.pre = m[4]
	return s, true
}

// Valid reports whether v is a release version ("0.2.0", "v0.2.0",
// "0.2.0-beta.1"). Development builds ("dev", "main-abc1234") are not.
func Valid(v string) bool {
	_, ok := parseVersion(v)
	return ok
}

// Compare compares two versions like semver (a pre-release comes before its
// release; pre-releases compare as text). Invalid versions count as older
// than every valid one.
func Compare(a, b string) int {
	x, okA := parseVersion(a)
	y, okB := parseVersion(b)
	switch {
	case !okA && !okB:
		return 0
	case !okA:
		return -1
	case !okB:
		return 1
	}
	for i := 0; i < 3; i++ {
		if x.n[i] != y.n[i] {
			if x.n[i] < y.n[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case x.pre == y.pre:
		return 0
	case x.pre == "":
		return 1
	case y.pre == "":
		return -1
	case x.pre < y.pre:
		return -1
	}
	return 1
}

// ServerFile is the am-server binary for a platform ("" = no build for it).
func ServerFile(goos, goarch string) string {
	switch goos + "/" + goarch {
	case "windows/amd64":
		return "am-server-windows-amd64.exe"
	case "linux/amd64":
		return "am-server-linux-amd64"
	}
	return ""
}

// Notes returns a version's section of CHANGELOG.md: the lines after its
// "## <version>" heading (anything after the version on that line is
// ignored) up to the next "## " heading.
func Notes(changelog, version string) string {
	var out []string
	in := false
	for _, line := range strings.Split(strings.ReplaceAll(changelog, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, "## ") {
			if in {
				break
			}
			head := strings.TrimSpace(strings.TrimPrefix(line, "## "))
			head = strings.TrimPrefix(head, "v")
			if head == version || strings.HasPrefix(head, version+" ") || strings.HasPrefix(head, version+"（") || strings.HasPrefix(head, version+"(") {
				in = true
			}
			continue
		}
		if in {
			out = append(out, line)
		}
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}
