package bulldb

import "fmt"

type UniversalType struct {
	Name    string
	Options map[string]interface{}
}

func NewUniversalType(name string, opts map[string]interface{}) UniversalType {
	return UniversalType{Name: name, Options: opts}
}

// Pre-defined constructor wrappers matching Python/TS
func UUID(opts ...map[string]interface{}) UniversalType { return wrap("UUID", opts) }
func ULID(opts ...map[string]interface{}) UniversalType { return wrap("ULID", opts) }
func Email(opts ...map[string]interface{}) UniversalType { return wrap("Email", opts) }
func Phone(opts ...map[string]interface{}) UniversalType { return wrap("Phone", opts) }
func URL(opts ...map[string]interface{}) UniversalType   { return wrap("URL", opts) }
func IPAddress(opts ...map[string]interface{}) UniversalType { return wrap("IPAddress", opts) }
func JSON(opts ...map[string]interface{}) UniversalType  { return wrap("JSON", opts) }
func JSONB(opts ...map[string]interface{}) UniversalType { return wrap("JSONB", opts) }
func Money(opts ...map[string]interface{}) UniversalType { return wrap("Money", opts) }
func TimestampTZ(opts ...map[string]interface{}) UniversalType { return wrap("TimestampTZ", opts) }
func EncryptedString(opts ...map[string]interface{}) UniversalType { return wrap("EncryptedString", opts) }
func HashedPassword(opts ...map[string]interface{}) UniversalType { return wrap("HashedPassword", opts) }
func Secret(opts ...map[string]interface{}) UniversalType { return wrap("Secret", opts) }
func Binary(opts ...map[string]interface{}) UniversalType { return wrap("Binary", opts) }
func GeoPoint(opts ...map[string]interface{}) UniversalType { return wrap("GeoPoint", opts) }
func Polygon(opts ...map[string]interface{}) UniversalType { return wrap("Polygon", opts) }
func Document(opts ...map[string]interface{}) UniversalType { return wrap("Document", opts) }

func Array(itemType interface{}, opts ...map[string]interface{}) UniversalType {
	m := getOpts(opts)
	m["item_type"] = itemType
	return NewUniversalType("Array", m)
}

func Enum(choices []string, opts ...map[string]interface{}) UniversalType {
	m := getOpts(opts)
	m["choices"] = choices
	return NewUniversalType("Enum", m)
}

func Decimal(precision, scale int, opts ...map[string]interface{}) UniversalType {
	m := getOpts(opts)
	m["precision"] = precision
	m["scale"] = scale
	return NewUniversalType("Decimal", m)
}

func Vector(dimension int, opts ...map[string]interface{}) UniversalType {
	m := getOpts(opts)
	m["dimension"] = dimension
	return NewUniversalType("Vector", m)
}

func Embedding(dimension int, provider string, opts ...map[string]interface{}) UniversalType {
	m := getOpts(opts)
	m["dimension"] = dimension
	m["provider"] = provider
	return NewUniversalType("Embedding", m)
}

func wrap(name string, opts []map[string]interface{}) UniversalType {
	return NewUniversalType(name, getOpts(opts))
}

func getOpts(opts []map[string]interface{}) map[string]interface{} {
	if len(opts) > 0 && opts[0] != nil {
		return opts[0]
	}
	return make(map[string]interface{})
}

type DataTypeMapper struct{}

