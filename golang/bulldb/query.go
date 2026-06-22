package bulldb

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

type QueryBuilder struct {
	mdb         *MultiDatabase
	tableName   string
	wheres      []string
	args        []interface{}
	limitVal    int
	rlsInjected bool
}

func NewQueryBuilder(tableName string) *QueryBuilder {
	return &QueryBuilder{
		mdb:       DB,
		tableName: tableName,
		limitVal:  -1,
	}
}

func (qb *QueryBuilder) Where(col, op string, val interface{}) *QueryBuilder {
	qb.wheres = append(qb.wheres, fmt.Sprintf("%s %s ?", col, op))
	qb.args = append(qb.args, val)
	return qb
}

func (qb *QueryBuilder) Limit(limit int) *QueryBuilder {
	qb.limitVal = limit
	return qb
}

func (qb *QueryBuilder) VectorSearch(col string, vec []float64, limit int) *QueryBuilder {
	qb.wheres = append(qb.wheres, fmt.Sprintf("COSINE_SIMILARITY(%s, ?) > 0.8", col))
	qb.args = append(qb.args, vec)
	qb.limitVal = limit
	return qb
}

func (qb *QueryBuilder) Compile() (string, []interface{}) {
	if !qb.rlsInjected {
		InjectRLS(qb)
		qb.rlsInjected = true
	}

	query := fmt.Sprintf("SELECT * FROM %s", qb.tableName)
	if len(qb.wheres) > 0 {
		query += " WHERE " + strings.Join(qb.wheres, " AND ")
	}
	if qb.limitVal >= 0 {
		query += fmt.Sprintf(" LIMIT %d", qb.limitVal)
	}

	processedArgs := make([]interface{}, len(qb.args))
	for i, arg := range qb.args {
		if f64Slice, ok := arg.([]float64); ok {
			bytes, _ := json.Marshal(f64Slice)
			processedArgs[i] = string(bytes)
		} else {
			processedArgs[i] = arg
		}
	}

	return query, processedArgs
}

func (qb *QueryBuilder) Find(ctx context.Context, dest interface{}) error {
	destVal := reflect.ValueOf(dest)
	if destVal.Kind() != reflect.Ptr || destVal.Elem().Kind() != reflect.Slice {
		return fmt.Errorf("dest must be a pointer to a slice of structs")
	}

	sliceVal := destVal.Elem()
	itemType := sliceVal.Type().Elem()

	sql, args := qb.Compile()
	rows, err := qb.mdb.Execute(ctx, sql, args...)
	if err != nil {
		return err
	}

	for _, row := range rows {
		newPtr := reflect.New(itemType)
		err := MapMapToStruct(row, newPtr.Interface())
		if err != nil {
			return err
		}
		sliceVal.Set(reflect.Append(sliceVal, newPtr.Elem()))
	}

	return nil
}
