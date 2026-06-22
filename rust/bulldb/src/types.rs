use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct UniversalType {
    pub name: String,
    pub options: HashMap<String, String>,
}

impl UniversalType {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            options: HashMap::new(),
        }
    }
}

pub struct DataTypeMapper;

impl DataTypeMapper {
    pub fn map_to_postgresql(ut: &UniversalType) -> String {
        let name = &ut.name;
        if ["int", "Integer", "INTEGER"].contains(&name.as_str()) { return "INTEGER".to_string(); }
        if ["float", "Float", "FLOAT"].contains(&name.as_str()) { return "DOUBLE PRECISION".to_string(); }
        if ["bool", "Boolean", "BOOLEAN"].contains(&name.as_str()) { return "BOOLEAN".to_string(); }
        if name == "UUID" { return "UUID".to_string(); }
        if name == "ULID" { return "VARCHAR(26)".to_string(); }
        if ["Email", "Phone", "URL", "IPAddress"].contains(&name.as_str()) { return "VARCHAR(255)".to_string(); }
        if name == "JSON" { return "JSON".to_string(); }
        if name == "JSONB" { return "JSONB".to_string(); }
        if name == "Array" { return "VARCHAR(255)[]".to_string(); }
        if name == "Money" { return "NUMERIC(19, 4)".to_string(); }
        if name == "TimestampTZ" { return "TIMESTAMP WITH TIME ZONE".to_string(); }
        if ["EncryptedString", "Secret", "Binary"].contains(&name.as_str()) { return "BYTEA".to_string(); }
        if name == "HashedPassword" { return "VARCHAR(255)".to_string(); }
        if name == "GeoPoint" { return "GEOMETRY(Point, 4326)".to_string(); }
        if name == "Polygon" { return "GEOMETRY(Polygon, 4326)".to_string(); }
        if ["Vector", "Embedding"].contains(&name.as_str()) { return "vector(1536)".to_string(); }
        if name == "Document" { return "TEXT".to_string(); }
        "VARCHAR(255)".to_string()
    }

    pub fn map_to_sqlite(ut: &UniversalType) -> String {
        let name = &ut.name;
        if ["int", "Integer", "INTEGER"].contains(&name.as_str()) { return "INTEGER".to_string(); }
        if ["float", "Float", "FLOAT", "REAL"].contains(&name.as_str()) { return "REAL".to_string(); }
        if ["bool", "Boolean", "BOOLEAN"].contains(&name.as_str()) { return "INTEGER".to_string(); }
        if ["UUID", "ULID", "Email", "Phone", "URL", "IPAddress", "Enum", "HashedPassword"].contains(&name.as_str()) {
            return "TEXT".to_string();
        }
        if ["JSON", "JSONB", "Array", "Document"].contains(&name.as_str()) {
            return "TEXT".to_string();
        }
        if ["Money", "Decimal"].contains(&name.as_str()) {
            return "REAL".to_string();
        }
        if name == "TimestampTZ" { return "TEXT".to_string(); }
        if ["EncryptedString", "Secret", "Binary"].contains(&name.as_str()) { return "BLOB".to_string(); }
        if ["GeoPoint", "Polygon"].contains(&name.as_str()) { return "TEXT".to_string(); }
        if ["Vector", "Embedding"].contains(&name.as_str()) { return "BLOB".to_string(); }
        "TEXT".to_string()
    }
}
