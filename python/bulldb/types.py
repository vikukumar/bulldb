import re
from typing import Any, Dict, List, Optional

class UniversalType:
    def __init__(self, name: str, **kwargs):
        self.name = name
        self.options = kwargs

    def __repr__(self):
        return f"UniversalType({self.name})"

# Define DataType markers
def UUID(**kwargs) -> UniversalType: return UniversalType("UUID", **kwargs)
def ULID(**kwargs) -> UniversalType: return UniversalType("ULID", **kwargs)
def Email(**kwargs) -> UniversalType: return UniversalType("Email", **kwargs)
def Phone(**kwargs) -> UniversalType: return UniversalType("Phone", **kwargs)
def URL(**kwargs) -> UniversalType: return UniversalType("URL", **kwargs)
def IPAddress(**kwargs) -> UniversalType: return UniversalType("IPAddress", **kwargs)
def JSON(**kwargs) -> UniversalType: return UniversalType("JSON", **kwargs)
def JSONB(**kwargs) -> UniversalType: return UniversalType("JSONB", **kwargs)
def Array(item_type: Any, **kwargs) -> UniversalType: return UniversalType("Array", item_type=item_type, **kwargs)
def Enum(choices: List[str], **kwargs) -> UniversalType: return UniversalType("Enum", choices=choices, **kwargs)
def Money(**kwargs) -> UniversalType: return UniversalType("Money", **kwargs)
def Decimal(precision: int = 10, scale: int = 2, **kwargs) -> UniversalType: 
    return UniversalType("Decimal", precision=precision, scale=scale, **kwargs)
def TimestampTZ(**kwargs) -> UniversalType: return UniversalType("TimestampTZ", **kwargs)
def EncryptedString(**kwargs) -> UniversalType: return UniversalType("EncryptedString", **kwargs)
def HashedPassword(**kwargs) -> UniversalType: return UniversalType("HashedPassword", **kwargs)
def Secret(**kwargs) -> UniversalType: return UniversalType("Secret", **kwargs)
def Binary(**kwargs) -> UniversalType: return UniversalType("Binary", **kwargs)
def GeoPoint(**kwargs) -> UniversalType: return UniversalType("GeoPoint", **kwargs)
def Polygon(**kwargs) -> UniversalType: return UniversalType("Polygon", **kwargs)
def Vector(dimension: int, **kwargs) -> UniversalType: return UniversalType("Vector", dimension=dimension, **kwargs)
def Embedding(dimension: int, provider: str = "openai", **kwargs) -> UniversalType: 
    return UniversalType("Embedding", dimension=dimension, provider=provider, **kwargs)
def Document(**kwargs) -> UniversalType: return UniversalType("Document", **kwargs)
def ImageEmbedding(dimension: int, **kwargs) -> UniversalType: return UniversalType("ImageEmbedding", dimension=dimension, **kwargs)
def AudioEmbedding(dimension: int, **kwargs) -> UniversalType: return UniversalType("AudioEmbedding", dimension=dimension, **kwargs)
def VideoEmbedding(dimension: int, **kwargs) -> UniversalType: return UniversalType("VideoEmbedding", dimension=dimension, **kwargs)

