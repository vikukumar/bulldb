package bulldb

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

type MigrationEngine struct {
	db               *MultiDatabase
	registeredModels []interface{}
}

func NewMigrationEngine() *MigrationEngine {
	return &MigrationEngine{
		db: DB,
	}
}

func (me *MigrationEngine) RegisterModel(model interface{}) {
	me.registeredModels = append(me.registeredModels, model)
}

func (me *MigrationEngine) normalizeType(t string) string {
	t = strings.ToUpper(t)
	if strings.Contains(t, "INT") || strings.Contains(t, "SERIAL") {
		return "INTEGER"
	}
	if strings.Contains(t, "CHAR") || strings.Contains(t, "TEXT") || strings.Contains(t, "UUID") || strings.Contains(t, "EMAIL") || strings.Contains(t, "PHONE") || strings.Contains(t, "URL") || strings.Contains(t, "IPADDRESS") {
		return "TEXT"
	}
	if strings.Contains(t, "REAL") || strings.Contains(t, "FLOAT") || strings.Contains(t, "DOUBLE") || strings.Contains(t, "NUMERIC") || strings.Contains(t, "DECIMAL") {
		return "REAL"
	}
	if strings.Contains(t, "BLOB") || strings.Contains(t, "BYTEA") || strings.Contains(t, "BINARY") {
		return "BLOB"
	}
	return "TEXT"
}

func (me *MigrationEngine) mapGoTypeToSqlite(t string) string {
	switch t {
	case "int", "int64", "int32", "bool":
		return "INTEGER"
	case "float64", "float32":
		return "REAL"
	case "string":
		return "TEXT"
	default:
		return "TEXT"
	}
}

func (me *MigrationEngine) recreateTableSqlite(ctx context.Context, tableName string, meta *ModelMetadata) error {
	driver := me.db.GetRoute(tableName, true)
	_, _ = driver.Execute(ctx, "PRAGMA foreign_keys = OFF")

	defer func() {
		_, _ = driver.Execute(ctx, "PRAGMA foreign_keys = ON")
	}()

	// 1. Get current columns
	pragmaRows, err := driver.Execute(ctx, fmt.Sprintf("PRAGMA table_info(%s)", tableName))
	if err != nil {
		return err
	}

	dbCols := make(map[string]bool)
	for _, r := range pragmaRows {
		if name, ok := r["name"].(string); ok {
			dbCols[name] = true
		}
	}

	// 2. Find common columns
	var commonCols []string
	for _, f := range meta.Fields {
		if dbCols[f.Name] {
			commonCols = append(commonCols, f.Name)
		}
	}

	// 3. Rename old table
	tempName := fmt.Sprintf("%s_old_%d", tableName, time.Now().Unix())
	_, err = driver.Execute(ctx, fmt.Sprintf("ALTER TABLE %s RENAME TO %s", tableName, tempName))
	if err != nil {
		return err
	}

	// 4. Create new table
	var colDefs []string
	for _, f := range meta.Fields {
		sqlType := me.mapGoTypeToSqlite(f.Type)
		constraints := ""
		if f.PrimaryKey {
			constraints = "PRIMARY KEY"
		} else if f.Unique {
			constraints = "UNIQUE"
		}
		colDefs = append(colDefs, fmt.Sprintf("%s %s %s", f.Name, sqlType, constraints))
	}

	createSql := fmt.Sprintf("CREATE TABLE %s (%s)", tableName, strings.Join(colDefs, ", "))
	_, err = driver.Execute(ctx, createSql)
	if err != nil {
		return err
	}

	// 5. Copy data
	if len(commonCols) > 0 {
		colsStr := strings.Join(commonCols, ", ")
		copySql := fmt.Sprintf("INSERT INTO %s (%s) SELECT %s FROM %s", tableName, colsStr, colsStr, tempName)
		_, err = driver.Execute(ctx, copySql)
		if err != nil {
			return err
		}
	}

	// 6. Drop old table
	_, err = driver.Execute(ctx, fmt.Sprintf("DROP TABLE %s", tempName))
	return err
}

