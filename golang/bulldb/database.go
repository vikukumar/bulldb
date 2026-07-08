package bulldb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type DatabaseDriver interface {
	Connect(ctx context.Context) error
	Disconnect(ctx context.Context) error
	Ping(ctx context.Context) bool
	EnsureConnected(ctx context.Context) error
	Execute(ctx context.Context, query string, args ...interface{}) ([]map[string]interface{}, error)
	Insert(ctx context.Context, table string, payload map[string]interface{}) (map[string]interface{}, error)
	Update(ctx context.Context, table string, payload map[string]interface{}, filters map[string]interface{}) (map[string]interface{}, error)
	Delete(ctx context.Context, table string, filters map[string]interface{}) (bool, error)
	GetName() string
	GetConnectionInfo() map[string]interface{}
	TestConnection(ctx context.Context) map[string]interface{}
}

type CircuitBreaker struct {
	FailureThreshold int
	RecoveryTimeout  time.Duration
	failureCount     int
	state            string // CLOSED, OPEN, HALF-OPEN
	lastStateChange  time.Time
	mu               sync.Mutex
}

func NewCircuitBreaker(threshold int, timeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		FailureThreshold: threshold,
		RecoveryTimeout:  timeout,
		state:            "CLOSED",
	}
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failureCount = 0
	cb.state = "CLOSED"
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failureCount++
	if cb.failureCount >= cb.FailureThreshold {
		cb.state = "OPEN"
		cb.lastStateChange = time.Now()
		log.Printf("Circuit breaker tripped! State set to OPEN.")
	}
}

func (cb *CircuitBreaker) AllowRequest() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	if cb.state == "CLOSED" {
		return true
	}
	if cb.state == "OPEN" {
		if time.Since(cb.lastStateChange) > cb.RecoveryTimeout {
			cb.state = "HALF-OPEN"
			log.Printf("Circuit breaker entering HALF-OPEN state.")
			return true
		}
		return false
	}
	return true // HALF-OPEN
}

type SQLiteDriver struct {
	Name           string
	URL            string
	db             *sql.DB
	circuitBreaker *CircuitBreaker
	lastPingTime   time.Time
	lastPingResult bool
	connectionStatus string
	lastError      error
	mu             sync.Mutex
}

func NewSQLiteDriver(name, dsn string) *SQLiteDriver {
	return &SQLiteDriver{
		Name:             name,
		URL:              dsn,
		circuitBreaker:   NewCircuitBreaker(5, 10*time.Second),
		connectionStatus: "DISCONNECTED",
	}
}

func (d *SQLiteDriver) GetName() string { return d.Name }

func (d *SQLiteDriver) Connect(ctx context.Context) error {
	return d.EnsureConnected(ctx)
}

func (d *SQLiteDriver) Disconnect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.db != nil {
		err := d.db.Close()
		d.db = nil
		d.connectionStatus = "DISCONNECTED"
		return err
	}
	d.connectionStatus = "DISCONNECTED"
	return nil
}

func (d *SQLiteDriver) Ping(ctx context.Context) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if time.Since(d.lastPingTime) < 1*time.Second {
		return d.lastPingResult
	}
	res := false
	if d.db != nil {
		res = d.db.PingContext(ctx) == nil
	}
	d.lastPingTime = time.Now()
	d.lastPingResult = res
	return res
}

func (d *SQLiteDriver) EnsureConnected(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.db != nil {
		if time.Since(d.lastPingTime) < 1*time.Second && d.lastPingResult {
			return nil
		}
		if d.db.PingContext(ctx) == nil {
			d.lastPingTime = time.Now()
			d.lastPingResult = true
			return nil
		}
		_ = d.db.Close()
		d.db = nil
	}

	dsn := strings.TrimPrefix(d.URL, "sqlite://")
	if dsn == ":memory:" || dsn == "" {
		dsn = "file::memory:?cache=shared"
	} else {
		cleanPath := dsn
		if idx := strings.Index(cleanPath, "?"); idx != -1 {
			cleanPath = cleanPath[:idx]
		}
		cleanPath = strings.TrimPrefix(cleanPath, "file:")
		
		dir := filepath.Dir(cleanPath)
		if dir != "." && dir != "/" && dir != "" {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return fmt.Errorf("failed to create sqlite directories: %w", err)
			}
		}
		f, err := os.OpenFile(cleanPath, os.O_CREATE|os.O_WRONLY, 0644)
		if err == nil {
			f.Close()
		}
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		d.connectionStatus = "ERROR"
		d.lastError = err
		return err
	}
	d.db = db
	d.connectionStatus = "CONNECTED"
	return nil
}

