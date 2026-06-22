import "reflect-metadata";
import { UniversalType } from "./types";
import { QueryBuilder } from "./query";
import { SecurityEngine } from "./security";
import { AIEngine } from "./ai";

export interface FieldMetadata {
  name: string;
  primaryKey: boolean;
  unique: boolean;
  index: boolean;
  datatype?: UniversalType;
}

export interface RelationshipMetadata {
  name: string;
  typeName: "OneToOne" | "OneToMany" | "ManyToOne" | "ManyToMany";
  target: string;
  backPopulates?: string;
  options?: Record<string, any>;
}

export class ModelMetadataRegistry {
  private static fieldsRegistry = new Map<string, Map<string, FieldMetadata>>();
  private static relationshipsRegistry = new Map<string, Map<string, RelationshipMetadata>>();
  private static tableNamesRegistry = new Map<string, string>();
  private static modelsRegistry = new Set<any>();

  static registerModelClass(modelClass: any) {
    this.modelsRegistry.add(modelClass);
  }

  static getRegisteredModels(): any[] {
    return Array.from(this.modelsRegistry);
  }

  static getFields(className: string): Map<string, FieldMetadata> {
    if (!this.fieldsRegistry.has(className)) {
      this.fieldsRegistry.set(className, new Map());
    }
    return this.fieldsRegistry.get(className)!;
  }

  static getRelationships(className: string): Map<string, RelationshipMetadata> {
    if (!this.relationshipsRegistry.has(className)) {
      this.relationshipsRegistry.set(className, new Map());
    }
    return this.relationshipsRegistry.get(className)!;
  }

  static setTableName(className: string, tableName: string) {
    this.tableNamesRegistry.set(className, tableName);
  }

  static getTableName(className: string): string {
    return this.tableNamesRegistry.get(className) || `${className.toLowerCase()}s`;
  }
}

export function Model(tableName?: string) {
  return function (target: any) {
    ModelMetadataRegistry.registerModelClass(target);
    if (tableName) {
      ModelMetadataRegistry.setTableName(target.name, tableName);
    }
  };
}

export function PrimaryKey(options?: Record<string, any>) {
  return function (target: any, propertyKey: string) {
    const className = target.constructor.name;
    ModelMetadataRegistry.registerModelClass(target.constructor);
    const fields = ModelMetadataRegistry.getFields(className);
    const existing = fields.get(propertyKey) || { name: propertyKey, primaryKey: false, unique: false, index: false };
    existing.primaryKey = true;
    existing.unique = true;
    existing.index = true;
    
    // Resolve design:type reflection if available
    const type = Reflect.getMetadata("design:type", target, propertyKey);
    if (type && !existing.datatype) {
      existing.datatype = new UniversalType(type.name || "string");
    }
    fields.set(propertyKey, existing);
  };
}

export function Unique(options?: Record<string, any>) {
  return function (target: any, propertyKey: string) {
    const className = target.constructor.name;
    ModelMetadataRegistry.registerModelClass(target.constructor);
    const fields = ModelMetadataRegistry.getFields(className);
    const existing = fields.get(propertyKey) || { name: propertyKey, primaryKey: false, unique: false, index: false };
    existing.unique = true;
    existing.index = true;
    fields.set(propertyKey, existing);
  };
}

export function Index(options?: Record<string, any>) {
  return function (target: any, propertyKey: string) {
    const className = target.constructor.name;
    ModelMetadataRegistry.registerModelClass(target.constructor);
    const fields = ModelMetadataRegistry.getFields(className);
    const existing = fields.get(propertyKey) || { name: propertyKey, primaryKey: false, unique: false, index: false };
    existing.index = true;
    fields.set(propertyKey, existing);
  };
}

export function Field(datatype: UniversalType) {
  return function (target: any, propertyKey: string) {
    const className = target.constructor.name;
    ModelMetadataRegistry.registerModelClass(target.constructor);
    const fields = ModelMetadataRegistry.getFields(className);
    const existing = fields.get(propertyKey) || { name: propertyKey, primaryKey: false, unique: false, index: false };
    existing.datatype = datatype;
    fields.set(propertyKey, existing);
  };
}

