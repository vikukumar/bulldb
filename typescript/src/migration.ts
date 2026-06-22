import { ModelMetadataRegistry } from "./models";
import { DataTypeMapper } from "./types";

export class MigrationEngine {
  private registeredModels: any[] = [];

  constructor(private db: any) {}

  registerModel(model: any) {
    if (!this.registeredModels.includes(model)) {
      this.registeredModels.push(model);
    }
  }

  discoverModels() {
    const models = ModelMetadataRegistry.getRegisteredModels();
    for (const m of models) {
      this.registerModel(m);
    }
  }

  sortModelsTopologically(): any[] {
    const resolved: any[] = [];
    const visited = new Set<string>();

    const dependencies = new Map<string, Set<string>>();
    const modelByName = new Map<string, any>();

    for (const m of this.registeredModels) {
      const name = m.name;
      modelByName.set(name, m);
      dependencies.set(name, new Set());

      const relationships = ModelMetadataRegistry.getRelationships(name);
      for (const rel of relationships.values()) {
        if (["ManyToOne", "OneToOne"].includes(rel.typeName)) {
          dependencies.get(name)!.add(rel.target);
        }
      }
    }

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (!modelByName.has(name)) return; // external or unmapped dependency fallback

      const deps = dependencies.get(name) || new Set();
      for (const dep of deps) {
        visit(dep);
      }

      visited.add(name);
      resolved.push(modelByName.get(name));
    };

    for (const m of this.registeredModels) {
      visit(m.name);
    }

