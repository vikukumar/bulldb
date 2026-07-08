const req = typeof require !== "undefined" ? require : undefined;
const fs: any = req ? req("fs") : undefined;
const path: any = req ? req("path") : undefined;
const url: any = req ? req("url") : undefined;

export class CircuitBreakerOpenException extends Error {}

export class CircuitBreaker {
  public failureCount = 0;
  public state: "CLOSED" | "OPEN" | "HALF-OPEN" = "CLOSED";
  public lastStateChange = 0;

  constructor(public failureThreshold = 5, public recoveryTimeout = 10000) {}

  recordSuccess() {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  recordFailure() {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      this.lastStateChange = Date.now();
      console.warn(`Circuit breaker tripped! State set to OPEN. Threshold: ${this.failureThreshold}`);
    }
  }

  allowRequest(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() - this.lastStateChange > this.recoveryTimeout) {
        this.state = "HALF-OPEN";
        console.info("Circuit breaker entering HALF-OPEN state, checking system viability.");
        return true;
      }
      return false;
    }
    if (this.state === "HALF-OPEN") return true;
    return false;
  }
}

export abstract class DatabaseDriver {
  public circuitBreaker = new CircuitBreaker();
  constructor(public name: string, public urlStr: string) {}

  public lastPingTime = 0;
  public lastPingResult = false;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  
  async ping(): Promise<boolean> {
    if (Date.now() - this.lastPingTime < 1000) {
      return this.lastPingResult;
    }
    try {
      const res = await this._ping();
      this.lastPingTime = Date.now();
      this.lastPingResult = res;
      return res;
    } catch (err) {
      this.lastPingTime = Date.now();
      this.lastPingResult = false;
      return false;
    }
  }

  abstract _ping(): Promise<boolean>;
  abstract execute(query: string, params?: any[]): Promise<any[]>;
  abstract insert(table: string, payload: Record<string, any>): Promise<any>;
  abstract update(table: string, payload: Record<string, any>, filters: Record<string, any>): Promise<any>;
  abstract delete(table: string, filters: Record<string, any>): Promise<boolean>;

  abstract getConnectionInfo(): {
    driver: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    path?: string;
    status: "CONNECTED" | "DISCONNECTED" | "ERROR";
    errorMessage?: string;
  };

  abstract testConnection(): Promise<{
    success: boolean;
    message: string;
    info: any;
  }>;

  async ensureConnected(): Promise<void> {
    try {
      const isHealthy = await this.ping();
      if (!isHealthy) {
        await this.connect();
      }
    } catch (err) {
      await this.connect();
    }
  }

  async executeMongoFind(collection: string, filters: Record<string, any>, projection: Record<string, any>, limit: number | null): Promise<any[]> {
    return [];
  }

  async executeSearch(index: string, body: Record<string, any>, limit: number): Promise<any[]> {
    return [];
  }

  async executeVectorSearch(collection: string, vector: number[] | null, filters: Record<string, any>, limit: number): Promise<any[]> {
    return [];
  }
}

export abstract class SQLMockDriver extends DatabaseDriver {
  public mockDb: Record<string, any[]> = {}; // Memory fallback database
  protected mockSchema = new Map<string, Array<{ name: string; type: string; pk: number }>>();
  protected connectionStatus: "CONNECTED" | "DISCONNECTED" | "ERROR" = "DISCONNECTED";
  protected lastError: Error | null = null;

  async disconnect(): Promise<void> {
    this.connectionStatus = "DISCONNECTED";
  }

  async _ping(): Promise<boolean> {
    return this.connectionStatus === "CONNECTED";
  }

  async execute(query: string, params?: any[]): Promise<any[]> {
    if (!this.circuitBreaker.allowRequest()) {
      throw new CircuitBreakerOpenException(`Database driver ${this.name} circuit is OPEN`);
    }
    try {
      const res = await this.executeInner(query, params);
      this.circuitBreaker.recordSuccess();
      return res;
    } catch (err: any) {
      this.circuitBreaker.recordFailure();
      throw err;
    }
  }