# Dialect mapper class mapping every single type to target database types
class DataTypeMapper:
    @staticmethod
    def map_to_postgresql(ut: UniversalType) -> str:
        name = ut.name
        if name in ("int", "Integer", "INTEGER"): return "INTEGER"
        if name in ("float", "Float", "FLOAT"): return "DOUBLE PRECISION"
        if name in ("bool", "Boolean", "BOOLEAN"): return "BOOLEAN"
        if name == "UUID": return "UUID"
        if name == "ULID": return "VARCHAR(26)"
        if name in ("Email", "Phone", "URL", "IPAddress"): return "VARCHAR(255)"
        if name == "JSON": return "JSON"
        if name == "JSONB": return "JSONB"
        if name == "Array":
            sub_type = ut.options.get("item_type")
            sub_mapped = DataTypeMapper.map_to_postgresql(sub_type) if isinstance(sub_type, UniversalType) else "VARCHAR(255)"
            return f"{sub_mapped}[]"
        if name == "Enum":
            choices = ", ".join(f"'{c}'" for c in ut.options.get("choices", []))
            return f"VARCHAR(50) CHECK (VALUE IN ({choices}))"
        if name == "Money": return "NUMERIC(19, 4)"
        if name == "Decimal":
            return f"NUMERIC({ut.options.get('precision', 10)}, {ut.options.get('scale', 2)})"
        if name == "TimestampTZ": return "TIMESTAMP WITH TIME ZONE"
        if name in ("EncryptedString", "Secret"): return "BYTEA" # encrypted binary data
        if name == "HashedPassword": return "VARCHAR(255)"
        if name == "Binary": return "BYTEA"
        if name == "GeoPoint": return "GEOMETRY(Point, 4326)"
        if name == "Polygon": return "GEOMETRY(Polygon, 4326)"
        if name in ("Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"):
            dim = ut.options.get("dimension", 1536)
            return f"vector({dim})"
        if name == "Document": return "TEXT"
        return "VARCHAR(255)"

    @staticmethod
    def map_to_sqlite(ut: UniversalType) -> str:
        name = ut.name
        if name in ("int", "Integer", "INTEGER"): return "INTEGER"
        if name in ("float", "Float", "FLOAT", "REAL"): return "REAL"
        if name in ("bool", "Boolean", "BOOLEAN"): return "INTEGER"
        if name in ("UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword"): return "TEXT"
        if name in ("JSON", "JSONB", "Array", "Document"): return "TEXT"
        if name in ("Money", "Decimal"): return "REAL"
        if name == "TimestampTZ": return "TEXT"
        if name in ("EncryptedString", "Secret", "Binary"): return "BLOB"
        if name in ("GeoPoint", "Polygon"): return "TEXT"
        if name in ("Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"): return "BLOB" # serialized array or blob
        return "TEXT"

    @staticmethod
    def map_to_mongodb(ut: UniversalType) -> str:
        name = ut.name
        if name in ("int", "Integer", "INTEGER", "float", "Float", "FLOAT", "REAL"): return "number"
        if name in ("bool", "Boolean", "BOOLEAN"): return "bool"
        if name == "UUID": return "uuid"
        if name in ("ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword", "TimestampTZ"): return "string"
        if name in ("JSON", "JSONB", "Document"): return "object"
        if name == "Array": return "array"
        if name in ("Money", "Decimal"): return "decimal"
        if name in ("EncryptedString", "Secret", "Binary"): return "binData"
        if name in ("GeoPoint", "Polygon"): return "object" # GeoJSON
        if name in ("Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"): return "array"
        return "string"

    @staticmethod
    def map_to_dynamodb(ut: UniversalType) -> str:
        name = ut.name
        if name in ("int", "Integer", "INTEGER", "float", "Float", "FLOAT", "REAL", "Money", "Decimal"): return "N"
        if name in ("bool", "Boolean", "BOOLEAN"): return "BOOL"
        if name in ("UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword", "TimestampTZ"): return "S"
        if name in ("JSON", "JSONB", "Document", "GeoPoint", "Polygon"): return "M"
        if name == "Array": return "L"
        if name in ("EncryptedString", "Secret", "Binary"): return "B"
        if name in ("Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"): return "L"
        return "S"

    @staticmethod
    def map_to_neo4j(ut: UniversalType) -> str:
        name = ut.name
        if name in ("int", "Integer", "INTEGER"): return "INTEGER"
        if name in ("float", "Float", "FLOAT", "REAL", "Money", "Decimal"): return "FLOAT"
        if name in ("bool", "Boolean", "BOOLEAN"): return "BOOLEAN"
        if name in ("UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword", "TimestampTZ", "Document"): return "STRING"
        if name in ("JSON", "JSONB", "GeoPoint", "Polygon"): return "STRING" # Neo4j properties can store maps or JSON string representation
        if name == "Array": return "LIST"
        if name in ("EncryptedString", "Secret", "Binary"): return "STRING" # Base64 encoded
        if name in ("Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"): return "LIST" # list of floats
        return "STRING"

    @staticmethod
    def map_to_elasticsearch(ut: UniversalType) -> str:
        name = ut.name
        if name in ("int", "Integer", "INTEGER"): return "integer"
        if name in ("float", "Float", "FLOAT", "REAL"): return "float"
        if name in ("bool", "Boolean", "BOOLEAN"): return "boolean"
        if name in ("UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword"): return "keyword"
        if name in ("JSON", "JSONB"): return "object"
        if name == "Array": return "nested"
        if name in ("Money", "Decimal"): return "double"
        if name == "TimestampTZ": return "date"
        if name in ("EncryptedString", "Secret", "Binary"): return "binary"
        if name == "GeoPoint": return "geo_point"
        if name == "Polygon": return "geo_shape"
        if name in ("Vector", "Embedding", "ImageEmbedding", "AudioEmbedding", "VideoEmbedding"): return "dense_vector"
        if name == "Document": return "text"
        return "text"