func (me *MigrationEngine) GenerateAndApplySchema(ctx context.Context) error {
	driverName := me.db.PrimaryName
	driver := me.db.GetRoute("", true)

	// Fetch database tables list
	var dbTables []string
	var rows []map[string]interface{}
	var err error

	if strings.Contains(driverName, "sqlite") {
		rows, err = driver.Execute(ctx, "SELECT name FROM sqlite_master WHERE type='table'")
	} else {
		rows, err = driver.Execute(ctx, "SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
	}

	if err == nil {
		for _, r := range rows {
			if name, ok := r["name"].(string); ok {
				dbTables = append(dbTables, name)
			} else if name, ok := r["table_name"].(string); ok {
				dbTables = append(dbTables, name)
			}
		}
	}

	// 1. Drop unused tables
	modelTables := make(map[string]bool)
	for _, m := range me.registeredModels {
		meta := RegisterModel(m)
		modelTables[meta.TableName] = true
	}

	for _, table := range dbTables {
		if !modelTables[table] && table != "bulldb_migrations" && !strings.HasPrefix(table, "sqlite_") && !strings.HasPrefix(table, "pg_") {
			log.Printf("Dropping unused table: %s", table)
			_, _ = driver.Execute(ctx, fmt.Sprintf("DROP TABLE IF EXISTS %s", table))
		}
	}

	// 2. Migrate current registered models
	for _, m := range me.registeredModels {
		meta := RegisterModel(m)
		tableName := meta.TableName

		tableExists := false
		for _, t := range dbTables {
			if t == tableName {
				tableExists = true
				break
			}
		}

		if !tableExists {
			// Create Table
			var colDefs []string
			for _, f := range meta.Fields {
				sqlType := me.mapGoTypeToSqlite(f.Type)
				constraints := ""
				if f.PrimaryKey {
					constraints = "PRIMARY KEY"
				} else if f.Unique {
					constraints = "UNIQUE"
				}
				colDefs = append(colDefs, fmt.Sprintf("%s %s %s", f.Name, sqlType, constraints))
			}

			createSql := fmt.Sprintf("CREATE TABLE %s (%s)", tableName, strings.Join(colDefs, ", "))
			_, err = driver.Execute(ctx, createSql)
			if err != nil {
				return err
			}
		} else {
			// Diff columns
			pragmaRows, err := driver.Execute(ctx, fmt.Sprintf("PRAGMA table_info(%s)", tableName))
			if err != nil {
				return err
			}

			existingColumns := make(map[string]map[string]interface{})
			for _, r := range pragmaRows {
				if colName, ok := r["name"].(string); ok {
					existingColumns[colName] = r
				}
			}

			needsRecreation := false
			// Check added or updated columns
			for _, f := range meta.Fields {
				dbCol, exists := existingColumns[f.Name]
				if !exists {
					if f.PrimaryKey || f.Unique {
						needsRecreation = true
					} else {
						// Add column directly
						alterSql := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", tableName, f.Name, me.mapGoTypeToSqlite(f.Type))
						_, err = driver.Execute(ctx, alterSql)
						if err != nil {
							needsRecreation = true
						}
					}
				} else {
					// Check type / pk mismatches
					dbType, _ := dbCol["type"].(string)
					dbPkVal, _ := dbCol["pk"].(int64)
					dbPk := dbPkVal == 1

					normalizedDb := me.normalizeType(dbType)
					normalizedModel := me.normalizeType(me.mapGoTypeToSqlite(f.Type))

					if normalizedDb != normalizedModel || f.PrimaryKey != dbPk {
						needsRecreation = true
					}
				}
			}

			// Check dropped columns
			for name := range existingColumns {
				found := false
				for _, f := range meta.Fields {
					if f.Name == name {
						found = true
						break
					}
				}
				if !found && name != "id" {
					needsRecreation = true
				}
			}

			if needsRecreation {
				err = me.recreateTableSqlite(ctx, tableName, meta)
				if err != nil {
					return err
				}
			}
		}

		// Indexes
		for _, f := range meta.Fields {
			idxName := fmt.Sprintf("%s_%s_idx", tableName, f.Name)
			if f.Index && !f.PrimaryKey {
				createIdxSql := fmt.Sprintf("CREATE INDEX IF NOT EXISTS %s ON %s (%s)", idxName, tableName, f.Name)
				_, _ = driver.Execute(ctx, createIdxSql)
			} else {
				// Drop index if exists but not indexed
				_, _ = driver.Execute(ctx, fmt.Sprintf("DROP INDEX IF EXISTS %s", idxName))
			}
		}
	}

	return nil
}