    return resolved;
  }

  private normalizeType(t: string): string {
    const upper = t.toUpperCase();
    if (upper.includes("INT") || upper.includes("SERIAL")) return "INTEGER";
    if (upper.includes("CHAR") || upper.includes("TEXT") || upper.includes("UUID") || upper.includes("EMAIL") || upper.includes("PHONE") || upper.includes("URL") || upper.includes("IPADDRESS")) return "TEXT";
    if (upper.includes("REAL") || upper.includes("FLOAT") || upper.includes("DOUBLE") || upper.includes("NUMERIC") || upper.includes("DECIMAL")) return "REAL";
    if (upper.includes("BLOB") || upper.includes("BYTEA") || upper.includes("BINARY")) return "BLOB";
    return "TEXT";
  }

  private async recreateTableSqlite(tableName: string, model: any) {
    await this.db.execute("PRAGMA foreign_keys = OFF");
    try {
      // Get common columns
      const pragmaRows = await this.db.execute(`PRAGMA table_info(${tableName})`);
      const dbCols = new Set<string>(pragmaRows.map((r: any) => r.name));
      const fields = ModelMetadataRegistry.getFields(model.name);
      const commonCols = Array.from(dbCols).filter((c) => fields.has(c));

      // Rename current table
      const tempName = `${tableName}_old_${Math.floor(Date.now() / 1000)}`;
      await this.db.execute(`ALTER TABLE ${tableName} RENAME TO ${tempName}`);

      // Create new table with updated schema
      const columnsSql: string[] = [];
      for (const [colName, colMeta] of fields.entries()) {
        if (!colMeta.datatype) continue;
        const colType = DataTypeMapper.mapToSqlite(colMeta.datatype);
        const constraints: string[] = [];
        if (colMeta.primaryKey) {
          constraints.push("PRIMARY KEY");
        }
        if (colMeta.unique && !colMeta.primaryKey) {
          constraints.push("UNIQUE");
        }
        columnsSql.push(`${colName} ${colType} ${constraints.join(" ")}`);
      }

      // Foreign Key constraints
      const relationships = ModelMetadataRegistry.getRelationships(model.name);
      for (const rel of relationships.values()) {
        if (["ManyToOne", "OneToOne"].includes(rel.typeName)) {
          const targetTable = ModelMetadataRegistry.getTableName(rel.target);
          const fkCol = rel.options?.foreignKey || `${rel.name}Id`;
          if (fields.has(fkCol)) {
            columnsSql.push(`FOREIGN KEY (${fkCol}) REFERENCES ${targetTable} (id) ON DELETE CASCADE`);
          }
        }
      }

      const createSql = `CREATE TABLE ${tableName} (${columnsSql.join(", ")})`;
      await this.db.execute(createSql);

      // Copy data
      if (commonCols.length > 0) {
        const colsStr = commonCols.join(", ");
        await this.db.execute(`INSERT INTO ${tableName} (${colsStr}) SELECT ${colsStr} FROM ${tempName}`);
      }

      // Drop temporary old table
      await this.db.execute(`DROP TABLE ${tempName}`);
    } finally {
      await this.db.execute("PRAGMA foreign_keys = ON");
    }
  }

  async generateAndApplySchema() {
    // 0. Auto-discover registered models if none registered
    if (this.registeredModels.length === 0) {
      this.discoverModels();
    }

    // 1. Initialize migration log table
    await this.initMigrationTable();

    const driverName = this.db.primaryName || "sqlite";

    // 2. Fetch all tables from DB
    let dbTables: string[] = [];
    try {
      if (driverName.includes("sqlite")) {
        const rows = await this.db.execute("SELECT name FROM sqlite_master WHERE type='table'");
        dbTables = rows.map((r: any) => r.name);
      } else {
        const rows = await this.db.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
        dbTables = rows.map((r: any) => r.table_name);
      }
    } catch (err) {
      // ignore
    }

    // 3. Drop tables no longer present in models (excluding system tables and logs)
    const modelTables = new Set(this.registeredModels.map((m) => ModelMetadataRegistry.getTableName(m.name)));
    for (const table of dbTables) {
      if (!modelTables.has(table) && table !== "bulldb_migrations" && !table.startsWith("sqlite_") && !table.startsWith("pg_")) {
        console.info(`Dropping unused database table: ${table}`);
        try {
          await this.db.execute(`DROP TABLE IF EXISTS ${table}`);
        } catch (err) {
          // ignore
        }
      }
    }

    // 4. Sort and migrate models
    const sorted = this.sortModelsTopologically();

    for (const model of sorted) {
      const className = model.name;
      const tableName = ModelMetadataRegistry.getTableName(className);
      const fields = ModelMetadataRegistry.getFields(className);

      let existingColumns: Record<string, { type: string; pk: boolean; unique: boolean }> = {};
      const tableExists = dbTables.includes(tableName);

      if (tableExists) {
        try {
          if (driverName.includes("sqlite")) {
            const pragmaRows = await this.db.execute(`PRAGMA table_info(${tableName})`);
            for (const r of pragmaRows) {
              existingColumns[r.name] = {
                type: r.type.toUpperCase(),
                pk: r.pk === 1,
                unique: false
              };
            }
          } else {
            const colRows = await this.db.execute(
              `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name = '${tableName}'`
            );
            for (const r of colRows) {
              existingColumns[r.column_name] = {
                type: r.data_type.toUpperCase(),
                pk: false,
                unique: false
              };
            }
            // Parse primary keys
            const pkRows = await this.db.execute(
              `SELECT kcu.column_name 
               FROM information_schema.table_constraints tc 
               JOIN information_schema.key_column_usage kcu 
                 ON tc.constraint_name = kcu.constraint_name 
                 AND tc.table_schema = kcu.table_schema 
               WHERE tc.constraint_type = 'PRIMARY KEY' 
                 AND tc.table_name = '${tableName}'`
            );
            for (const r of pkRows) {
              if (existingColumns[r.column_name]) {
                existingColumns[r.column_name].pk = true;
              }
            }
          }
        } catch (err) {
          // ignore
        }
      }

      if (!tableExists) {
        // Create Table
        const columnsSql: string[] = [];
        for (const [colName, colMeta] of fields.entries()) {
          if (!colMeta.datatype) continue;
          const colType = driverName.includes("sqlite") ? DataTypeMapper.mapToSqlite(colMeta.datatype) : DataTypeMapper.mapToPostgresql(colMeta.datatype);
          const constraints: string[] = [];
          if (colMeta.primaryKey) {
            constraints.push("PRIMARY KEY");
          }
          if (colMeta.unique && !colMeta.primaryKey) {
            constraints.push("UNIQUE");
          }
          columnsSql.push(`${colName} ${colType} ${constraints.join(" ")}`);
        }

        const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (${columnsSql.join(", ")})`;
        await this.db.execute(sql);

        await this.db.execute(
          "INSERT INTO bulldb_migrations (migration_name, applied_at) VALUES (?, ?)",
          [`create_${tableName}`, Math.floor(Date.now() / 1000)]
        );
      } else {
        // Diff Columns!
        let needsSqliteRecreation = false;
        const postgresDdlOps: string[] = [];

        for (const [colName, colMeta] of fields.entries()) {
          if (!colMeta.datatype) continue;
          const colType = driverName.includes("sqlite") ? DataTypeMapper.mapToSqlite(colMeta.datatype) : DataTypeMapper.mapToPostgresql(colMeta.datatype);

          if (!(colName in existingColumns)) {
            // New column
            if (driverName.includes("sqlite")) {
              if (colMeta.primaryKey || colMeta.unique) {
                needsSqliteRecreation = true;
              } else {
                const alterSql = `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`;
                await this.db.execute(alterSql);
              }
            } else {
              postgresDdlOps.push(`ADD COLUMN ${colName} ${colType}`);
              if (colMeta.unique) {
                postgresDdlOps.push(`ADD CONSTRAINT ${tableName}_${colName}_key UNIQUE (${colName})`);
              }
            }
          } else {
            // Compare
            const dbCol = existingColumns[colName];
            const normalizedDb = this.normalizeType(dbCol.type);
            const normalizedModel = this.normalizeType(colType);

            const typeMismatch = normalizedDb !== normalizedModel;
            const pkMismatch = colMeta.primaryKey !== dbCol.pk;
            const uniqueMismatch = colMeta.unique !== dbCol.unique;

            if (typeMismatch || pkMismatch || uniqueMismatch) {
              if (driverName.includes("sqlite")) {
                needsSqliteRecreation = true;
              } else {
                if (typeMismatch) {
                  postgresDdlOps.push(`ALTER COLUMN ${colName} TYPE ${colType} USING ${colName}::${colType}`);
                }
                if (uniqueMismatch) {
                  if (colMeta.unique) {
                    postgresDdlOps.push(`ADD CONSTRAINT ${tableName}_${colName}_key UNIQUE (${colName})`);
                  } else {
                    postgresDdlOps.push(`DROP CONSTRAINT IF EXISTS ${tableName}_${colName}_key`);
                  }
                }
              }
            }
          }
        }

        // Dropped columns check
        for (const colName of Object.keys(existingColumns)) {
          if (!fields.has(colName) && !["id", "applied_at"].includes(colName)) {
            if (driverName.includes("sqlite")) {
              needsSqliteRecreation = true;
            } else {
              postgresDdlOps.push(`DROP COLUMN ${colName}`);
            }
          }
        }

        if (driverName.includes("sqlite") && needsSqliteRecreation) {
          await this.recreateTableSqlite(tableName, model);
        } else if (postgresDdlOps.length > 0) {
          const alterSql = `ALTER TABLE ${tableName} ${postgresDdlOps.join(", ")}`;
          await this.db.execute(alterSql);
        }
      }

      // Indexes Lifecycle
      let dbIndexes: string[] = [];
      try {
        if (driverName.includes("sqlite")) {
          // SQLite index list is handled or mocked empty
          const rows = await this.db.execute(`PRAGMA index_list(${tableName})`);
          dbIndexes = rows.map((r: any) => r.name);
        } else {
          const rows = await this.db.execute(`SELECT indexname FROM pg_indexes WHERE tablename = '${tableName}'`);
          dbIndexes = rows.map((r: any) => r.indexname);
        }
      } catch (err) {
        // ignore
      }

      // Create index
      for (const [colName, colMeta] of fields.entries()) {
        const idxName = `${tableName}_${colName}_idx`;
        if (colMeta.index && !colMeta.primaryKey) {
          if (!dbIndexes.includes(idxName)) {
            await this.db.execute(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${tableName} (${colName})`);
          }
        }
      }

      // Drop index
      for (const idx of dbIndexes) {
        if (idx.startsWith(`${tableName}_`) && idx.endsWith("_idx")) {
          const colName = idx.substring(tableName.length + 1, idx.length - 4);
          const colMeta = fields.get(colName);
          if (!colMeta || !colMeta.index) {
            await this.db.execute(`DROP INDEX IF EXISTS ${idx}`);
          }
        }
      }
    }
  }

  private async initMigrationTable() {
    const driverName = this.db.primaryName || "sqlite";
    const colType = driverName.includes("sqlite") ? "TEXT" : "VARCHAR(255)";
    
    let sql = `
      CREATE TABLE IF NOT EXISTS bulldb_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration_name ${colType} UNIQUE,
        applied_at INTEGER
      )
    `;

    if (driverName.includes("postgres")) {
      sql = `
        CREATE TABLE IF NOT EXISTS bulldb_migrations (
          id SERIAL PRIMARY KEY,
          migration_name VARCHAR(255) UNIQUE,
          applied_at INTEGER
        )
      `;
    }

    await this.db.execute(sql);
  }
}