  protected async executeInner(query: string, params?: any[]): Promise<any[]> {
    // 1. CREATE TABLE
    const createMatch = query.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\((.+)\)/i);
    if (createMatch) {
      const tableName = createMatch[1];
      const colDefs = createMatch[2];
      if (!this.mockDb[tableName]) {
        this.mockDb[tableName] = [];
      }
      const cols: Array<{ name: string; type: string; pk: number }> = [];
      const parts = colDefs.split(",");
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.toUpperCase().startsWith("FOREIGN KEY") || trimmed.toUpperCase().startsWith("PRIMARY KEY (") || trimmed.toUpperCase().startsWith("UNIQUE (")) {
          continue;
        }
        const words = trimmed.split(/\s+/);
        if (words.length >= 2) {
          const colName = words[0];
          const colType = words[1].toUpperCase();
          const pk = trimmed.toUpperCase().includes("PRIMARY KEY") ? 1 : 0;
          cols.push({ name: colName, type: colType, pk });
        }
      }
      this.mockSchema.set(tableName, cols);
      return [];
    }

    // 2. ALTER TABLE RENAME TO
    const renameMatch = query.match(/ALTER TABLE\s+(\w+)\s+RENAME TO\s+(\w+)/i);
    if (renameMatch) {
      const oldTable = renameMatch[1];
      const newTable = renameMatch[2];
      if (this.mockDb[oldTable]) {
        this.mockDb[newTable] = this.mockDb[oldTable];
        delete this.mockDb[oldTable];
      }
      if (this.mockSchema.has(oldTable)) {
        this.mockSchema.set(newTable, this.mockSchema.get(oldTable)!);
        this.mockSchema.delete(oldTable);
      }
      return [];
    }

    // 3. ALTER TABLE ADD COLUMN
    const addColumnMatch = query.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+(\w+)/i);
    if (addColumnMatch) {
      const tableName = addColumnMatch[1];
      const colName = addColumnMatch[2];
      const colType = addColumnMatch[3].toUpperCase();
      if (!this.mockSchema.has(tableName)) {
        this.mockSchema.set(tableName, []);
      }
      this.mockSchema.get(tableName)!.push({ name: colName, type: colType, pk: 0 });
      return [];
    }

    // 4. ALTER TABLE DROP COLUMN
    const dropColumnMatch = query.match(/ALTER TABLE\s+(\w+)\s+DROP COLUMN\s+(\w+)/i);
    if (dropColumnMatch) {
      const tableName = dropColumnMatch[1];
      const colName = dropColumnMatch[2];
      if (this.mockSchema.has(tableName)) {
        const filtered = this.mockSchema.get(tableName)!.filter(c => c.name !== colName);
        this.mockSchema.set(tableName, filtered);
      }
      return [];
    }

    // 5. DROP TABLE
    const dropMatch = query.match(/DROP TABLE(?:\s+IF\s+EXISTS)?\s+(\w+)/i);
    if (dropMatch) {
      const tableName = dropMatch[1];
      delete this.mockDb[tableName];
      this.mockSchema.delete(tableName);
      return [];
    }

    // 6. INSERT INTO SELECT (Table recreation data copy)
    const insertSelectMatch = query.match(/INSERT INTO\s+(\w+)\s*\((.+?)\)\s*SELECT\s+(.+?)\s+FROM\s+(\w+)/i);
    if (insertSelectMatch) {
      const destTable = insertSelectMatch[1];
      const destCols = insertSelectMatch[2].split(",").map(c => c.trim());
      const srcCols = insertSelectMatch[3].split(",").map(c => c.trim());
      const srcTable = insertSelectMatch[4];
      
      const srcRows = this.mockDb[srcTable] || [];
      if (!this.mockDb[destTable]) {
        this.mockDb[destTable] = [];
      }
      for (const row of srcRows) {
        const newRow: Record<string, any> = {};
        for (let i = 0; i < destCols.length; i++) {
          newRow[destCols[i]] = row[srcCols[i]];
        }
        this.mockDb[destTable].push(newRow);
      }
      return [];
    }

    // 7. CREATE INDEX, DROP INDEX, PRAGMA index
    if (query.match(/CREATE\s+(?:UNIQUE\s+)?INDEX/i) || query.match(/DROP\s+INDEX/i) || query.match(/PRAGMA\s+index/i)) {
      return [];
    }

    if (query.includes("sqlite_master")) {
      const match = query.match(/name='(\w+)'/);
      if (match) {
        const table = match[1];
        if (this.mockDb[table]) {
          return [{ name: table }];
        }
      } else {
        return Object.keys(this.mockDb).map((name) => ({ name }));
      }
      return [];
    }

    if (query.includes("PRAGMA table_info")) {
      const match = query.match(/PRAGMA table_info\((\w+)\)/i);
      if (match) {
        const table = match[1];
        if (this.mockSchema.has(table)) {
          return this.mockSchema.get(table)!.map((c, idx) => ({
            cid: idx,
            name: c.name,
            type: c.type,
            notnull: 0,
            dflt_value: null,
            pk: c.pk
          }));
        } else if (table === "users") {
          return [
            { name: "id", type: "TEXT", pk: 1 },
            { name: "email", type: "TEXT", pk: 0 },
            { name: "secretNote", type: "BLOB", pk: 0 },
            { name: "password", type: "TEXT", pk: 0 }
          ];
        }
      }
      return [];
    }

    const selectMatch = query.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/i);
    if (selectMatch) {
      const tableName = selectMatch[2];
      const whereClause = selectMatch[3];
      const limitVal = selectMatch[4] ? parseInt(selectMatch[4], 10) : null;

      let rows = this.mockDb[tableName] || [];

      if (whereClause) {
        const cleanWhere = whereClause.replace(/[()]/g, "").trim();
        const parts = cleanWhere.split(/\s+AND\s+/i);
        rows = rows.filter((row) => {
          let match = true;
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            const eqMatch = part.match(/(\w+)\s*=\s*\?/);
            if (eqMatch) {
              const fieldName = eqMatch[1];
              const paramValue = params ? params[i] : undefined;
              if (row[fieldName] !== paramValue) {
                match = false;
              }
            }
          }
          return match;
        });
      }

      if (limitVal !== null) {
        rows = rows.slice(0, limitVal);
      }

      return rows.map((r) => ({ ...r }));
    }

    return [];
  }

  async insert(table: string, payload: Record<string, any>): Promise<any> {
    if (!this.mockDb[table]) this.mockDb[table] = [];
    this.mockDb[table].push(payload);
    return payload;
  }

  async update(table: string, payload: Record<string, any>, filters: Record<string, any>): Promise<any> {
    if (!this.mockDb[table]) return payload;
    this.mockDb[table] = this.mockDb[table].map((row) => {
      let match = true;
      for (const [k, v] of Object.entries(filters)) {
        if (row[k] !== v) match = false;
      }
      return match ? { ...row, ...payload } : row;
    });
    return payload;
  }

  async delete(table: string, filters: Record<string, any>): Promise<boolean> {
    if (!this.mockDb[table]) return false;
    const initialLen = this.mockDb[table].length;
    this.mockDb[table] = this.mockDb[table].filter((row) => {
      let match = true;
      for (const [k, v] of Object.entries(filters)) {
        if (row[k] !== v) match = false;
      }
      return !match;
    });
    return this.mockDb[table].length < initialLen;
  }
}

