export class UniversalType {
  constructor(public name: string, public options: Record<string, any> = {}) {}
}

export function UUID(options?: Record<string, any>) { return new UniversalType("UUID", options); }
export function ULID(options?: Record<string, any>) { return new UniversalType("ULID", options); }
export function Email(options?: Record<string, any>) { return new UniversalType("Email", options); }
export function Phone(options?: Record<string, any>) { return new UniversalType("Phone", options); }
export function URL(options?: Record<string, any>) { return new UniversalType("URL", options); }
export function IPAddress(options?: Record<string, any>) { return new UniversalType("IPAddress", options); }
export function JSONType(options?: Record<string, any>) { return new UniversalType("JSON", options); }
export function JSONB(options?: Record<string, any>) { return new UniversalType("JSONB", options); }
export function ArrayType(itemType: any, options?: Record<string, any>) { return new UniversalType("Array", { itemType, ...options }); }
export function EnumType(choices: string[], options?: Record<string, any>) { return new UniversalType("Enum", { choices, ...options }); }
export function Money(options?: Record<string, any>) { return new UniversalType("Money", options); }
export function Decimal(precision = 10, scale = 2, options?: Record<string, any>) { return new UniversalType("Decimal", { precision, scale, ...options }); }
export function TimestampTZ(options?: Record<string, any>) { return new UniversalType("TimestampTZ", options); }
export function EncryptedString(options?: Record<string, any>) { return new UniversalType("EncryptedString", options); }
export function HashedPassword(options?: Record<string, any>) { return new UniversalType("HashedPassword", options); }
export function Secret(options?: Record<string, any>) { return new UniversalType("Secret", options); }
export function Binary(options?: Record<string, any>) { return new UniversalType("Binary", options); }
export function GeoPoint(options?: Record<string, any>) { return new UniversalType("GeoPoint", options); }
export function Polygon(options?: Record<string, any>) { return new UniversalType("Polygon", options); }
export function Vector(dimension: number, options?: Record<string, any>) { return new UniversalType("Vector", { dimension, ...options }); }
export function Embedding(dimension: number, provider = "openai", options?: Record<string, any>) { return new UniversalType("Embedding", { dimension, provider, ...options }); }
export function Document(options?: Record<string, any>) { return new UniversalType("Document", options); }
export function ImageEmbedding(dimension: number, options?: Record<string, any>) { return new UniversalType("ImageEmbedding", { dimension, ...options }); }
export function AudioEmbedding(dimension: number, options?: Record<string, any>) { return new UniversalType("AudioEmbedding", { dimension, ...options }); }
export function VideoEmbedding(dimension: number, options?: Record<string, any>) { return new UniversalType("VideoEmbedding", { dimension, ...options }); }

export class DataTypeMapper {
  static mapToPostgresql(ut: UniversalType): string {
    const name = ut.name;
    if (["number", "Number"].includes(name)) return "DOUBLE PRECISION";
    if (["boolean", "Boolean"].includes(name)) return "BOOLEAN";
    if (["string", "String"].includes(name)) return "VARCHAR(255)";
    if (name === "UUID") return "UUID";
    if (name === "ULID") return "VARCHAR(26)";
    if (["Email", "Phone", "URL", "IPAddress"].includes(name)) return "VARCHAR(255)";
    if (name === "JSON") return "JSON";
    if (name === "JSONB") return "JSONB";
    if (name === "Array") {
      const subType = ut.options.itemType;
      const subMapped = subType instanceof UniversalType ? this.mapToPostgresql(subType) : "VARCHAR(255)";
      return `${subMapped}[]`;
    }
    if (name === "Enum") {
      const choices = (ut.options.choices || []).map((c: string) => `'${c}'`).join(", ");
      return `VARCHAR(50) CHECK (VALUE IN (${choices}))`;
    }
    if (name === "Money") return "NUMERIC(19, 4)";
    if (name === "Decimal") {
      return `NUMERIC(${ut.options.precision || 10}, ${ut.options.scale || 2})`;
    }
    if (name === "TimestampTZ") return "TIMESTAMP WITH TIME ZONE";
    if (["EncryptedString", "Secret"].includes(name)) return "BYTEA";
    if (name === "HashedPassword") return "VARCHAR(255)";
    if (name === "Binary") return "BYTEA";
    if (name === "GeoPoint") return "GEOMETRY(Point, 4326)";
    if (name === "Polygon") return "GEOMETRY(Polygon, 4326)";
    if (["Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"].includes(name)) {
      return `vector(${ut.options.dimension || 1536})`;
    }
    if (name === "Document") return "TEXT";
    return "VARCHAR(255)";
  }

