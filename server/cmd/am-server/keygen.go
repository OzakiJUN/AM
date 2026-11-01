package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"os"
)

// workshopKeygen makes the creative workshop's signing key pair (docs/design.md
// §13): the private key goes into a file the owner pastes into the
// am-workshop repository's GitHub Secret WORKSHOP_SIGNING_KEY and then
// deletes; the public key is printed (and saved) to be built into the client.
// It never overwrites an existing key file.
func workshopKeygen(args []string) error {
	fs := flag.NewFlagSet("workshop-keygen", flag.ContinueOnError)
	out := fs.String("out", "workshop_signing_key.txt", "file for the private key")
	pubOut := fs.String("pub", "workshop_public_key.txt", "file for the public key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	for _, p := range []string{*out, *pubOut} {
		if _, err := os.Stat(p); err == nil {
			return fmt.Errorf("%s already exists: delete or move it first (it may be a key you still need)", p)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	// The private key file holds the 32-byte seed, base64.
	if err := os.WriteFile(*out, []byte(base64.StdEncoding.EncodeToString(priv.Seed())+"\n"), 0o600); err != nil {
		return err
	}
	pubText := base64.StdEncoding.EncodeToString(pub)
	if err := os.WriteFile(*pubOut, []byte(pubText+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Println("Workshop signing key created.")
	fmt.Println()
	fmt.Println("PRIVATE key (secret!) saved to:", *out)
	fmt.Println("  Paste its content into GitHub: am-workshop > Settings > Secrets and variables >")
	fmt.Println("  Actions > New repository secret, name WORKSHOP_SIGNING_KEY. Then delete the file.")
	fmt.Println("  Never send it to anyone, not even in a chat.")
	fmt.Println()
	fmt.Println("PUBLIC key (safe to share, send it to Claude):")
	fmt.Println("  " + pubText)
	fmt.Println("  (also saved to " + *pubOut + ")")
	return nil
}
