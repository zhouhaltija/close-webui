// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"sync"
	"testing"
	"time"
)

// A paused request loop must recover every byte the writer consumed, even
// when it consumed more fragments than fit in the old notification channel.
func TestStreamCreditLedgerRetainsBytesWhileReaderPaused(t *testing.T) {
	credits := newStreamCreditLedger()
	for i := 0; i < 512; i++ {
		credits.release(3)
	}
	select {
	case <-credits.ready:
	default:
		t.Fatal("consumption did not wake the request loop")
	}
	if got := credits.take(); got != 1536 {
		t.Fatalf("recovered %d consumed bytes, want 1536; the next enqueue can remain blocked by lost credit", got)
	}
	if got := credits.take(); got != 0 {
		t.Fatalf("consumed bytes counted twice: %d", got)
	}
	credits.release(4)
	select {
	case <-credits.ready:
	default:
		t.Fatal("later consumption did not wake the request loop")
	}
	if got := credits.take(); got != 4 {
		t.Fatalf("later consumption = %d, want 4", got)
	}
}

func TestStreamCreditLedgerRestoresFullQueueBudget(t *testing.T) {
	credits := newStreamCreditLedger()
	// 512 small fragments consume the entire 1MiB budget. The writer drains
	// them while a request-loop scheduling pause prevents credit consumption.
	pendingBytes := 1 << 20
	for i := 0; i < 512; i++ {
		credits.release(2048)
	}
	<-credits.ready
	pendingBytes -= credits.take()
	if pendingBytes != 0 {
		t.Fatalf("empty queue still reserves %d bytes after the writer consumed every fragment", pendingBytes)
	}
	if pendingBytes+2048 > streamQueueBytes {
		t.Fatal("next small fragment cannot enter the empty bounded queue")
	}
}

func TestStreamCreditLedgerConcurrentReleaseAndDrain(t *testing.T) {
	credits := newStreamCreditLedger()
	var writers sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for i := 0; i < 20000; i++ {
				credits.release(1)
			}
		}()
	}
	finished := make(chan struct{})
	go func() { writers.Wait(); close(finished) }()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	total := 0
	for {
		select {
		case <-credits.ready:
			total += credits.take()
		case <-finished:
			total += credits.take()
			if total != 80000 {
				t.Fatalf("recovered %d of 80000 concurrently consumed bytes", total)
			}
			return
		case <-deadline.C:
			t.Fatal("writer blocked while the request loop consumed notifications")
		}
	}
}