  static mapToSqlite(ut: UniversalType): string {
    const name = ut.name;
    if (["number", "Number"].includes(name)) return "REAL";
    if (["boolean", "Boolean"].includes(name)) return "INTEGER";
    if (["string", "String"].includes(name)) return "TEXT";
    if (["UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword"].includes(name)) return "TEXT";
    if (["JSON", "JSONB", "Array", "Document"].includes(name)) return "TEXT";
    if (["Money", "Decimal"].includes(name)) return "REAL";
    if (name === "TimestampTZ") return "TEXT";
    if (["EncryptedString", "Secret", "Binary"].includes(name)) return "BLOB";
    if (["GeoPoint", "Polygon"].includes(name)) return "TEXT";
    if (["Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"].includes(name)) return "BLOB";
    return "TEXT";
  }

  static mapToMongodb(ut: UniversalType): string {
    const name = ut.name;
    if (["number", "Number"].includes(name)) return "number";
    if (["boolean", "Boolean"].includes(name)) return "bool";
    if (["string", "String"].includes(name)) return "string";
    if (name === "UUID") return "uuid";
    if (["ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword", "TimestampTZ"].includes(name)) return "string";
    if (["JSON", "JSONB", "Document"].includes(name)) return "object";
    if (name === "Array") return "array";
    if (["Money", "Decimal"].includes(name)) return "decimal";
    if (["EncryptedString", "Secret", "Binary"].includes(name)) return "binData";
    if (["GeoPoint", "Polygon"].includes(name)) return "object";
    if (["Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"].includes(name)) return "array";
    return "string";
  }

  static mapToDynamodb(ut: UniversalType): string {
    const name = ut.name;
    if (["number", "Number", "Money", "Decimal"].includes(name)) return "N";
    if (["boolean", "Boolean"].includes(name)) return "BOOL";
    if (["string", "String", "UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword", "TimestampTZ"].includes(name)) return "S";
    if (["JSON", "JSONB", "Document", "GeoPoint", "Polygon"].includes(name)) return "M";
    if (name === "Array") return "L";
    if (["EncryptedString", "Secret", "Binary"].includes(name)) return "B";
    if (["Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"].includes(name)) return "L";
    return "S";
  }

  static mapToNeo4j(ut: UniversalType): string {
    const name = ut.name;
    if (["number", "Number", "Money", "Decimal"].includes(name)) return "FLOAT";
    if (["boolean", "Boolean"].includes(name)) return "BOOLEAN";
    if (["string", "String", "UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword", "TimestampTZ", "Document"].includes(name)) return "STRING";
    if (["JSON", "JSONB", "GeoPoint", "Polygon"].includes(name)) return "STRING";
    if (name === "Array") return "LIST";
    if (["EncryptedString", "Secret", "Binary"].includes(name)) return "STRING";
    if (["Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"].includes(name)) return "LIST";
    return "STRING";
  }

  static mapToElasticsearch(ut: UniversalType): string {
    const name = ut.name;
    if (["number", "Number"].includes(name)) return "float";
    if (["boolean", "Boolean"].includes(name)) return "boolean";
    if (["string", "String"].includes(name)) return "text";
    if (["UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword"].includes(name)) return "keyword";
    if (["JSON", "JSONB"].includes(name)) return "object";
    if (name === "Array") return "nested";
    if (["Money", "Decimal"].includes(name)) return "double";
    if (name === "TimestampTZ") return "date";
    if (["EncryptedString", "Secret", "Binary"].includes(name)) return "binary";
    if (name === "GeoPoint") return "geo_point";
    if (name === "Polygon") return "geo_shape";
    if (["Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"].includes(name)) return "dense_vector";
    if (name === "Document") return "text";
    return "text";
  }
}
