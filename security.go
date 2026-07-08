package bulldb

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

type SecurityEngine struct{}

var sqlInjectionPattern = regexp.MustCompile(`(?i)(UNION\s+SELECT|SELECT\s+.*\s+FROM|INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|UPDATE\s+.*\s+SET|--|/\*|\*/)`)

func (SecurityEngine) ScanSQLInjection(input string) error {
	if sqlInjectionPattern.MatchString(input) {
		return errors.New("malicious SQL input detected")
	}
	return nil
}

// SQL string injection checker helper
func SafeSQL(query string) (string, error) {
	err := SecurityEngine{}.ScanSQLInjection(query)
	if err != nil {
		return "", err
	}
	return query, nil
}

// Key Derivation and Retrieval
var (
	encryptionKey     []byte
	encryptionKeyOnce sync.Once
	encryptionKeyMu   sync.RWMutex
)

func SetEncryptionKey(key []byte) {
	encryptionKeyMu.Lock()
	defer encryptionKeyMu.Unlock()
	if len(key) >= 32 {
		encryptionKey = key[:32]
	} else {
		padded := make([]byte, 32)
		copy(padded, key)
		encryptionKey = padded
	}
}

func getEncryptionKey() []byte {
	encryptionKeyMu.RLock()
	k := encryptionKey
	encryptionKeyMu.RUnlock()
	if k != nil {
		return k
	}

	encryptionKeyOnce.Do(func() {
		encryptionKeyMu.Lock()
		defer encryptionKeyMu.Unlock()
		if encryptionKey != nil {
			return
		}
		keyStr := os.Getenv("BULLDB_ENCRYPTION_KEY")
		if keyStr != "" {
			h := sha256.Sum256([]byte(keyStr))
			encryptionKey = h[:]
		} else {
			encryptionKey = make([]byte, 32)
			if _, err := rand.Read(encryptionKey); err != nil {
				// Absolute emergency fallback
				encryptionKey = []byte("0123456789abcdef0123456789abcdef")
			}
		}
	})

	encryptionKeyMu.RLock()
	defer encryptionKeyMu.RUnlock()
	return encryptionKey
}

// AES-256-GCM encryption compatible with Node.js/Python GCM format (nonce (12b) + tag (16b) + ciphertext)
func EncryptField(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	key := getEncryptionKey()
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	seal := aesgcm.Seal(nil, nonce, []byte(plaintext), nil)
	tag := seal[len(seal)-16:]
	ciphertext := seal[:len(seal)-16]

	// combined packet: nonce + tag + ciphertext
	combined := append(nonce, append(tag, ciphertext...)...)
	return base64.StdEncoding.EncodeToString(combined), nil
}

func DecryptField(ciphertextB64 string) (string, error) {
	if ciphertextB64 == "" {
		return "", nil
	}
	combined, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return ciphertextB64, err
	}
	if len(combined) < 28 { // 12 bytes nonce + 16 bytes tag
		return ciphertextB64, errors.New("ciphertext too short")
	}

	nonce := combined[:12]
	tag := combined[12:28]
	ciphertext := combined[28:]

	sealInput := append(ciphertext, tag...)

	key := getEncryptionKey()
	block, err := aes.NewCipher(key)
	if err != nil {
		return ciphertextB64, err
	}
	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return ciphertextB64, err
	}

	plaintext, err := aesgcm.Open(nil, nonce, sealInput, nil)
	if err != nil {
		return ciphertextB64, err
	}
	return string(plaintext), nil
}

// PBKDF2 pure Go implementation
func pbkdf2(password, salt []byte, iter, keyLen int) []byte {
	prf := func(p []byte) []byte {
		h := hmac.New(sha256.New, password)
		h.Write(p)
		return h.Sum(nil)
	}
	dk := make([]byte, 0, keyLen)
	block := 1
	for len(dk) < keyLen {
		var U []byte
		var blockBuf [4]byte
		binary.BigEndian.PutUint32(blockBuf[:], uint32(block))
		U = prf(append(salt, blockBuf[:]...))

		T := make([]byte, len(U))
		copy(T, U)
		for i := 2; i <= iter; i++ {
			U = prf(U)
			for j := range T {
				T[j] ^= U[j]
			}
		}
		dk = append(dk, T...)
		block++
	}
	return dk[:keyLen]
}

func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", err
	}
	iterations := 100000
	key := pbkdf2([]byte(password), salt, iterations, 32)

	saltB64 := base64.StdEncoding.EncodeToString(salt)
	keyB64 := base64.StdEncoding.EncodeToString(key)
	return fmt.Sprintf("%d$%s$%s", iterations, saltB64, keyB64), nil
}

func VerifyPassword(password, hashed string) bool {
	parts := strings.Split(hashed, "$")
	if len(parts) != 3 {
		return false
	}
	iterations, err := strconv.Atoi(parts[0])
	if err != nil {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	storedKey, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}

	computedKey := pbkdf2([]byte(password), salt, iterations, 32)
	return hmac.Equal(computedKey, storedKey)
}

// Session Context (Thread-safe)
type SessionContext struct {
	TenantID string
	UserID   string
	Roles    []string
}

var (
	sessionCtx   SessionContext
	sessionCtxMu sync.RWMutex
)

func SetSessionContext(tenantID, userID string, roles []string) {
	sessionCtxMu.Lock()
	defer sessionCtxMu.Unlock()
	sessionCtx = SessionContext{
		TenantID: tenantID,
		UserID:   userID,
		Roles:    roles,
	}
}

func GetSessionContext() SessionContext {
	sessionCtxMu.RLock()
	defer sessionCtxMu.RUnlock()
	return sessionCtx
}

func ClearSessionContext() {
	sessionCtxMu.Lock()
	defer sessionCtxMu.Unlock()
	sessionCtx = SessionContext{}
}

// RLS Injection Hook
func InjectRLS(qb *QueryBuilder) {
	ctx := GetSessionContext()
	if ctx.TenantID != "" {
		qb.Where("tenant_id", "=", ctx.TenantID)
	}
}
