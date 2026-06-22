package bulldb

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
)

type FieldMetadata struct {
	Name       string
	Type       string
	PrimaryKey bool
	Unique     bool
	Index      bool
}

type ModelMetadata struct {
	TableName string
	Fields    []FieldMetadata
}

var (
	modelRegistry = make(map[string]*ModelMetadata)
)

func RegisterModel(model interface{}) *ModelMetadata {
	t := reflect.TypeOf(model)
	if t.Kind() == reflect.Ptr {
		t = t.Elem()
	}

	name := t.Name()
	tableName := strings.ToLower(name) + "s"

	var fields []FieldMetadata
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		dbTag := f.Tag.Get("db")
		if dbTag == "" || dbTag == "-" {
			continue
		}

		parts := strings.Split(dbTag, ",")
		colName := parts[0]

		meta := FieldMetadata{
			Name: colName,
			Type: f.Type.Name(),
		}

		for _, opt := range parts[1:] {
			opt = strings.TrimSpace(opt)
			switch opt {
			case "primary_key":
				meta.PrimaryKey = true
				meta.Unique = true
				meta.Index = true
			case "unique":
				meta.Unique = true
				meta.Index = true
			case "index":
				meta.Index = true
			}
		}
		fields = append(fields, meta)
	}

	meta := &ModelMetadata{
		TableName: tableName,
		Fields:    fields,
	}
	modelRegistry[name] = meta
	return meta
}

func GetModelMetadata(name string) (*ModelMetadata, bool) {
	meta, ok := modelRegistry[name]
	return meta, ok
}

// Active record simulation mapping helpers
func MapStructToMap(s interface{}) (map[string]interface{}, error) {
	v := reflect.ValueOf(s)
	if v.Kind() == reflect.Ptr {
		v = v.Elem()
	}

	t := v.Type()
	_, ok := GetModelMetadata(t.Name())
	if !ok {
		RegisterModel(s)
	}

	m := make(map[string]interface{})
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		dbTag := f.Tag.Get("db")
		if dbTag == "" || dbTag == "-" {
			continue
		}
		colName := strings.Split(dbTag, ",")[0]
		fieldVal := v.Field(i).Interface()

		// Encryption / Hashing hooks
		encryptTag := f.Tag.Get("encrypt")
		hashTag := f.Tag.Get("hash")

		if encryptTag == "true" {
			if str, ok := fieldVal.(string); ok {
				encrypted, err := EncryptField(str)
				if err == nil {
					fieldVal = encrypted
				}
			}
		} else if hashTag == "true" {
			if str, ok := fieldVal.(string); ok {
				hashed, err := HashPassword(str)
				if err == nil {
					fieldVal = hashed
				}
			}
		}

		if f64Slice, ok := fieldVal.([]float64); ok {
			bytes, _ := json.Marshal(f64Slice)
			fieldVal = string(bytes)
		}

		m[colName] = fieldVal
	}

	return m, nil
}

func MapMapToStruct(m map[string]interface{}, s interface{}) error {
	v := reflect.ValueOf(s)
	if v.Kind() != reflect.Ptr {
		return errors.New("must pass a pointer to a struct")
	}
	v = v.Elem()
	t := v.Type()

	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		dbTag := f.Tag.Get("db")
		if dbTag == "" || dbTag == "-" {
			continue
		}
		colName := strings.Split(dbTag, ",")[0]
		val, ok := m[colName]
		if !ok || val == nil {
			continue
		}

		fieldVal := reflect.ValueOf(val)
		structField := v.Field(i)

		// Decrypt if encrypted
		encryptTag := f.Tag.Get("encrypt")
		if encryptTag == "true" {
			if str, ok := val.(string); ok {
				decrypted, err := DecryptField(str)
				if err == nil {
					val = decrypted
					fieldVal = reflect.ValueOf(decrypted)
				}
			}
		}

		if structField.Kind() == reflect.Slice && structField.Type().Elem().Kind() == reflect.Float64 {
			if strVal, ok := val.(string); ok {
				var f64Slice []float64
				if err := json.Unmarshal([]byte(strVal), &f64Slice); err == nil {
					if structField.CanSet() {
						structField.Set(reflect.ValueOf(f64Slice))
					}
					continue
				}
			}
		}

		if structField.CanSet() {
			if fieldVal.Type().ConvertibleTo(structField.Type()) {
				structField.Set(fieldVal.Convert(structField.Type()))
			} else if strVal, ok := val.(string); ok && structField.Kind() == reflect.String {
				structField.SetString(strVal)
			} else {
				// Handle fallback conversions
				switch structField.Kind() {
				case reflect.Int, reflect.Int64:
					if iVal, ok := val.(int64); ok {
						structField.SetInt(iVal)
					} else if fVal, ok := val.(float64); ok {
						structField.SetInt(int64(fVal))
					}
				case reflect.Float64:
					if fVal, ok := val.(float64); ok {
						structField.SetFloat(fVal)
					} else if iVal, ok := val.(int64); ok {
						structField.SetFloat(float64(iVal))
					}
				}
			}
		}
	}
	return nil
}