export function OneToOne(targetModel: string, backPopulates?: string, options?: Record<string, any>) {
  return function (target: any, propertyKey: string) {
    const className = target.constructor.name;
    ModelMetadataRegistry.registerModelClass(target.constructor);
    const relationships = ModelMetadataRegistry.getRelationships(className);
    relationships.set(propertyKey, {
      name: propertyKey,
      typeName: "OneToOne",
      target: targetModel,
      backPopulates,
      options
    });
  };
}

export function OneToMany(targetModel: string, backPopulates?: string, options?: Record<string, any>) {
  return function (target: any, propertyKey: string) {
    const className = target.constructor.name;
    ModelMetadataRegistry.registerModelClass(target.constructor);
    const relationships = ModelMetadataRegistry.getRelationships(className);
    relationships.set(propertyKey, {
      name: propertyKey,
      typeName: "OneToMany",
      target: targetModel,
      backPopulates,
      options
    });
  };
}

export function ManyToOne(targetModel: string, backPopulates?: string, options?: Record<string, any>) {
  return function (target: any, propertyKey: string) {
    const className = target.constructor.name;
    ModelMetadataRegistry.registerModelClass(target.constructor);
    const relationships = ModelMetadataRegistry.getRelationships(className);
    relationships.set(propertyKey, {
      name: propertyKey,
      typeName: "ManyToOne",
      target: targetModel,
      backPopulates,
      options
    });
  };
}

export function ManyToMany(targetModel: string, backPopulates?: string, options?: Record<string, any>) {
  return function (target: any, propertyKey: string) {
    const className = target.constructor.name;
    ModelMetadataRegistry.registerModelClass(target.constructor);
    const relationships = ModelMetadataRegistry.getRelationships(className);
    relationships.set(propertyKey, {
      name: propertyKey,
      typeName: "ManyToMany",
      target: targetModel,
      backPopulates,
      options
    });
  };
}

export class BaseModel {
  static db: any = null;

  constructor(data?: Record<string, any>) {
    const className = this.constructor.name;
    const fields = ModelMetadataRegistry.getFields(className);
    
    // Assign fields
    if (data) {
      for (const [key, val] of Object.entries(data)) {
        (this as any)[key] = val;
      }
    }
  }

  static setDb(dbClient: any) {
    this.db = dbClient;
  }

  async save(): Promise<this> {
    const className = this.constructor.name;
    const db = (this.constructor as typeof BaseModel).db;
    if (!db) {
      throw new Error(`No database client registered for model ${className}. Run setDb() first.`);
    }

    const fields = ModelMetadataRegistry.getFields(className);
    const tableName = ModelMetadataRegistry.getTableName(className);

    // 1. Process Embeddings if defined
    for (const [key, field] of fields.entries()) {
      if (field.datatype && field.datatype.name === "Embedding") {
        const sourceField = field.datatype.options.sourceField;
        if (sourceField && (this as any)[sourceField]) {
          const textContent = (this as any)[sourceField];
          const vector = await AIEngine.generateEmbeddings(textContent, field.datatype.options.provider || "openai");
          (this as any)[key] = vector;
        }
      }
    }

    // 2. Encryption & Hashing
    const payload: Record<string, any> = {};
    let pkField = "id";

    for (const [key, field] of fields.entries()) {
      if (field.primaryKey) {
        pkField = key;
      }
      let val = (this as any)[key];
      if (val !== undefined && val !== null) {
        if (field.datatype && ["EncryptedString", "Secret"].includes(field.datatype.name)) {
          val = SecurityEngine.encryptField(val);
          (this as any)[key] = val;
        } else if (field.datatype && field.datatype.name === "HashedPassword") {
          val = SecurityEngine.hashPassword(val);
          (this as any)[key] = val;
        }
        payload[key] = val;
      }
    }

    // Assign Primary Key if empty and defined as UUID or ULID
    let pkVal = (this as any)[pkField];
    if (pkVal === undefined || pkVal === null) {
      const pkMeta = fields.get(pkField);
      if (pkMeta && pkMeta.datatype) {
        const dtName = pkMeta.datatype.name;
        if (dtName === "UUID") {
          // simple UUIDv4 generator
          pkVal = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
        } else if (dtName === "ULID") {
          // simple ULID generator
          pkVal = Date.now().toString(36) + Math.random().toString(36).substr(2, 10);
        }
        (this as any)[pkField] = pkVal;
        payload[pkField] = pkVal;
      }
    }

    // Save record to DB
    const hasPk = (this as any)[pkField] !== undefined && (this as any)[pkField] !== null;
    await db.write(tableName, payload, hasPk);

    return this;
  }