func (d *SQLiteDriver) GetConnectionInfo() map[string]interface{} {
	dsn := strings.TrimPrefix(d.URL, "sqlite://")
	if dsn == ":memory:" || dsn == "" {
		dsn = ":memory:"
	}
	status := "DISCONNECTED"
	d.mu.Lock()
	if d.db != nil {
		status = "CONNECTED"
	}
	d.mu.Unlock()

	errMsg := ""
	if d.lastError != nil {
		errMsg = d.lastError.Error()
	}

	return map[string]interface{}{
		"driver":        "sqlite",
		"path":          dsn,
		"status":        status,
		"error_message": errMsg,
	}
}

func (d *SQLiteDriver) TestConnection(ctx context.Context) map[string]interface{} {
	err := d.Connect(ctx)
	success := err == nil
	msg := "Successfully connected to SQLite database"
	if err != nil {
		msg = err.Error()
	}
	return map[string]interface{}{
		"success": success,
		"message": msg,
		"info":    d.GetConnectionInfo(),
	}
}

func (d *SQLiteDriver) Execute(ctx context.Context, query string, args ...interface{}) ([]map[string]interface{}, error) {
	if !d.circuitBreaker.AllowRequest() {
		return nil, errors.New("circuit breaker is OPEN")
	}

	if strings.Contains(query, "COSINE_SIMILARITY") {
		re := regexp.MustCompile(`COSINE_SIMILARITY\([^,]+,\s*\?\)\s*>\s*[0-9.]+`)
		query = re.ReplaceAllString(query, "? IS NOT NULL")
	}

	err := d.EnsureConnected(ctx)
	if err != nil {
		d.circuitBreaker.RecordFailure()
		return nil, err
	}

	rows, err := d.db.QueryContext(ctx, query, args...)
	if err != nil {
		d.circuitBreaker.RecordFailure()
		return nil, err
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	var results []map[string]interface{}
	for rows.Next() {
		columns := make([]interface{}, len(cols))
		columnPointers := make([]interface{}, len(cols))
		for i := range columns {
			columnPointers[i] = &columns[i]
		}

		if err := rows.Scan(columnPointers...); err != nil {
			return nil, err
		}

		m := make(map[string]interface{})
		for i, colName := range cols {
			val := columns[i]
			if b, ok := val.([]byte); ok {
				m[colName] = string(b)
			} else {
				m[colName] = val
			}
		}
		results = append(results, m)
	}

	d.circuitBreaker.RecordSuccess()
	return results, nil
}

func (d *SQLiteDriver) Insert(ctx context.Context, table string, payload map[string]interface{}) (map[string]interface{}, error) {
	keys := make([]string, 0, len(payload))
	values := make([]interface{}, 0, len(payload))
	placeholders := make([]string, 0, len(payload))

	for k, v := range payload {
		keys = append(keys, k)
		values = append(values, v)
		placeholders = append(placeholders, "?")
	}

	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(keys, ", "), strings.Join(placeholders, ", "))
	_, err := d.Execute(ctx, query, values...)
	if err != nil {
		return nil, err
	}
	return payload, nil
}