// Active Record Lifecycle CRUD APIs
func Create(ctx context.Context, model interface{}) error {
	v := reflect.ValueOf(model)
	if v.Kind() != reflect.Ptr {
		return errors.New("must pass a pointer to a struct")
	}
	v = v.Elem()
	t := v.Type()

	meta := RegisterModel(model)

	// Check if there is an Embedding field that needs generating from source
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		embedTag := f.Tag.Get("embedding")
		if embedTag != "" && strings.HasPrefix(embedTag, "source=") {
			sourceCol := strings.TrimPrefix(embedTag, "source=")
			var sourceVal string
			for j := 0; j < t.NumField(); j++ {
				f2 := t.Field(j)
				dbTag := f2.Tag.Get("db")
				colName := strings.Split(dbTag, ",")[0]
				if colName == sourceCol {
					sourceVal = v.Field(j).String()
					break
				}
			}
			if sourceVal != "" {
				vec, err := AIEngine{}.GenerateEmbeddings(sourceVal, "openai")
				if err == nil {
					embField := v.Field(i)
					if embField.CanSet() && embField.Kind() == reflect.Slice && embField.Type().Elem().Kind() == reflect.Float64 {
						embField.Set(reflect.ValueOf(vec))
					}
				}
			}
		}
	}

	payload, err := MapStructToMap(model)
	if err != nil {
		return err
	}

	// Auto-assign ID if primary key is UUID string and empty
	var pkCol string
	var pkFieldIndex int = -1
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		dbTag := f.Tag.Get("db")
		if strings.Contains(dbTag, "primary_key") {
			pkCol = strings.Split(dbTag, ",")[0]
			pkFieldIndex = i
			break
		}
	}

	if pkCol != "" && pkFieldIndex >= 0 {
		pkVal := v.Field(pkFieldIndex).String()
		if pkVal == "" {
			u := make([]byte, 16)
			_, _ = io.ReadFull(rand.Reader, u)
			u[8] = (u[8] | 0x40) & 0x7f
			u[6] = (u[6] & 0xf) | 0x40
			uuidStr := fmt.Sprintf("%x-%x-%x-%x-%x", u[0:4], u[4:6], u[6:8], u[8:10], u[10:])
			v.Field(pkFieldIndex).SetString(uuidStr)
			payload[pkCol] = uuidStr
		}
	}

	res, err := DB.Write(ctx, meta.TableName, payload, true)
	if err != nil {
		return err
	}

	return MapMapToStruct(res, model)
}

func GetById(ctx context.Context, id interface{}, dest interface{}) error {
	v := reflect.ValueOf(dest)
	if v.Kind() != reflect.Ptr {
		return errors.New("must pass a pointer to a struct")
	}
	v = v.Elem()
	t := v.Type()

	meta := RegisterModel(dest)
	var pkCol string
	for _, f := range meta.Fields {
		if f.PrimaryKey {
			pkCol = f.Name
			break
		}
	}
	if pkCol == "" {
		pkCol = "id"
	}

	qb := NewQueryBuilder(meta.TableName)
	qb.Where(pkCol, "=", id).Limit(1)

	sliceType := reflect.SliceOf(t)
	slicePtr := reflect.New(sliceType)

	err := qb.Find(ctx, slicePtr.Interface())
	if err != nil {
		return err
	}

	sliceVal := slicePtr.Elem()
	if sliceVal.Len() == 0 {
		return fmt.Errorf("record not found")
	}

	v.Set(sliceVal.Index(0))
	return nil
}

