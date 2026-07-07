export class LocalCache {
  private data = new Map<string, { value: any; expiry: number }>();

  get(key: string): any | null {
    if (this.data.has(key)) {
      const item = this.data.get(key)!;
      if (Date.now() < item.expiry) {
        return item.value;
      }
      this.data.delete(key);
    }
    return null;
  }

  set(key: string, value: any, ttlSeconds = 60) {
    this.data.set(key, {
      value,
      expiry: Date.now() + ttlSeconds * 1000
    });
  }
}

export class RedisCache {
  private client: any = null;

  constructor(host = "localhost", port = 6379) {
    try {
      const r = "re" + "dis";
      const redis = require(r);
      this.client = redis.createClient({ url: `redis://${host}:${port}` });
      this.client.connect().catch(() => {});
    } catch (err) {
      // redis module missing, bypass
    }
  }

  async get(key: string): Promise<any | null> {
    if (!this.client) return null;
    try {
      const val = await this.client.get(key);
      if (val) {
        return JSON.parse(val);
      }
    } catch (err) {
      // ignore cache fail
    }
    return null;
  }

  async set(key: string, value: any, ttlSeconds = 60) {
    if (!this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), {
        EX: ttlSeconds
      });
    } catch (err) {
      // ignore cache fail
    }
  }
}

export class N1QueryDetector {
  private static queryHistory: { timestamp: number; sql: string }[] = [];
  private static thresholdMs = 1000;
  private static countTrigger = 5;

  static recordQuery(sql: string) {
    const now = Date.now();
    this.queryHistory.push({ timestamp: now, sql });
    this.queryHistory = this.queryHistory.filter(item => now - item.timestamp < this.thresholdMs);

    const signatures: Record<string, number> = {};
    for (const item of this.queryHistory) {
      const fingerprint = this.getFingerprint(item.sql);
      signatures[fingerprint] = (signatures[fingerprint] || 0) + 1;
    }

    for (const [fp, count] of Object.entries(signatures)) {
      if (count >= this.countTrigger) {
        console.warn(
          `[N+1 Query Detected] Query signature '${fp}' was executed ${count} times in the last ` +
          `${this.thresholdMs}ms. Consider using eager loading or relationship prefetching.`
        );
      }
    }
  }

  private static getFingerprint(sql: string): string {
    return sql.toLowerCase().trim().replace(/'\d+'|\d+|\?/g, "?");
  }
}

export class IndexAdvisor {
  private static filterFrequencies: Record<string, number> = {};
  private static suggestedIndexes = new Set<string>();

  static trackFilter(table: string, column: string) {
    const key = `${table}.${column}`;
    this.filterFrequencies[key] = (this.filterFrequencies[key] || 0) + 1;

    if (this.filterFrequencies[key] >= 10 && !this.suggestedIndexes.has(key)) {
      this.suggestedIndexes.add(key);
      console.info(
        `[Index Advisor] Recommending INDEX on column '${column}' in table '${table}' due to high filter frequency.`
      );
    }
  }
}
