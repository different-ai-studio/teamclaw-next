//! AMXC blob envelope — client-side AES-256-GCM encryption for OSS blobs.
//!
//! Wire layout (spec §3.-1):
//!   offset  0: "AMXC" (4 bytes magic)
//!   offset  4: version u8 = 1
//!   offset  5: nonce[12] (random)
//!   offset 17: ciphertext (AES-GCM encrypted plaintext, tag appended by aes-gcm crate)
//!   offset 17+N: AES-GCM tag (16 bytes, included in ciphertext slice by aes-gcm)
//!
//! `content_hash` (on the wire) = sha256(blob bytes).
//! `plain_hash`   (local only)  = sha256(plaintext).

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use sha2::{Digest, Sha256};

const MAGIC: &[u8; 4] = b"AMXC";
const VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = 4 + 1 + NONCE_LEN; // 17

/// Encrypt plaintext into an AMXC blob using the given 32-byte key.
/// Returns the raw blob bytes.
pub fn encrypt_blob(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce_bytes)
        .map_err(|e| format!("crypto: nonce generation failed: {e}"))?;

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("crypto: cipher init failed: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("crypto: AES-GCM encrypt failed: {e}"))?;

    let mut blob = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    blob.extend_from_slice(MAGIC);
    blob.push(VERSION);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Decrypt an AMXC blob, returning plaintext.
pub fn decrypt_blob(blob: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if blob.len() < HEADER_LEN {
        return Err(format!(
            "crypto: blob too short: {} bytes (need at least {})",
            blob.len(),
            HEADER_LEN
        ));
    }
    if &blob[..4] != MAGIC {
        return Err(format!(
            "crypto: invalid magic: expected AMXC, got {:?}",
            &blob[..4]
        ));
    }
    if blob[4] != VERSION {
        return Err(format!(
            "crypto: unsupported version: expected {}, got {}",
            VERSION, blob[4]
        ));
    }
    let nonce_bytes = &blob[5..17];
    let ciphertext = &blob[HEADER_LEN..];

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("crypto: cipher init failed: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("crypto: AES-GCM decrypt failed: {e}"))
}

/// sha256(bytes) → hex string
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team_shared_env::derive_key;

    fn test_key() -> [u8; 32] {
        derive_key("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20")
            .expect("derive_key failed")
    }

    #[test]
    fn test_roundtrip() {
        let key = test_key();
        let plaintext = b"hello OSS sync world";
        let blob = encrypt_blob(plaintext, &key).expect("encrypt failed");
        assert!(blob.starts_with(b"AMXC"));
        assert_eq!(blob[4], 1);
        let decrypted = decrypt_blob(&blob, &key).expect("decrypt failed");
        assert_eq!(&decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails() {
        let key = test_key();
        let wrong_key =
            derive_key("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff").unwrap();
        let blob = encrypt_blob(b"secret", &key).unwrap();
        assert!(decrypt_blob(&blob, &wrong_key).is_err());
    }

    #[test]
    fn test_magic_mismatch_fails() {
        let key = test_key();
        let mut blob = encrypt_blob(b"data", &key).unwrap();
        blob[0] = b'X'; // corrupt magic
        assert!(decrypt_blob(&blob, &key).is_err());
    }

    #[test]
    fn test_version_mismatch_fails() {
        let key = test_key();
        let mut blob = encrypt_blob(b"data", &key).unwrap();
        blob[4] = 99; // unsupported version
        assert!(decrypt_blob(&blob, &key).is_err());
    }

    #[test]
    fn test_too_short_fails() {
        let key = test_key();
        let short = b"AMXC\x01";
        assert!(decrypt_blob(short, &key).is_err());
    }

    #[test]
    fn test_sha256_hex() {
        // SHA-256 of empty string
        let h = sha256_hex(b"");
        assert_eq!(
            h,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_content_hash_matches_blob_sha256() {
        let key = test_key();
        let plaintext = b"test content";
        let blob = encrypt_blob(plaintext, &key).unwrap();
        let cipher_hash = sha256_hex(&blob);
        let plain_hash = sha256_hex(plaintext);
        // They must differ (encrypted != plaintext)
        assert_ne!(cipher_hash, plain_hash);
        // Decrypt and verify
        let decrypted = decrypt_blob(&blob, &key).unwrap();
        assert_eq!(sha256_hex(&decrypted), plain_hash);
    }
}
