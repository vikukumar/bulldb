package bulldb

import (
	"context"
	"log"
	"sync"
	"time"
)

type ObservabilityEngine struct {
	mu      sync.Mutex
	metrics map[string]int64
}

var telemetry = &ObservabilityEngine{
	metrics: make(map[string]int64),
}

func (o *ObservabilityEngine) RecordQueryMetrics(query string, duration time.Duration) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.metrics["query_executions"]++
	log.Printf("[TELEMETRY] Query: %s. Duration: %v", query, duration)
}

func (o *ObservabilityEngine) IncrementMetric(name string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.metrics[name]++
}

func (o *ObservabilityEngine) GetMetric(name string) int64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.metrics[name]
}

type TracingSpan struct {
	Name      string
	StartTime time.Time
}

func StartTracingSpan(ctx context.Context, name string) (*TracingSpan, context.Context) {
	span := &TracingSpan{
		Name:      name,
		StartTime: time.Now(),
	}
	// Return span and context mock
	return span, ctx
}

func (s *TracingSpan) Finish() {
	log.Printf("[TRACING] Span %s finished in %v", s.Name, time.Since(s.StartTime))
}