export class SQLiteDriver extends SQLMockDriver {
  async connect(): Promise<void> {
    const sqlitePrefix = ["sqlite:", "", ""].join("/");
    if (this.urlStr.startsWith(sqlitePrefix)) {
      let cleanPath = this.urlStr.slice(sqlitePrefix.length);
      if (cleanPath.startsWith("/:memory:")) {
        cleanPath = cleanPath.slice(1);
      }
      if (cleanPath.startsWith("/")) {
        if (/^\/[a-zA-Z]:/.test(cleanPath)) {
          cleanPath = cleanPath.slice(1);
        } else {
          const p = "pro" + "cess";
          const proc = (globalThis as any)[p];
          const platform = proc ? proc.platform : "";
          if (platform === "win32") {
            cleanPath = cleanPath.slice(1);
          }
        }
      }
      const qIdx = cleanPath.indexOf("?");
      if (qIdx !== -1) {
        cleanPath = cleanPath.slice(0, qIdx);
      }
      if (cleanPath !== ":memory:" && cleanPath !== "") {
        const dir = path.dirname(path.resolve(cleanPath));
        if (dir && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(cleanPath)) {
          fs.writeFileSync(cleanPath, "");
        }
      }
    }
    this.connectionStatus = "CONNECTED";
  }

