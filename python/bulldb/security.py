import os
import base64
import hashlib
from typing import Any, Dict, Optional
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

class SecurityEngine:
    _key: Optional[bytes] = None
    _active_context: Dict[str, Any] = {}

    @classmethod
    def set_encryption_key(cls, key: bytes):
        if len(key) >= 32:
            cls._key = key[:32]
        else:
            cls._key = key.ljust(32, b"\x00")

    @classmethod
    def get_encryption_key(cls) -> bytes:
        if cls._key is None:
            key_str = os.getenv("BULLDB_ENCRYPTION_KEY")
            if key_str:
                # pad or digest to 32 bytes
                cls._key = hashlib.sha256(key_str.encode()).digest()
            else:
                # generate standard fallback key
                cls._key = AESGCM.generate_key(bit_length=256)
        return cls._key

    @classmethod
    def encrypt_field(cls, plaintext: str) -> str:
        if not plaintext:
            return plaintext
        key = cls.get_encryption_key()
        aesgcm = AESGCM(key)
        nonce = os.urandom(12)
        encrypted_bytes = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
        # combined packet: nonce (12b) + tag (16b) + ciphertext
        tag = encrypted_bytes[-16:]
        ciphertext = encrypted_bytes[:-16]
        combined = nonce + tag + ciphertext
        return base64.b64encode(combined).decode("utf-8")

    @classmethod
    def decrypt_field(cls, ciphertext: str) -> str:
        if not ciphertext:
            return ciphertext
        try:
            combined = base64.b64decode(ciphertext.encode("utf-8"))
            if len(combined) < 28:
                return ciphertext
            nonce = combined[:12]
            tag = combined[12:28]
            actual_ciphertext = combined[28:]
            
            key = cls.get_encryption_key()
            aesgcm = AESGCM(key)
            # cryptography AESGCM.decrypt expects ciphertext + tag
            encrypted_bytes = actual_ciphertext + tag
            decrypted = aesgcm.decrypt(nonce, encrypted_bytes, None)
            return decrypted.decode("utf-8")
        except Exception:
            return ciphertext # return original if decryption fails or format mismatch

    @classmethod
    def hash_password(cls, password: str) -> str:
        # standard SHA-256 with salt PBKDF2 hash
        salt = os.urandom(16)
        iterations = 100000
        key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        # format: iterations$salt$hash
        salt_b64 = base64.b64encode(salt).decode("utf-8")
        key_b64 = base64.b64encode(key).decode("utf-8")
        return f"{iterations}${salt_b64}${key_b64}"

    @classmethod
    def verify_password(cls, password: str, hashed: str) -> bool:
        try:
            parts = hashed.split("$")
            if len(parts) != 3:
                return False
            iterations = int(parts[0])
            salt = base64.b64decode(parts[1].encode("utf-8"))
            stored_key = base64.b64decode(parts[2].encode("utf-8"))
            computed_key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
            return computed_key == stored_key
        except Exception:
            return False

    @classmethod
    def set_session_context(cls, tenant_id: Optional[str] = None, user_id: Optional[str] = None, roles: Optional[list] = None):
        cls._active_context = {
            "tenant_id": tenant_id,
            "user_id": user_id,
            "roles": roles or []
        }

    @classmethod
    def get_session_context(cls) -> Dict[str, Any]:
        return cls._active_context

    @classmethod
    def clear_session_context(cls):
        cls._active_context = {}

    @classmethod
    def inject_rls(cls, ast: Any):
        # Injects RLS constraints (e.g. tenant_id match) into the Query AST before execution
        context = cls.get_session_context()
        tenant_id = context.get("tenant_id")
        if tenant_id:
            # We construct a RLS filter check node
            from .query import BinaryOpNode, ColumnNode, ValueNode
            rls_filter = BinaryOpNode(ColumnNode("tenant_id"), "=", ValueNode(tenant_id))
            if ast.filters:
                ast.filters = BinaryOpNode(ast.filters, "AND", rls_filter)
            else:
                ast.filters = rls_filter
