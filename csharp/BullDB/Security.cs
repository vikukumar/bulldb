using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace BullDB
{
    public static class SecurityEngine
    {
        private static readonly Regex SqlInjectionRegex = new Regex(
            @"(?i)(UNION\s+SELECT|SELECT\s+.*\s+FROM|INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|UPDATE\s+.*\s+SET|--|/\*|\*/)",
            RegexOptions.Compiled
        );

        private static readonly AsyncLocal<Dictionary<string, object>> ActiveContext = new AsyncLocal<Dictionary<string, object>>();

        public static void ScanSQLInjection(string input)
        {
            if (string.IsNullOrEmpty(input)) return;
            if (SqlInjectionRegex.IsMatch(input))
            {
                throw new InvalidOperationException("malicious SQL input detected");
            }
        }

        public static string SafeSQL(string query)
        {
            ScanSQLInjection(query);
            return query;
        }

        // RLS Registry
        public delegate bool RLSRule(string userId, Dictionary<string, object> row);
        private static readonly Dictionary<string, RLSRule> RlsRules = new Dictionary<string, RLSRule>();

        public static void RegisterRLSRule(string table, RLSRule rule)
        {
            RlsRules[table] = rule;
        }

        public static List<Dictionary<string, object>> ApplyRLSRules(string table, string userId, List<Dictionary<string, object>> rows)
        {
            if (RlsRules.TryGetValue(table, out var rule))
            {
                var filtered = new List<Dictionary<string, object>>();
                foreach (var row in rows)
                {
                    if (rule(userId, row)) filtered.Add(row);
                }
                return filtered;
            }
            return rows;
        }

        // Session Context (Thread-safe AsyncLocal)
        public static void SetSessionContext(string? tenantId, string? userId, string[]? roles = null)
        {
            ActiveContext.Value = new Dictionary<string, object>
            {
                { "tenantId", tenantId ?? "" },
                { "userId", userId ?? "" },
                { "roles", roles ?? Array.Empty<string>() }
            };
        }

        public static Dictionary<string, object> GetSessionContext()
        {
            return ActiveContext.Value ?? new Dictionary<string, object>();
        }

        public static void ClearSessionContext()
        {
            ActiveContext.Value = new Dictionary<string, object>();
        }

        // AES-256-GCM Encryption
        private static byte[]? _customKey;
        private static byte[]? _defaultKey;
        private static readonly object KeyLock = new object();

        public static void SetEncryptionKey(byte[] key)
        {
            lock (KeyLock)
            {
                if (key.Length == 32)
                {
                    _customKey = key;
                }
                else
                {
                    var padded = new byte[32];
                    Buffer.BlockCopy(key, 0, padded, 0, Math.Min(key.Length, 32));
                    _customKey = padded;
                }
            }
        }

        private static byte[] GetEncryptionKey()
        {
            lock (KeyLock)
            {
                if (_customKey != null) return _customKey;
                if (_defaultKey != null) return _defaultKey;

                var keyStr = Environment.GetEnvironmentVariable("BULLDB_ENCRYPTION_KEY");
                if (!string.IsNullOrEmpty(keyStr))
                {
                    using (var sha = SHA256.Create())
                    {
                        _defaultKey = sha.ComputeHash(Encoding.UTF8.GetBytes(keyStr));
                    }
                }
                else
                {
                    _defaultKey = new byte[32];
                    RandomNumberGenerator.Fill(_defaultKey);
                }
                return _defaultKey;
            }
        }

        public static string EncryptField(string plaintext)
        {
            if (string.IsNullOrEmpty(plaintext)) return plaintext;
            var key = GetEncryptionKey();
            var plaintextBytes = Encoding.UTF8.GetBytes(plaintext);

            var nonce = new byte[12];
            RandomNumberGenerator.Fill(nonce);

            var tag = new byte[16];
            var ciphertext = new byte[plaintextBytes.Length];

            using (var aesGcm = new AesGcm(key, 16))
            {
                aesGcm.Encrypt(nonce, plaintextBytes, ciphertext, tag);
            }

            var combined = new byte[12 + 16 + ciphertext.Length];
            Buffer.BlockCopy(nonce, 0, combined, 0, 12);
            Buffer.BlockCopy(tag, 0, combined, 12, 16);
            Buffer.BlockCopy(ciphertext, 0, combined, 28, ciphertext.Length);

            return Convert.ToBase64String(combined);
        }

        public static string DecryptField(string ciphertextB64)
        {
            if (string.IsNullOrEmpty(ciphertextB64)) return ciphertextB64;
            try
            {
                var combined = Convert.FromBase64String(ciphertextB64);
                if (combined.Length < 28) return ciphertextB64;

                var nonce = new byte[12];
                var tag = new byte[16];
                var ciphertext = new byte[combined.Length - 28];

                Buffer.BlockCopy(combined, 0, nonce, 0, 12);
                Buffer.BlockCopy(combined, 12, tag, 0, 16);
                Buffer.BlockCopy(combined, 28, ciphertext, 0, ciphertext.Length);

                var key = GetEncryptionKey();
                var plaintextBytes = new byte[ciphertext.Length];

                using (var aesGcm = new AesGcm(key, 16))
                {
                    aesGcm.Decrypt(nonce, ciphertext, tag, plaintextBytes);
                }

                return Encoding.UTF8.GetString(plaintextBytes);
            }
            catch
            {
                return ciphertextB64;
            }
        }

        // PBKDF2 Password Hashing
        public static string HashPassword(string password)
        {
            var salt = new byte[16];
            RandomNumberGenerator.Fill(salt);
            var iterations = 100000;

            byte[] hash;
            using (var pbkdf2 = new Rfc2898DeriveBytes(password, salt, iterations, HashAlgorithmName.SHA256))
            {
                hash = pbkdf2.GetBytes(32);
            }

            var saltB64 = Convert.ToBase64String(salt);
            var hashB64 = Convert.ToBase64String(hash);
            return $"{iterations}${saltB64}${hashB64}";
        }

        public static bool VerifyPassword(string password, string hashed)
        {
            try
            {
                var parts = hashed.Split('$');
                if (parts.Length != 3) return false;

                var iterations = int.Parse(parts[0]);
                var salt = Convert.FromBase64String(parts[1]);
                var storedHash = Convert.FromBase64String(parts[2]);

                byte[] computedHash;
                using (var pbkdf2 = new Rfc2898DeriveBytes(password, salt, iterations, HashAlgorithmName.SHA256))
                {
                    computedHash = pbkdf2.GetBytes(32);
                }

                return CryptographicOperations.FixedTimeEquals(computedHash, storedHash);
            }
            catch
            {
                return false;
            }
        }

        // RLS QueryBuilder Injection
        public static void InjectRls<T>(QueryBuilder<T> qb) where T : BaseModel, new()
        {
            var ctx = GetSessionContext();
            if (ctx.TryGetValue("tenantId", out var tenantIdVal) && tenantIdVal is string tenantId && !string.IsNullOrEmpty(tenantId))
            {
                qb.Where("tenant_id", "=", tenantId);
            }
        }
    }
}
