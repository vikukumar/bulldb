import * as crypto from "crypto";
import { BinaryOpNode, ColumnNode, ValueNode } from "./query";

export class SecurityEngine {
  private static key: Buffer | null = null;
  private static activeContext: Record<string, any> = {};

  static setEncryptionKey(key: Buffer) {
    if (key.length >= 32) {
      this.key = key.subarray(0, 32);
    } else {
      this.key = Buffer.alloc(32);
      key.copy(this.key);
    }
  }

  static getEncryptionKey(): Buffer {
    if (!this.key) {
      const keyStr = process.env.BULLDB_ENCRYPTION_KEY;
      if (keyStr) {
        this.key = crypto.createHash("sha256").update(keyStr).digest();
      } else {
        this.key = crypto.randomBytes(32);
      }
    }
    return this.key;
  }

  static encryptField(plaintext: string): string {
    if (!plaintext) return plaintext;
    const key = this.getEncryptionKey();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    
    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");
    const tag = cipher.getAuthTag();

    // Combined packet: nonce (12b) + tag (16b) + ciphertext
    const combined = Buffer.concat([
      nonce,
      tag,
      Buffer.from(encrypted, "base64")
    ]);
    return combined.toString("base64");
  }

  static decryptField(ciphertext: string): string {
    if (!ciphertext) return ciphertext;
    try {
      const combined = Buffer.from(ciphertext, "base64");
      const nonce = combined.subarray(0, 12);
      const tag = combined.subarray(12, 28);
      const encryptedData = combined.subarray(28);

      const key = this.getEncryptionKey();
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);

      let decrypted = decipher.update(encryptedData.toString("base64"), "base64", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch (err) {
      return ciphertext; // Fallback
    }
  }

  static hashPassword(password: string): string {
    const salt = crypto.randomBytes(16);
    const iterations = 100000;
    const key = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
    
    const saltB64 = salt.toString("base64");
    const keyB64 = key.toString("base64");
    return `${iterations}$${saltB64}$${keyB64}`;
  }

  static verifyPassword(password: string, hashed: string): boolean {
    try {
      const parts = hashed.split("$");
      if (parts.length !== 3) return false;
      const iterations = parseInt(parts[0], 10);
      const salt = Buffer.from(parts[1], "base64");
      const storedKey = Buffer.from(parts[2], "base64");

      const computedKey = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
      return crypto.timingSafeEqual(computedKey, storedKey);
    } catch (err) {
      return false;
    }
  }

  static setSessionContext(tenantId?: string, userId?: string, roles: string[] = []) {
    this.activeContext = { tenantId, userId, roles };
  }

  static getSessionContext(): Record<string, any> {
    return this.activeContext;
  }

  static clearSessionContext() {
    this.activeContext = {};
  }

  static injectRls(ast: any) {
    const context = this.getSessionContext();
    const tenantId = context.tenantId;
    if (tenantId) {
      const rlsFilter = new BinaryOpNode(new ColumnNode("tenant_id"), "=", new ValueNode(tenantId));
      if (ast.filters) {
        ast.filters = new BinaryOpNode(ast.filters, "AND", rlsFilter);
      } else {
        ast.filters = rlsFilter;
      }
    }
  }
}