func (DataTypeMapper) MapToPostgresql(ut UniversalType) string {
	name := ut.Name
	if name == "int" || name == "Integer" || name == "INTEGER" { return "INTEGER" }
	if name == "float" || name == "Float" || name == "FLOAT" { return "DOUBLE PRECISION" }
	if name == "bool" || name == "Boolean" || name == "BOOLEAN" { return "BOOLEAN" }
	if name == "UUID" { return "UUID" }
	if name == "ULID" { return "VARCHAR(26)" }
	if name == "Email" || name == "Phone" || name == "URL" || name == "IPAddress" { return "VARCHAR(255)" }
	if name == "JSON" { return "JSON" }
	if name == "JSONB" { return "JSONB" }
	if name == "Array" {
		subType, ok := ut.Options["item_type"].(UniversalType)
		subMapped := "VARCHAR(255)"
		if ok {
			subMapped = DataTypeMapper{}.MapToPostgresql(subType)
		}
		return fmt.Sprintf("%s[]", subMapped)
	}
	if name == "Enum" {
		choices, _ := ut.Options["choices"].([]string)
		var formatted []string
		for _, c := range choices {
			formatted = append(formatted, fmt.Sprintf("'%s'", c))
		}
		return fmt.Sprintf("VARCHAR(50) CHECK (VALUE IN (%s))", formatted)
	}
	if name == "Money" { return "NUMERIC(19, 4)" }
	if name == "Decimal" {
		prec, _ := ut.Options["precision"].(int)
		scale, _ := ut.Options["scale"].(int)
		if prec == 0 { prec = 10 }
		if scale == 0 { scale = 2 }
		return fmt.Sprintf("NUMERIC(%d, %d)", prec, scale)
	}
	if name == "TimestampTZ" { return "TIMESTAMP WITH TIME ZONE" }
	if name == "EncryptedString" || name == "Secret" || name == "Binary" { return "BYTEA" }
	if name == "HashedPassword" { return "VARCHAR(255)" }
	if name == "GeoPoint" { return "GEOMETRY(Point, 4326)" }
	if name == "Polygon" { return "GEOMETRY(Polygon, 4326)" }
	if name == "Vector" || name == "Embedding" {
		dim, _ := ut.Options["dimension"].(int)
		if dim == 0 { dim = 1536 }
		return fmt.Sprintf("vector(%d)", dim)
	}
	if name == "Document" { return "TEXT" }
	return "VARCHAR(255)"
}

func (DataTypeMapper) MapToSqlite(ut UniversalType) string {
	name := ut.Name
	if name == "int" || name == "Integer" || name == "INTEGER" { return "INTEGER" }
	if name == "float" || name == "Float" || name == "FLOAT" || name == "REAL" { return "REAL" }
	if name == "bool" || name == "Boolean" || name == "BOOLEAN" { return "INTEGER" }
	if name == "UUID" || name == "ULID" || name == "Email" || name == "Phone" || name == "URL" || name == "IPAddress" || name == "Enum" || name == "HashedPassword" {
		return "TEXT"
	}
	if name == "JSON" || name == "JSONB" || name == "Array" || name == "Document" {
		return "TEXT"
	}
	if name == "Money" || name == "Decimal" {
		return "REAL"
	}
	if name == "TimestampTZ" { return "TEXT" }
	if name == "EncryptedString" || name == "Secret" || name == "Binary" { return "BLOB" }
	if name == "GeoPoint" || name == "Polygon" { return "TEXT" }
	if name == "Vector" || name == "Embedding" { return "BLOB" }
	return "TEXT"
}

func (DataTypeMapper) MapToMongodb(ut UniversalType) string {
	name := ut.Name
	if name == "int" || name == "Integer" || name == "INTEGER" || name == "float" || name == "Float" || name == "FLOAT" || name == "REAL" { return "number" }
	if name == "bool" || name == "Boolean" || name == "BOOLEAN" { return "bool" }
	if name == "UUID" { return "uuid" }
	if name == "ULID" || name == "Email" || name == "Phone" || name == "URL" || name == "IPAddress" || name == "Enum" || name == "HashedPassword" || name == "TimestampTZ" {
		return "string"
	}
	if name == "JSON" || name == "JSONB" || name == "Document" { return "object" }
	if name == "Array" { return "array" }
	if name == "Money" || name == "Decimal" { return "decimal" }
	if name == "EncryptedString" || name == "Secret" || name == "Binary" { return "binData" }
	if name == "GeoPoint" || name == "Polygon" { return "object" }
	if name == "Vector" || name == "Embedding" { return "array" }
	return "string"
}