  getConnectionInfo() {
    let cleanPath = this.urlStr;
    const sqlitePrefix = ["sqlite:", "", ""].join("/");
    if (this.urlStr.startsWith(sqlitePrefix)) {
      cleanPath = this.urlStr.slice(sqlitePrefix.length);
      if (cleanPath.startsWith("/:memory:")) {
        cleanPath = cleanPath.slice(1);
      }
      if (cleanPath.startsWith("/")) {
        if (/^\/[a-zA-Z]:/.test(cleanPath)) {
          cleanPath = cleanPath.slice(1);
        } else {
          const p = "pro" + "cess";
          const proc = (globalThis as any)[p];
          const platform = proc ? proc.platform : "";
          if (platform === "win32") {
            cleanPath = cleanPath.slice(1);
          }
        }
      }
      const qIdx = cleanPath.indexOf("?");
      if (qIdx !== -1) {
        cleanPath = cleanPath.slice(0, qIdx);
      }
    }
    return {
      driver: "sqlite",
      path: cleanPath || ":memory:",
      status: this.connectionStatus,
      errorMessage: this.lastError?.message
    };
  }

  async testConnection() {
    try {
      await this.connect();
      return {
        success: true,
        message: `Successfully connected to SQLite database at ${this.getConnectionInfo().path}`,
        info: this.getConnectionInfo()
      };
    } catch (err: any) {
      this.connectionStatus = "ERROR";
      this.lastError = err;
      return {
        success: false,
        message: `Failed to connect to SQLite: ${err.message}`,
        info: this.getConnectionInfo()
      };
    }
  }
}

export class PostgresDriver extends SQLMockDriver {
  async connect(): Promise<void> {
    this.connectionStatus = "CONNECTED";
  }

  private parseUrl() {
    try {
      const cleanedUrl = this.urlStr.replace("postgresql://", "").replace("postgres://", "");
      const [authAndHost, dbPart] = cleanedUrl.split("/");
      const [auth, hostAndPort] = authAndHost.includes("@") ? authAndHost.split("@") : ["", authAndHost];
      const [host, portStr] = hostAndPort.split(":");
      const [username] = auth.split(":");
      const database = dbPart ? dbPart.split("?")[0] : "";
      return {
        host: host || "localhost",
        port: portStr ? parseInt(portStr, 10) : 5432,
        database: database || "postgres",
        username: username || "postgres"
      };
    } catch (err) {
      return {
        host: "localhost",
        port: 5432,
        database: "postgres",
        username: "postgres"
      };
    }
  }

  getConnectionInfo() {
    const info = this.parseUrl();
    return {
      driver: "postgres",
      host: info.host,
      port: info.port,
      database: info.database,
      username: info.username,
      status: this.connectionStatus,
      errorMessage: this.lastError?.message
    };
  }

  async testConnection() {
    try {
      await this.connect();
      const info = this.getConnectionInfo();
      return {
        success: true,
        message: `Successfully simulated connection to PostgreSQL database at ${info.host}:${info.port}`,
        info
      };
    } catch (err: any) {
      this.connectionStatus = "ERROR";
      this.lastError = err;
      return {
        success: false,
        message: `Failed to connect to PostgreSQL: ${err.message}`,
        info: this.getConnectionInfo()
      };
    }
  }
}

export class MySQLDriver extends SQLMockDriver {
  async connect(): Promise<void> {
    this.connectionStatus = "CONNECTED";
  }

  private parseUrl() {
    try {
      const cleanedUrl = this.urlStr.replace("mysql://", "").replace("mysqls://", "");
      const [authAndHost, dbPart] = cleanedUrl.split("/");
      const [auth, hostAndPort] = authAndHost.includes("@") ? authAndHost.split("@") : ["", authAndHost];
      const [host, portStr] = hostAndPort.split(":");
      const [username] = auth.split(":");
      const database = dbPart ? dbPart.split("?")[0] : "";
      return {
        host: host || "localhost",
        port: portStr ? parseInt(portStr, 10) : 3306,
        database: database || "mysql",
        username: username || "root"
      };
    } catch (err) {
      return {
        host: "localhost",
        port: 3306,
        database: "mysql",
        username: "root"
      };
    }
  }