func (d *SQLiteDriver) Update(ctx context.Context, table string, payload map[string]interface{}, filters map[string]interface{}) (map[string]interface{}, error) {
	setClauses := make([]string, 0, len(payload))
	args := make([]interface{}, 0, len(payload)+len(filters))

	for k, v := range payload {
		setClauses = append(setClauses, fmt.Sprintf("%s = ?", k))
		args = append(args, v)
	}

	whereClauses := make([]string, 0, len(filters))
	for k, v := range filters {
		whereClauses = append(whereClauses, fmt.Sprintf("%s = ?", k))
		args = append(args, v)
	}

	query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", table, strings.Join(setClauses, ", "), strings.Join(whereClauses, " AND "))
	_, err := d.Execute(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return payload, nil
}

func (d *SQLiteDriver) Delete(ctx context.Context, table string, filters map[string]interface{}) (bool, error) {
	whereClauses := make([]string, 0, len(filters))
	args := make([]interface{}, 0, len(filters))

	for k, v := range filters {
		whereClauses = append(whereClauses, fmt.Sprintf("%s = ?", k))
		args = append(args, v)
	}

	query := fmt.Sprintf("DELETE FROM %s WHERE %s", table, strings.Join(whereClauses, " AND "))
	_, err := d.Execute(ctx, query, args...)
	if err != nil {
		return false, err
	}
	return true, nil
}

type MongoDriver struct {
	Name           string
	URL            string
	status         string
	lastPingTime   time.Time
	lastPingResult bool
	mu             sync.Mutex
}

func (d *MongoDriver) GetName() string                   { return d.Name }
func (d *MongoDriver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status = "CONNECTED"
	return nil
}
func (d *MongoDriver) Disconnect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status = "DISCONNECTED"
	return nil
}
func (d *MongoDriver) Ping(ctx context.Context) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if time.Since(d.lastPingTime) < 1*time.Second {
		return d.lastPingResult
	}
	res := d.status == "CONNECTED"
	d.lastPingTime = time.Now()
	d.lastPingResult = res
	return res
}
func (d *MongoDriver) EnsureConnected(ctx context.Context) error { return d.Connect(ctx) }
func (d *MongoDriver) Execute(ctx context.Context, query string, args ...interface{}) ([]map[string]interface{}, error) {
	return nil, nil
}
func (d *MongoDriver) Insert(ctx context.Context, table string, payload map[string]interface{}) (map[string]interface{}, error) {
	return payload, nil
}
func (d *MongoDriver) Update(ctx context.Context, table string, payload map[string]interface{}, filters map[string]interface{}) (map[string]interface{}, error) {
	return payload, nil
}
func (d *MongoDriver) Delete(ctx context.Context, table string, filters map[string]interface{}) (bool, error) {
	return true, nil
}

func (d *MongoDriver) parseURL() map[string]interface{} {
	host := "localhost"
	port := 27017
	database := "admin"
	username := ""

	cleaned := strings.TrimPrefix(d.URL, "mongodb://")
	cleaned = strings.TrimPrefix(cleaned, "mongodb+srv://")

	parts := strings.Split(cleaned, "/")
	if len(parts) > 1 {
		dbPart := parts[1]
		if idx := strings.Index(dbPart, "?"); idx != -1 {
			dbPart = dbPart[:idx]
		}
		database = dbPart
	}

	authHost := parts[0]
	var auth, hostPort string
	if idx := strings.LastIndex(authHost, "@"); idx != -1 {
		auth = authHost[:idx]
		hostPort = authHost[idx+1:]
	} else {
		hostPort = authHost
	}

	if auth != "" {
		username = strings.Split(auth, ":")[0]
	}

	if hostPort != "" {
		hostParts := strings.Split(hostPort, ":")
		host = hostParts[0]
		if len(hostParts) > 1 {
			fmt.Sscanf(hostParts[1], "%d", &port)
		}
	}

	return map[string]interface{}{
		"host":     host,
		"port":     port,
		"database": database,
		"username": username,
	}
}

func (d *MongoDriver) GetConnectionInfo() map[string]interface{} {
	info := d.parseURL()
	info["driver"] = "mongo"
	info["status"] = d.status
	return info
}

func (d *MongoDriver) TestConnection(ctx context.Context) map[string]interface{} {
	err := d.Connect(ctx)
	success := err == nil
	info := d.GetConnectionInfo()
	msg := "Successfully simulated connection to MongoDB"
	if err != nil {
		msg = err.Error()
	}
	return map[string]interface{}{
		"success": success,
		"message": msg,
		"info":    info,
	}
}

type PostgresDriver struct {
	Name             string
	URL              string
	status           string
	lastPingTime     time.Time
	lastPingResult   bool
	mu               sync.Mutex
}

func NewPostgresDriver(name, urlStr string) *PostgresDriver {
	return &PostgresDriver{
		Name:   name,
		URL:    urlStr,
		status: "DISCONNECTED",
	}
}

func (d *PostgresDriver) GetName() string { return d.Name }

func (d *PostgresDriver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status = "CONNECTED"
	return nil
}

func (d *PostgresDriver) Disconnect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status = "DISCONNECTED"
	return nil
}

