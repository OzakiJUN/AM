package plugin

// Reading an uploaded plugin zip: which plugin packages it holds and their
// files. A zip may hold one plugin or several (a folder of plugins, or a
// NoneBot project with src/plugins/...). Pure, unit-tested.

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"
)

// Package is one plugin found in a zip: its folder name and its files
// (paths relative to that folder, "/"-separated).
type Package struct {
	Dir   string
	Files map[string][]byte
}

// SHA256 of the package's files (paths and contents), to tell versions apart.
func (p Package) SHA256() string {
	names := make([]string, 0, len(p.Files))
	for n := range p.Files {
		names = append(names, n)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		sum := sha256.Sum256(p.Files[n])
		fmt.Fprintf(h, "%s\x00%x\n", n, sum)
	}
	return hex.EncodeToString(h.Sum(nil))
}

const maxZipEntries = 5000

var (
	reDir = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
	// Folders our NoneBot uses itself, and names that would shadow it.
	reservedDirs = map[string]bool{"nonebot": true, "plugins": true, "bot": true, "am": true, "src": true, "test": true, "tests": true}
	// Single files at the top that are a project's, not plugins.
	notPluginFiles = map[string]bool{"bot.py": true, "setup.py": true, "main.py": true, "__init__.py": true, "conftest.py": true}
)

// ErrBadZip explains why a zip can't be used (message for the owner).
type ErrBadZip struct{ Reason string }

func (e *ErrBadZip) Error() string { return e.Reason }

func bad(format string, a ...any) error { return &ErrBadZip{Reason: fmt.Sprintf(format, a...)} }

// skip: files nobody needs (caches, editor / OS litter, compiled code).
func skip(name string) bool {
	for _, part := range strings.Split(name, "/") {
		switch part {
		case "__pycache__", "__MACOSX", ".git", ".svn", ".idea", ".vscode", ".venv", "venv", "node_modules", ".DS_Store", ".mypy_cache", ".pytest_cache":
			return true
		}
	}
	base := path.Base(name)
	return strings.HasSuffix(base, ".pyc") || strings.HasSuffix(base, ".pyo") || base == "Thumbs.db" || base == ".env" || strings.HasPrefix(base, ".env.")
}

// Unpack reads the plugins in a zip. maxUnpacked limits the total size of
// the files kept.
func Unpack(data []byte, maxUnpacked int64) ([]Package, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, bad("不是 zip 文件")
	}
	if len(zr.File) > maxZipEntries {
		return nil, bad("文件太多（最多 %d 个）", maxZipEntries)
	}
	files := map[string][]byte{}
	var total int64
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, `\`, "/")
		if f.FileInfo().IsDir() || strings.HasSuffix(name, "/") {
			continue
		}
		if f.Mode()&^0o777 != 0 && !f.Mode().IsRegular() {
			return nil, bad("「%s」不是普通文件（链接之类的不行）", name)
		}
		clean := path.Clean(name)
		if strings.HasPrefix(name, "/") || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(name, ":") {
			return nil, bad("「%s」的路径不安全", name)
		}
		if skip(clean) {
			continue
		}
		if _, dup := files[clean]; dup {
			return nil, bad("「%s」出现了两次", clean)
		}
		if int64(f.UncompressedSize64) > maxUnpacked-total {
			return nil, bad("解压后太大（最多 %d MB）", maxUnpacked>>20)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, bad("「%s」读不出来", clean)
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxUnpacked-total+1))
		rc.Close()
		if err != nil {
			return nil, bad("「%s」读不出来", clean)
		}
		total += int64(len(b))
		if total > maxUnpacked {
			return nil, bad("解压后太大（最多 %d MB）", maxUnpacked>>20)
		}
		files[clean] = b
	}
	return findPackages(files)
}

// findPackages: every top-most folder with an __init__.py is a plugin; .py
// files at the top (after one wrapper folder) are single-file plugins.
func findPackages(files map[string][]byte) ([]Package, error) {
	has := func(dir string) bool { _, ok := files[path.Join(dir, "__init__.py")]; return ok }
	roots := map[string]bool{}
	for name := range files {
		if path.Base(name) != "__init__.py" {
			continue
		}
		dir := path.Dir(name)
		if dir == "." {
			continue
		}
		top := dir
		for p := path.Dir(top); p != "." && has(p); p = path.Dir(p) {
			top = p
		}
		roots[top] = true
	}
	// The top level: the zip's root, or its only folder.
	top := "."
	firsts := map[string]bool{}
	for name := range files {
		firsts[strings.SplitN(name, "/", 2)[0]] = true
	}
	if len(firsts) == 1 {
		for f := range firsts {
			if _, isFile := files[f]; !isFile && !roots[f] {
				top = f
			}
		}
	}
	var out []Package
	seen := map[string]string{}
	add := func(dir, from string, fs map[string][]byte) error {
		if !reDir.MatchString(dir) {
			return bad("插件名「%s」不能用：只能用英文字母、数字和下划线，不能以数字开头", dir)
		}
		if reservedDirs[strings.ToLower(dir)] || strings.HasPrefix(strings.ToLower(dir), "nonebot") {
			return bad("插件名「%s」是保留的，请改个名字", dir)
		}
		if prev, ok := seen[dir]; ok {
			return bad("有两个插件都叫「%s」（%s 和 %s）", dir, prev, from)
		}
		seen[dir] = from
		out = append(out, Package{Dir: dir, Files: fs})
		return nil
	}
	rootList := make([]string, 0, len(roots))
	for r := range roots {
		rootList = append(rootList, r)
	}
	sort.Strings(rootList)
	for _, r := range rootList {
		fs := map[string][]byte{}
		for name, b := range files {
			if strings.HasPrefix(name, r+"/") {
				fs[strings.TrimPrefix(name, r+"/")] = b
			}
		}
		if err := add(path.Base(r), r, fs); err != nil {
			return nil, err
		}
	}
	var singles []string
	for name := range files {
		if path.Dir(name) == top && strings.HasSuffix(name, ".py") && !notPluginFiles[path.Base(name)] {
			singles = append(singles, name)
		}
	}
	sort.Strings(singles)
	for _, name := range singles {
		if err := add(strings.TrimSuffix(path.Base(name), ".py"), name, map[string][]byte{"__init__.py": files[name]}); err != nil {
			return nil, err
		}
	}
	if len(out) == 0 {
		return nil, bad("没找到插件：插件是带 __init__.py 的文件夹，或者一个 .py 文件")
	}
	return out, nil
}
