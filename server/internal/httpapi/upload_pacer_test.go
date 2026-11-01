package httpapi

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"
)

func TestUploadsSharePacer(t *testing.T) {
	rate := newUploadPacer(64)
	start := time.Now()
	done := make(chan error, 2)
	for range 2 {
		go func() {
			body := pacedBody{io.NopCloser(bytes.NewReader(make([]byte, 4096))), context.Background(), rate}
			_, err := io.Copy(io.Discard, &body)
			done <- err
		}()
	}
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if time.Since(start) < 125*time.Millisecond {
		t.Fatal("concurrent uploads exceeded shared budget")
	}
}