func FindFirst(ctx context.Context, criteria map[string]interface{}, dest interface{}) error {
	v := reflect.ValueOf(dest)
	if v.Kind() != reflect.Ptr {
		return errors.New("must pass a pointer to a struct")
	}
	v = v.Elem()
	t := v.Type()

	meta := RegisterModel(dest)
	qb := NewQueryBuilder(meta.TableName)
	for k, val := range criteria {
		qb.Where(k, "=", val)
	}
	qb.Limit(1)

	sliceType := reflect.SliceOf(t)
	slicePtr := reflect.New(sliceType)

	err := qb.Find(ctx, slicePtr.Interface())
	if err != nil {
		return err
	}

	sliceVal := slicePtr.Elem()
	if sliceVal.Len() == 0 {
		return fmt.Errorf("record not found")
	}

	v.Set(sliceVal.Index(0))
	return nil
}

func Count(ctx context.Context, tableName string, criteria map[string]interface{}) (int, error) {
	qb := NewQueryBuilder(tableName)
	for k, val := range criteria {
		qb.Where(k, "=", val)
	}
	sql, args := qb.Compile()
	sqlCount := "SELECT COUNT(*) as count FROM " + strings.TrimPrefix(sql, "SELECT * FROM ")
	rows, err := DB.Execute(ctx, sqlCount, args...)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	if countVal, ok := rows[0]["count"]; ok {
		if c, ok := countVal.(int64); ok {
			return int(c), nil
		}
		if c, ok := countVal.(float64); ok {
			return int(c), nil
		}
		if c, ok := countVal.(int); ok {
			return c, nil
		}
	}
	return 0, nil
}

func Reload(ctx context.Context, model interface{}) error {
	v := reflect.ValueOf(model)
	if v.Kind() != reflect.Ptr {
		return errors.New("must pass a pointer to a struct")
	}
	v = v.Elem()
	t := v.Type()

	_ = RegisterModel(model)
	var pkCol string
	var pkFieldIndex int = -1
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		dbTag := f.Tag.Get("db")
		if strings.Contains(dbTag, "primary_key") {
			pkCol = strings.Split(dbTag, ",")[0]
			pkFieldIndex = i
			break
		}
	}

	if pkCol == "" || pkFieldIndex < 0 {
		return errors.New("model has no primary key field")
	}

	pkVal := v.Field(pkFieldIndex).Interface()

	freshPtr := reflect.New(t)
	err := GetById(ctx, pkVal, freshPtr.Interface())
	if err != nil {
		return err
	}

	v.Set(freshPtr.Elem())
	return nil
}

func Delete(ctx context.Context, model interface{}) error {
	v := reflect.ValueOf(model)
	if v.Kind() != reflect.Ptr {
		return errors.New("must pass a pointer to a struct")
	}
	v = v.Elem()
	t := v.Type()

	meta := RegisterModel(model)
	var pkCol string
	var pkFieldIndex int = -1
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		dbTag := f.Tag.Get("db")
		if strings.Contains(dbTag, "primary_key") {
			pkCol = strings.Split(dbTag, ",")[0]
			pkFieldIndex = i
			break
		}
	}

	if pkCol == "" || pkFieldIndex < 0 {
		return errors.New("model has no primary key field")
	}

	pkVal := v.Field(pkFieldIndex).Interface()
	_, err := DB.Delete(ctx, meta.TableName, map[string]interface{}{pkCol: pkVal})
	return err
}

func ToJSON(model interface{}) (map[string]interface{}, error) {
	v := reflect.ValueOf(model)
	if v.Kind() == reflect.Ptr {
		v = v.Elem()
	}
	t := v.Type()

	m := make(map[string]interface{})
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		dbTag := f.Tag.Get("db")
		if dbTag == "" || dbTag == "-" {
			continue
		}
		colName := strings.Split(dbTag, ",")[0]
		fieldVal := v.Field(i).Interface()

		encryptTag := f.Tag.Get("encrypt")
		if encryptTag == "true" {
			if str, ok := fieldVal.(string); ok {
				decrypted, err := DecryptField(str)
				if err == nil {
					fieldVal = decrypted
				}
			}
		}
		m[colName] = fieldVal
	}
	return m, nil
}