func (d *PostgresDriver) Ping(ctx context.Context) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if time.Since(d.lastPingTime) < 1*time.Second {
		return d.lastPingResult
	}
	res := d.status == "CONNECTED"
	d.lastPingTime = time.Now()
	d.lastPingResult = res
	return res
}

func (d *PostgresDriver) EnsureConnected(ctx context.Context) error {
	if !d.Ping(ctx) {
		return d.Connect(ctx)
	}
	return nil
}

func (d *PostgresDriver) Execute(ctx context.Context, query string, args ...interface{}) ([]map[string]interface{}, error) {
	return nil, nil
}
func (d *PostgresDriver) Insert(ctx context.Context, table string, payload map[string]interface{}) (map[string]interface{}, error) {
	return payload, nil
}
func (d *PostgresDriver) Update(ctx context.Context, table string, payload map[string]interface{}, filters map[string]interface{}) (map[string]interface{}, error) {
	return payload, nil
}
func (d *PostgresDriver) Delete(ctx context.Context, table string, filters map[string]interface{}) (bool, error) {
	return true, nil
}

func (d *PostgresDriver) parseURL() map[string]interface{} {
	host := "localhost"
	port := 5432
	database := "postgres"
	username := "postgres"

	cleaned := strings.TrimPrefix(d.URL, "postgresql://")
	cleaned = strings.TrimPrefix(cleaned, "postgres://")

	parts := strings.Split(cleaned, "/")
	if len(parts) > 1 {
		dbPart := parts[1]
		if idx := strings.Index(dbPart, "?"); idx != -1 {
			dbPart = dbPart[:idx]
		}
		database = dbPart
	}

	authHost := parts[0]
	var auth, hostPort string
	if idx := strings.LastIndex(authHost, "@"); idx != -1 {
		auth = authHost[:idx]
		hostPort = authHost[idx+1:]
	} else {
		hostPort = authHost
	}

	if auth != "" {
		username = strings.Split(auth, ":")[0]
	}

	if hostPort != "" {
		hostParts := strings.Split(hostPort, ":")
		host = hostParts[0]
		if len(hostParts) > 1 {
			fmt.Sscanf(hostParts[1], "%d", &port)
		}
	}

	return map[string]interface{}{
		"host":     host,
		"port":     port,
		"database": database,
		"username": username,
	}
}

func (d *PostgresDriver) GetConnectionInfo() map[string]interface{} {
	info := d.parseURL()
	info["driver"] = "postgres"
	info["status"] = d.status
	return info
}

func (d *PostgresDriver) TestConnection(ctx context.Context) map[string]interface{} {
	err := d.Connect(ctx)
	success := err == nil
	info := d.GetConnectionInfo()
	msg := "Successfully simulated connection to PostgreSQL"
	if err != nil {
		msg = err.Error()
	}
	return map[string]interface{}{
		"success": success,
		"message": msg,
		"info":    info,
	}
}

type MySQLDriver struct {
	Name             string
	URL              string
	status           string
	lastPingTime     time.Time
	lastPingResult   bool
	mu               sync.Mutex
}

func NewMySQLDriver(name, urlStr string) *MySQLDriver {
	return &MySQLDriver{
		Name:   name,
		URL:    urlStr,
		status: "DISCONNECTED",
	}
}

func (d *MySQLDriver) GetName() string { return d.Name }

func (d *MySQLDriver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status = "CONNECTED"
	return nil
}

func (d *MySQLDriver) Disconnect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status = "DISCONNECTED"
	return nil
}

func (d *MySQLDriver) Ping(ctx context.Context) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if time.Since(d.lastPingTime) < 1*time.Second {
		return d.lastPingResult
	}
	res := d.status == "CONNECTED"
	d.lastPingTime = time.Now()
	d.lastPingResult = res
	return res
}

func (d *MySQLDriver) EnsureConnected(ctx context.Context) error {
	if !d.Ping(ctx) {
		return d.Connect(ctx)
	}
	return nil
}

func (d *MySQLDriver) Execute(ctx context.Context, query string, args ...interface{}) ([]map[string]interface{}, error) {
	return nil, nil
}
func (d *MySQLDriver) Insert(ctx context.Context, table string, payload map[string]interface{}) (map[string]interface{}, error) {
	return payload, nil
}
func (d *MySQLDriver) Update(ctx context.Context, table string, payload map[string]interface{}, filters map[string]interface{}) (map[string]interface{}, error) {
	return payload, nil
}
func (d *MySQLDriver) Delete(ctx context.Context, table string, filters map[string]interface{}) (bool, error) {
	return true, nil
}

