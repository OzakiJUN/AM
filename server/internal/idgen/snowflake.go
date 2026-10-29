// Package idgen generates 64-bit, time-ordered unique ids (snowflake layout):
//
//	1 bit unused | 41 bits ms since epoch | 10 bits node | 12 bits sequence
//
// Ids from different nodes never collide, and sorting ids sorts by time.
package idgen

import (
	"sync"
	"time"
)

// Epoch is 2026-01-01T00:00:00Z. 41 bits of ms last about 69 years from here.
var Epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()

const (
	nodeBits = 10
	seqBits  = 12
	maxSeq   = 1<<seqBits - 1
)

type Generator struct {
	mu     sync.Mutex
	node   int64
	lastMS int64
	seq    int64
	now    func() int64
}

func New(node int64) *Generator {
	return &Generator{node: node & (1<<nodeBits - 1), now: func() int64 { return time.Now().UnixMilli() }}
}

func (g *Generator) Next() int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	ms := g.now()
	if ms < g.lastMS {
		// Clock went backwards: keep using the last timestamp.
		ms = g.lastMS
	}
	if ms == g.lastMS {
		g.seq = (g.seq + 1) & maxSeq
		if g.seq == 0 {
			// 4096 ids used up in this ms: wait for the next one.
			for ms <= g.lastMS {
				time.Sleep(100 * time.Microsecond)
				ms = g.now()
			}
		}
	} else {
		g.seq = 0
	}
	g.lastMS = ms
	return (ms-Epoch)<<(nodeBits+seqBits) | g.node<<seqBits | g.seq
}