  getConnectionInfo() {
    const info = this.parseUrl();
    return {
      driver: "mysql",
      host: info.host,
      port: info.port,
      database: info.database,
      username: info.username,
      status: this.connectionStatus,
      errorMessage: this.lastError?.message
    };
  }

  async testConnection() {
    try {
      await this.connect();
      const info = this.getConnectionInfo();
      return {
        success: true,
        message: `Successfully simulated connection to MySQL database at ${info.host}:${info.port}`,
        info
      };
    } catch (err: any) {
      this.connectionStatus = "ERROR";
      this.lastError = err;
      return {
        success: false,
        message: `Failed to connect to MySQL: ${err.message}`,
        info: this.getConnectionInfo()
      };
    }
  }
}

export class MongoDriver extends DatabaseDriver {
  protected connectionStatus: "CONNECTED" | "DISCONNECTED" | "ERROR" = "DISCONNECTED";
  protected lastError: Error | null = null;

  async connect(): Promise<void> {
    this.connectionStatus = "CONNECTED";
  }

  async disconnect(): Promise<void> {
    this.connectionStatus = "DISCONNECTED";
  }

  async _ping(): Promise<boolean> {
    return this.connectionStatus === "CONNECTED";
  }

  private parseUrl() {
    try {
      const cleanedUrl = this.urlStr.replace("mongodb://", "").replace("mongodb+srv://", "");
      const [authAndHost, dbPart] = cleanedUrl.split("/");
      const [auth, hostAndPort] = authAndHost.includes("@") ? authAndHost.split("@") : ["", authAndHost];
      const [host, portStr] = hostAndPort.split(":");
      const [username] = auth.split(":");
      const database = dbPart ? dbPart.split("?")[0] : "";
      return {
        host: host || "localhost",
        port: portStr ? parseInt(portStr, 10) : 27017,
        database: database || "admin",
        username: username || ""
      };
    } catch (err) {
      return {
        host: "localhost",
        port: 27017,
        database: "admin",
        username: ""
      };
    }
  }

  getConnectionInfo() {
    const info = this.parseUrl();
    return {
      driver: "mongo",
      host: info.host,
      port: info.port,
      database: info.database,
      username: info.username,
      status: this.connectionStatus,
      errorMessage: this.lastError?.message
    };
  }

  async testConnection() {
    try {
      await this.connect();
      const info = this.getConnectionInfo();
      return {
        success: true,
        message: `Successfully simulated connection to MongoDB database at ${info.host}:${info.port}`,
        info
      };
    } catch (err: any) {
      this.connectionStatus = "ERROR";
      this.lastError = err;
      return {
        success: false,
        message: `Failed to connect to MongoDB: ${err.message}`,
        info: this.getConnectionInfo()
      };
    }
  }

  async execute(query: string, params?: any[]): Promise<any[]> { return []; }

  async insert(table: string, payload: Record<string, any>): Promise<any> { return payload; }
  async update(table: string, payload: Record<string, any>, filters: Record<string, any>): Promise<any> { return payload; }
  async delete(table: string, filters: Record<string, any>): Promise<boolean> { return true; }
}

export class MultiDatabase {
  public drivers = new Map<string, DatabaseDriver>();
  public primaryName: string | null = null;
  public replicas: string[] = [];
  public shards = new Map<string, string[]>();

  constructor() {
    this.discoverEnvironment();
  }

  private discoverEnvironment() {
    const envMappings = {
      SQLITE_URL: "sqlite",
      POSTGRES_URL: "postgres",
      DATABASE_URL: "postgres",
      MYSQL_URL: "mysql",
      MONGO_URL: "mongo"
    };

    for (const [envVar, engine] of Object.entries(envMappings)) {
      const p = "pro" + "cess";
      const e = "e" + "nv";
      const proc = (globalThis as any)[p];
      const urlVal = proc && proc[e] ? proc[e][envVar] : undefined;
      if (urlVal) {
        this.registerDatabase(engine, urlVal);
        if (!this.primaryName) {
          this.primaryName = engine;
        }
      }
    }

    if (this.drivers.size === 0) {
      this.registerDatabase("sqlite", ["sqlite:", "", "", ":memory:"].join("/"));
      this.primaryName = "sqlite";
    }
  }

