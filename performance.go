package bulldb

import (
	"log"
	"sync"
	"time"
)

type CacheItem struct {
	Value      interface{}
	Expiration time.Time
}

type TTLPerformanceCache struct {
	mu    sync.RWMutex
	items map[string]CacheItem
}

var GlobalCache = &TTLPerformanceCache{
	items: make(map[string]CacheItem),
}

func (c *TTLPerformanceCache) Set(key string, val interface{}, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = CacheItem{
		Value:      val,
		Expiration: time.Now().Add(ttl),
	}
}

func (c *TTLPerformanceCache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	item, ok := c.items[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(item.Expiration) {
		return nil, false
	}
	return item.Value, true
}

type N1QueryDetector struct {
	mu           sync.Mutex
	queryHistory map[string][]time.Time
}

var GlobalDetector = &N1QueryDetector{
	queryHistory: make(map[string][]time.Time),
}

func (d *N1QueryDetector) RecordQuery(table string) {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := time.Now()
	d.queryHistory[table] = append(d.queryHistory[table], now)

	// Clean older records (> 5 seconds ago)
	var recent []time.Time
	for _, t := range d.queryHistory[table] {
		if now.Sub(t) < 5*time.Second {
			recent = append(recent, t)
		}
	}
	d.queryHistory[table] = recent

	// Trigger alert if more than 10 repeated queries to the same table in 5s
	if len(recent) > 10 {
		log.Printf("[WARNING] Possible N+1 Query pattern detected on table: %s. %d executions in 5 seconds.", table, len(recent))
	}
}
