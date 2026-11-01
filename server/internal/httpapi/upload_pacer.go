package httpapi

import (
	"context"
	"io"
	"time"
)

// All background uploads share one turn queue. A turn accounts for actual
// bytes, including a short last read. Cancelled requests release their turn.
type uploadPacer struct {
	bytesPerSecond int64
	turn           chan struct{}
}

func newUploadPacer(kbps int) *uploadPacer {
	if kbps == 0 {
		return nil
	}
	return &uploadPacer{int64(kbps) * 1024, make(chan struct{}, 1)}
}

type pacedBody struct {
	io.ReadCloser
	ctx  context.Context
	rate *uploadPacer
}

func (r *pacedBody) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p[:min(len(p), 4096)])
	if n == 0 {
		return n, err
	}
	select {
	case r.rate.turn <- struct{}{}:
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	}
	defer func() { <-r.rate.turn }()
	timer := time.NewTimer(time.Duration(int64(n) * int64(time.Second) / r.rate.bytesPerSecond))
	defer timer.Stop()
	select {
	case <-timer.C:
		return n, err
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	}
}