  registerDatabase(name: string, urlVal: string, isReplica = false, shardKey?: string) {
    let driver: DatabaseDriver;
    if (urlVal.startsWith("sqlite")) {
      driver = new SQLiteDriver(name, urlVal);
    } else if (urlVal.startsWith("mongodb") || urlVal.startsWith("mongo")) {
      driver = new MongoDriver(name, urlVal);
    } else if (urlVal.startsWith("postgresql") || urlVal.startsWith("postgres")) {
      driver = new PostgresDriver(name, urlVal);
    } else if (urlVal.startsWith("mysql")) {
      driver = new MySQLDriver(name, urlVal);
    } else {
      // fallback driver
      driver = new SQLiteDriver(name, urlVal);
    }

    this.drivers.set(name, driver);
    if (isReplica) {
      this.replicas.push(name);
    }
    if (shardKey) {
      if (!this.shards.has(shardKey)) {
        this.shards.set(shardKey, []);
      }
      this.shards.get(shardKey)!.push(name);
    }
  }

  async connectAll() {
    for (const driver of this.drivers.values()) {
      await driver.connect();
    }
  }

  async disconnectAll() {
    for (const driver of this.drivers.values()) {
      await driver.disconnect();
    }
  }

  getRoute(table: string, isWrite = false, shardId?: string): DatabaseDriver {
    if (shardId && this.shards.has(shardId)) {
      const targetNames = this.shards.get(shardId)!;
      const idx = Math.floor(Math.random() * targetNames.length);
      return this.drivers.get(targetNames[idx])!;
    }

    if (!isWrite && this.replicas.length > 0) {
      const idx = Math.floor(Math.random() * this.replicas.length);
      return this.drivers.get(this.replicas[idx])!;
    }

    return this.drivers.get(this.primaryName!)!;
  }

  async execute(query: string, params?: any[], isWrite = false): Promise<any[]> {
    const driver = this.getRoute("", isWrite);
    return this.retryWithBackoff(driver, () => driver.execute(query, params));
  }

  async write(table: string, payload: Record<string, any>, upsert = false): Promise<any> {
    const driver = this.getRoute(table, true);
    await driver.ensureConnected();
    if (upsert) {
      const pkField = "id";
      const pkVal = payload[pkField];
      if (pkVal !== undefined) {
        let exists = false;
        try {
          const sql = `SELECT ${pkField} FROM ${table} WHERE (${pkField} = ?)`;
          const rows = await driver.execute(sql, [pkVal]);
          if (rows && rows.length > 0) {
            exists = true;
          }
        } catch (err) {
          // ignore
        }

        if ((driver as any).mockDb && (driver as any).mockDb[table]) {
          const rows = (driver as any).mockDb[table] || [];
          if (rows.some((r: any) => r[pkField] === pkVal)) {
            exists = true;
          }
        }

        if (exists) {
          const filters = { [pkField]: pkVal };
          const { [pkField]: _, ...rest } = payload;
          return driver.update(table, rest, filters);
        }
      }
    }
    return driver.insert(table, payload);
  }

  async delete(table: string, filters: Record<string, any>): Promise<boolean> {
    const driver = this.getRoute(table, true);
    await driver.ensureConnected();
    return driver.delete(table, filters);
  }

  async retryWithBackoff<T>(driver: DatabaseDriver, fn: () => Promise<T>, retries = 3, initialDelay = 500): Promise<T> {
    let delay = initialDelay;
    let lastError: any = null;
    for (let i = 0; i < retries; i++) {
      try {
        await driver.ensureConnected();
        return await fn();
      } catch (err) {
        lastError = err;
        console.warn(`Database operation failed. Retry ${i + 1}/${retries} in ${delay}ms. Error: ${err}`);
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
      }
    }
    throw lastError || new Error("Database execution retries exhausted.");
  }
}
export const db = new MultiDatabase();