  async delete(): Promise<boolean> {
    const className = this.constructor.name;
    const db = (this.constructor as typeof BaseModel).db;
    if (!db) return false;

    const fields = ModelMetadataRegistry.getFields(className);
    const tableName = ModelMetadataRegistry.getTableName(className);

    let pkField = "id";
    for (const [key, field] of fields.entries()) {
      if (field.primaryKey) {
        pkField = key;
        break;
      }
    }

    const pkVal = (this as any)[pkField];
    if (pkVal === undefined || pkVal === null) return false;

    await db.delete(tableName, { [pkField]: pkVal });
    return true;
  }

  static find<T extends typeof BaseModel>(this: T): QueryBuilder<InstanceType<T>> {
    return new QueryBuilder<InstanceType<T>>(this);
  }

  static async create<T extends typeof BaseModel>(this: T, data: Partial<InstanceType<T>>): Promise<InstanceType<T>> {
    const instance = new this(data) as InstanceType<T>;
    await instance.save();
    return instance;
  }

  static async getById<T extends typeof BaseModel>(this: T, pkVal: any): Promise<InstanceType<T>> {
    const className = this.name;
    const fields = ModelMetadataRegistry.getFields(className);
    let pkField = "id";
    for (const [key, field] of fields.entries()) {
      if (field.primaryKey) {
        pkField = key;
        break;
      }
    }
    const results = await this.find().where(pkField, "=", pkVal).execute();
    if (!results || results.length === 0) {
      throw new Error(`Record with ${pkField}=${pkVal} not found in ${ModelMetadataRegistry.getTableName(className)}.`);
    }
    return results[0] as InstanceType<T>;
  }

  static async findFirst<T extends typeof BaseModel>(this: T, criteria: Record<string, any>): Promise<InstanceType<T> | null> {
    let builder = this.find();
    for (const [k, v] of Object.entries(criteria)) {
      builder = builder.where(k, "=", v);
    }
    const results = await builder.limit(1).execute();
    return results.length > 0 ? (results[0] as InstanceType<T>) : null;
  }

  static async updateMany<T extends typeof BaseModel>(this: T, filters: Record<string, any>, payload: Record<string, any>): Promise<number> {
    if (!this.db) {
      throw new Error("No database client registered.");
    }
    const tableName = ModelMetadataRegistry.getTableName(this.name);
    const driver = this.db.getRoute(tableName, true);
    await driver.update(tableName, payload, filters);
    return 1;
  }

  static async deleteMany<T extends typeof BaseModel>(this: T, filters: Record<string, any>): Promise<number> {
    if (!this.db) {
      throw new Error("No database client registered.");
    }
    const tableName = ModelMetadataRegistry.getTableName(this.name);
    const driver = this.db.getRoute(tableName, true);
    await driver.delete(tableName, filters);
    return 1;
  }

  static async count<T extends typeof BaseModel>(this: T, filters?: Record<string, any>): Promise<number> {
    let builder = this.find();
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        builder = builder.where(k, "=", v);
      }
    }
    const results = await builder.execute();
    return results.length;
  }

  async reload(): Promise<this> {
    const className = this.constructor.name;
    const modelClass = this.constructor as typeof BaseModel;
    const fields = ModelMetadataRegistry.getFields(className);
    let pkField = "id";
    for (const [key, field] of fields.entries()) {
      if (field.primaryKey) {
        pkField = key;
        break;
      }
    }
    const pkVal = (this as any)[pkField];
    if (pkVal === undefined || pkVal === null) {
      throw new Error("Cannot reload an unpersisted instance without a primary key value.");
    }
    const dbInstance = await modelClass.getById(pkVal);
    for (const key of fields.keys()) {
      (this as any)[key] = (dbInstance as any)[key];
    }
    return this;
  }

  toJSON(): Record<string, any> {
    const className = this.constructor.name;
    const fields = ModelMetadataRegistry.getFields(className);
    const data: Record<string, any> = {};
    for (const key of fields.keys()) {
      let val = (this as any)[key];
      const fieldMeta = fields.get(key);
      if (val !== undefined && val !== null && fieldMeta && fieldMeta.datatype && ["EncryptedString", "Secret"].includes(fieldMeta.datatype.name)) {
        val = SecurityEngine.decryptField(val);
      }
      data[key] = val;
    }
    return data;
  }
}