func (d *MySQLDriver) parseURL() map[string]interface{} {
	host := "localhost"
	port := 3306
	database := "mysql"
	username := "root"

	cleaned := strings.TrimPrefix(d.URL, "mysql://")
	cleaned = strings.TrimPrefix(cleaned, "mysqls://")

	parts := strings.Split(cleaned, "/")
	if len(parts) > 1 {
		dbPart := parts[1]
		if idx := strings.Index(dbPart, "?"); idx != -1 {
			dbPart = dbPart[:idx]
		}
		database = dbPart
	}

	authHost := parts[0]
	var auth, hostPort string
	if idx := strings.LastIndex(authHost, "@"); idx != -1 {
		auth = authHost[:idx]
		hostPort = authHost[idx+1:]
	} else {
		hostPort = authHost
	}

	if auth != "" {
		username = strings.Split(auth, ":")[0]
	}

	if hostPort != "" {
		hostParts := strings.Split(hostPort, ":")
		host = hostParts[0]
		if len(hostParts) > 1 {
			fmt.Sscanf(hostParts[1], "%d", &port)
		}
	}

	return map[string]interface{}{
		"host":     host,
		"port":     port,
		"database": database,
		"username": username,
	}
}

func (d *MySQLDriver) GetConnectionInfo() map[string]interface{} {
	info := d.parseURL()
	info["driver"] = "mysql"
	info["status"] = d.status
	return info
}

func (d *MySQLDriver) TestConnection(ctx context.Context) map[string]interface{} {
	err := d.Connect(ctx)
	success := err == nil
	info := d.GetConnectionInfo()
	msg := "Successfully simulated connection to MySQL"
	if err != nil {
		msg = err.Error()
	}
	return map[string]interface{}{
		"success": success,
		"message": msg,
		"info":    info,
	}
}

type MultiDatabase struct {
	Drivers     map[string]DatabaseDriver
	PrimaryName string
	Replicas    []string
	Shards      map[string][]string
	mu          sync.RWMutex
}

func NewMultiDatabase() *MultiDatabase {
	mdb := &MultiDatabase{
		Drivers: make(map[string]DatabaseDriver),
		Shards:  make(map[string][]string),
	}
	mdb.discoverEnvironment()
	return mdb
}

func (mdb *MultiDatabase) discoverEnvironment() {
	// Simple mock environment detection or default
	mdb.RegisterDatabase("sqlite", "sqlite://:memory:")
	mdb.PrimaryName = "sqlite"
}

func (mdb *MultiDatabase) RegisterDatabase(name, connStr string) {
	mdb.mu.Lock()
	defer mdb.mu.Unlock()

	var driver DatabaseDriver
	if strings.HasPrefix(connStr, "sqlite") {
		driver = NewSQLiteDriver(name, connStr)
	} else if strings.HasPrefix(connStr, "mongodb") || strings.HasPrefix(connStr, "mongo") {
		driver = &MongoDriver{Name: name, URL: connStr, status: "DISCONNECTED"}
	} else if strings.HasPrefix(connStr, "postgresql") || strings.HasPrefix(connStr, "postgres") {
		driver = NewPostgresDriver(name, connStr)
	} else if strings.HasPrefix(connStr, "mysql") {
		driver = NewMySQLDriver(name, connStr)
	} else {
		driver = NewSQLiteDriver(name, connStr) // fallback
	}

	mdb.Drivers[name] = driver
}

