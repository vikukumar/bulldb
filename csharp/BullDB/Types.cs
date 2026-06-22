using System;
using System.Collections.Generic;

namespace BullDB
{
    public class UniversalType
    {
        public string Name { get; set; }
        public Dictionary<string, object> Options { get; set; } = new Dictionary<string, object>();

        public UniversalType(string name, Dictionary<string, object>? options = null)
        {
            Name = name;
            if (options != null) Options = options;
        }
    }

    public static class Types
    {
        public static UniversalType UUID() => new UniversalType("UUID");
        public static UniversalType ULID() => new UniversalType("ULID");
        public static UniversalType Email() => new UniversalType("Email");
        public static UniversalType Phone() => new UniversalType("Phone");
        public static UniversalType URL() => new UniversalType("URL");
        public static UniversalType IPAddress() => new UniversalType("IPAddress");
        public static UniversalType JSON() => new UniversalType("JSON");
        public static UniversalType JSONB() => new UniversalType("JSONB");
        public static UniversalType Money() => new UniversalType("Money");
        public static UniversalType TimestampTZ() => new UniversalType("TimestampTZ");
        public static UniversalType EncryptedString() => new UniversalType("EncryptedString");
        public static UniversalType HashedPassword() => new UniversalType("HashedPassword");
        public static UniversalType Secret() => new UniversalType("Secret");
        public static UniversalType Binary() => new UniversalType("Binary");
        public static UniversalType GeoPoint() => new UniversalType("GeoPoint");
        public static UniversalType Polygon() => new UniversalType("Polygon");
        public static UniversalType Document() => new UniversalType("Document");

        public static UniversalType Array(UniversalType itemType) => 
            new UniversalType("Array", new Dictionary<string, object> { { "item_type", itemType } });

        public static UniversalType Decimal(int precision = 10, int scale = 2) => 
            new UniversalType("Decimal", new Dictionary<string, object> { { "precision", precision }, { "scale", scale } });

        public static UniversalType Vector(int dimension) => 
            new UniversalType("Vector", new Dictionary<string, object> { { "dimension", dimension } });
    }

    public static class DataTypeMapper
    {
        public static string MapToPostgresql(UniversalType ut)
        {
            string name = ut.Name;
            if (name == "number" || name == "Number") return "DOUBLE PRECISION";
            if (name == "boolean" || name == "Boolean") return "BOOLEAN";
            if (name == "string" || name == "String") return "VARCHAR(255)";
            if (name == "UUID") return "UUID";
            if (name == "ULID") return "VARCHAR(26)";
            if (name == "Email" || name == "Phone" || name == "URL" || name == "IPAddress") return "VARCHAR(255)";
            if (name == "JSON") return "JSON";
            if (name == "JSONB") return "JSONB";
            if (name == "Array") return "VARCHAR(255)[]";
            if (name == "Money") return "NUMERIC(19, 4)";
            if (name == "Decimal") return "NUMERIC(10, 2)";
            if (name == "TimestampTZ") return "TIMESTAMP WITH TIME ZONE";
            if (name == "EncryptedString" || name == "Secret" || name == "Binary") return "BYTEA";
            if (name == "HashedPassword") return "VARCHAR(255)";
            if (name == "GeoPoint") return "GEOMETRY(Point, 4326)";
            if (name == "Polygon") return "GEOMETRY(Polygon, 4326)";
            if (name == "Vector" || name == "Embedding") return "vector(1536)";
            if (name == "Document") return "TEXT";
            return "VARCHAR(255)";
        }

        public static string MapToSqlite(UniversalType ut)
        {
            string name = ut.Name;
            if (name == "number" || name == "Number") return "REAL";
            if (name == "boolean" || name == "Boolean") return "INTEGER";
            if (name == "string" || name == "String") return "TEXT";
            if (new List<string> { "UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword" }.Contains(name)) return "TEXT";
            if (new List<string> { "JSON", "JSONB", "Array", "Document" }.Contains(name)) return "TEXT";
            if (new List<string> { "Money", "Decimal" }.Contains(name)) return "REAL";
            if (name == "TimestampTZ") return "TEXT";
            if (new List<string> { "EncryptedString", "Secret", "Binary" }.Contains(name)) return "BLOB";
            if (new List<string> { "GeoPoint", "Polygon" }.Contains(name)) return "TEXT";
            if (new List<string> { "Vector", "Embedding" }.Contains(name)) return "BLOB";
            return "TEXT";
        }
    }
}
