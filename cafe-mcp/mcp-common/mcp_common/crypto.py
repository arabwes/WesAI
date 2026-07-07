"""Fernet encryption for tenant credentials, with key versioning.

TENANT_MASTER_KEY holds one or more Fernet keys as "key_id:fernet_key" pairs
separated by commas, e.g.:

    TENANT_MASTER_KEY="v2:xxxx...,v1:yyyy..."

The FIRST entry is used for new encryptions; all entries can decrypt.
Ciphertext is stored as b"<key_id>$<fernet_token>" so rotation is:
add a new key at the front, run the re-encrypt script, remove the old key.
"""
from __future__ import annotations

import os

from cryptography.fernet import Fernet, InvalidToken


class CryptoError(Exception):
    pass


def _load_keys(raw: str | None = None) -> dict[str, Fernet]:
    raw = raw if raw is not None else os.getenv("TENANT_MASTER_KEY", "")
    keys: dict[str, Fernet] = {}
    for entry in filter(None, (p.strip() for p in raw.split(","))):
        if ":" not in entry:
            raise CryptoError("TENANT_MASTER_KEY entries must be 'key_id:fernet_key'")
        key_id, key = entry.split(":", 1)
        keys[key_id] = Fernet(key.encode())
    return keys


class CredentialCipher:
    def __init__(self, raw_keys: str | None = None):
        self._keys = _load_keys(raw_keys)
        if not self._keys:
            raise CryptoError("TENANT_MASTER_KEY is not set")
        self.primary_key_id = next(iter(self._keys))

    def encrypt(self, plaintext: bytes) -> tuple[str, bytes]:
        """Returns (key_id, ciphertext)."""
        token = self._keys[self.primary_key_id].encrypt(plaintext)
        return self.primary_key_id, token

    def decrypt(self, key_id: str, ciphertext: bytes) -> bytes:
        fernet = self._keys.get(key_id)
        if fernet is None:
            raise CryptoError(f"No master key loaded for key_id '{key_id}'")
        try:
            return fernet.decrypt(ciphertext)
        except InvalidToken as e:
            raise CryptoError(f"Decryption failed for key_id '{key_id}'") from e


def generate_master_key(key_id: str = "v1") -> str:
    """Helper for ops: mint a TENANT_MASTER_KEY entry."""
    return f"{key_id}:{Fernet.generate_key().decode()}"