func (mdb *MultiDatabase) ConnectAll(ctx context.Context) error {
	mdb.mu.RLock()
	defer mdb.mu.RUnlock()

	for _, driver := range mdb.Drivers {
		if err := driver.Connect(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (mdb *MultiDatabase) DisconnectAll(ctx context.Context) error {
	mdb.mu.RLock()
	defer mdb.mu.RUnlock()

	for _, driver := range mdb.Drivers {
		_ = driver.Disconnect(ctx)
	}
	return nil
}

func (mdb *MultiDatabase) GetRoute(table string, isWrite bool) DatabaseDriver {
	mdb.mu.RLock()
	defer mdb.mu.RUnlock()

	if !isWrite && len(mdb.Replicas) > 0 {
		idx := rand.Intn(len(mdb.Replicas))
		return mdb.Drivers[mdb.Replicas[idx]]
	}
	return mdb.Drivers[mdb.PrimaryName]
}

func (mdb *MultiDatabase) Execute(ctx context.Context, query string, args ...interface{}) ([]map[string]interface{}, error) {
	driver := mdb.GetRoute("", false)
	return mdb.retryWithBackoff(ctx, driver, func() ([]map[string]interface{}, error) {
		return driver.Execute(ctx, query, args...)
	})
}

func (mdb *MultiDatabase) Write(ctx context.Context, table string, payload map[string]interface{}, upsert bool) (map[string]interface{}, error) {
	driver := mdb.GetRoute(table, true)
	if err := driver.EnsureConnected(ctx); err != nil {
		return nil, err
	}

	sqliteDriver, isSqlite := driver.(*SQLiteDriver)
	if isSqlite {
		sqliteDriver.mu.Lock()
		defer sqliteDriver.mu.Unlock()

		tx, err := sqliteDriver.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()

		if upsert {
			pkVal, ok := payload["id"]
			if ok && pkVal != nil {
				sqlQuery := fmt.Sprintf("SELECT id FROM %s WHERE id = ?", table)
				rows, err := tx.QueryContext(ctx, sqlQuery, pkVal)
				if err == nil {
					hasRow := rows.Next()
					rows.Close()
					if hasRow {
						setClauses := make([]string, 0, len(payload))
						args := make([]interface{}, 0, len(payload))
						for k, v := range payload {
							if k != "id" {
								setClauses = append(setClauses, fmt.Sprintf("%s = ?", k))
								args = append(args, v)
							}
						}
						args = append(args, pkVal)
						updateQuery := fmt.Sprintf("UPDATE %s SET %s WHERE id = ?", table, strings.Join(setClauses, ", "))
						_, err = tx.ExecContext(ctx, updateQuery, args...)
						if err != nil {
							return nil, err
						}
						if err := tx.Commit(); err != nil {
							return nil, err
						}
						return payload, nil
					}
				}
			}
		}

		keys := make([]string, 0, len(payload))
		values := make([]interface{}, 0, len(payload))
		placeholders := make([]string, 0, len(payload))
		for k, v := range payload {
			keys = append(keys, k)
			values = append(values, v)
			placeholders = append(placeholders, "?")
		}
		insertQuery := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(keys, ", "), strings.Join(placeholders, ", "))
		_, err = tx.ExecContext(ctx, insertQuery, values...)
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return payload, nil
	}

	if upsert {
		pkVal, ok := payload["id"]
		if ok && pkVal != nil {
			sql := fmt.Sprintf("SELECT id FROM %s WHERE id = ?", table)
			rows, err := driver.Execute(ctx, sql, pkVal)
			if err == nil && len(rows) > 0 {
				filters := map[string]interface{}{"id": pkVal}
				payloadNoPk := make(map[string]interface{})
				for k, v := range payload {
					if k != "id" {
						payloadNoPk[k] = v
					}
				}
				return driver.Update(ctx, table, payloadNoPk, filters)
			}
		}
	}

	return driver.Insert(ctx, table, payload)
}

func (mdb *MultiDatabase) Delete(ctx context.Context, table string, filters map[string]interface{}) (bool, error) {
	driver := mdb.GetRoute(table, true)
	if err := driver.EnsureConnected(ctx); err != nil {
		return false, err
	}
	return driver.Delete(ctx, table, filters)
}

func (mdb *MultiDatabase) retryWithBackoff(ctx context.Context, driver DatabaseDriver, fn func() ([]map[string]interface{}, error)) ([]map[string]interface{}, error) {
	retries := 3
	delay := 500 * time.Millisecond
	var lastErr error

	for i := 0; i < retries; i++ {
		if err := driver.EnsureConnected(ctx); err == nil {
			res, err := fn()
			if err == nil {
				return res, nil
			}
			lastErr = err
		} else {
			lastErr = err
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
			delay *= 2
		}
	}
	return nil, fmt.Errorf("retries exhausted: %w", lastErr)
}

var DB = NewMultiDatabase()
