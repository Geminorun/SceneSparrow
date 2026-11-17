//! Versioned encrypted credential revisions. Settings owns inventory and retirement.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use atomic_write_file::AtomicWriteFile;
use base64::{Engine, engine::general_purpose::STANDARD};
use scenesparrow_application::ai::{CredentialLease, CredentialStore};
use scenesparrow_domain::{
    ai::{AiError, Result, ensure},
    contracts::AiSettingsViewCredentialBackend,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const CONTEXT: &str = "scenesparrow.ai.credentials.v1";
const HEADER: &str = "header.json";
const MARKER: &[u8] = b"scenesparrow authenticated credential vault v1";
const MAX_ENVELOPE: u64 = 32 * 1024;

fn available<T>(result: std::result::Result<T, impl std::fmt::Debug>) -> Result<T> {
    result.map_err(|_| AiError("CREDENTIAL_UNAVAILABLE"))
}

pub struct EncryptedCredentials {
    directory: PathBuf,
    cipher: Aes256Gcm,
    #[cfg(test)]
    fail_next_write: std::sync::atomic::AtomicBool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    nonce: String,
    ciphertext: String,
}

/// A lock-only directory can remain after interrupted first initialization.
pub fn has_vault_data(app_data: &Path) -> Result<bool> {
    let path = app_data.join("credentials-v1");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        other => {
            let metadata = available(other)?;
            ensure(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "CREDENTIAL_UNAVAILABLE",
            )?;
            for entry in available(fs::read_dir(path))? {
                if available(entry)?.file_name() != ".lock" {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}

fn no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
}

fn read_regular(path: &Path, bound: u64, private: bool) -> Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true);
    no_follow(&mut options);
    let mut file = available(options.open(path))?;
    let metadata = available(file.metadata())?;
    ensure(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= bound,
        "CREDENTIAL_UNAVAILABLE",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let forbidden = if private { 0o077 } else { 0o022 };
        ensure(
            metadata.permissions().mode() & forbidden == 0,
            "CREDENTIAL_UNAVAILABLE",
        )?;
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut bytes = Vec::new();
    available((&mut file).take(bound + 1).read_to_end(&mut bytes))?;
    ensure(bytes.len() as u64 <= bound, "CREDENTIAL_UNAVAILABLE")?;
    Ok(bytes)
}

fn private_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(path) {
                Ok(()) => {
                    // Persist the newly published vault directory entry once;
                    // ordinary reads/locks do not sync the app-data parent.
                    #[cfg(unix)]
                    available(
                        available(File::open(
                            path.parent().ok_or(AiError("CREDENTIAL_UNAVAILABLE"))?,
                        ))?
                        .sync_all(),
                    )?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return available(Err(error)),
            }
        }
        other => {
            available(other)?;
        }
    }
    let metadata = available(fs::symlink_metadata(path))?;
    ensure(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "CREDENTIAL_UNAVAILABLE",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure(
            metadata.permissions().mode() & 0o077 == 0,
            "CREDENTIAL_UNAVAILABLE",
        )?;
    }
    Ok(())
}

impl EncryptedCredentials {
    pub fn open(app_data: &Path, master_key_file: &Path) -> Result<Self> {
        let mut encoded = read_regular(master_key_file, 128, false)?;
        let mut key = available(STANDARD.decode(encoded.trim_ascii()))?;
        encoded.fill(0);
        ensure(key.len() == 32, "CREDENTIAL_UNAVAILABLE")?;
        let cipher = available(Aes256Gcm::new_from_slice(&key))?;
        key.fill(0);
        available(fs::create_dir_all(app_data))?;
        let metadata = available(fs::symlink_metadata(app_data))?;
        ensure(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        let store = Self {
            directory: app_data.join("credentials-v1"),
            cipher,
            #[cfg(test)]
            fail_next_write: std::sync::atomic::AtomicBool::new(false),
        };
        private_directory(&store.directory)?;
        let _lock = store.lock()?;
        let header = store.directory.join(HEADER);
        match fs::symlink_metadata(&header) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ensure(!has_vault_data(app_data)?, "CREDENTIAL_UNAVAILABLE")?;
                store.write_envelope(&header, "header", MARKER)?;
            }
            other => {
                available(other)?;
                ensure(
                    store.decrypt(&header, "header")? == MARKER,
                    "CREDENTIAL_UNAVAILABLE",
                )?;
            }
        }
        Ok(store)
    }
    fn lock(&self) -> Result<File> {
        private_directory(&self.directory)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        no_follow(&mut options);
        let file = available(options.open(self.directory.join(".lock")))?;
        let metadata = available(file.metadata())?;
        ensure(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure(
                metadata.permissions().mode() & 0o077 == 0,
                "CREDENTIAL_UNAVAILABLE",
            )?;
        }
        available(file.lock())?;
        Ok(file)
    }
    fn entry_path(&self, revision: &str) -> Result<PathBuf> {
        ensure(
            !revision.is_empty()
                && revision.len() <= 256
                && !revision.chars().any(char::is_control),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        Ok(self
            .directory
            .join(format!("{:x}.json", Sha256::digest(revision.as_bytes()))))
    }
    fn aad(identity: &str) -> Vec<u8> {
        format!("{CONTEXT}\0{identity}").into_bytes()
    }
    fn write_envelope(&self, path: &Path, identity: &str, plaintext: &[u8]) -> Result<()> {
        let mut nonce = [0u8; 12];
        available(getrandom::fill(&mut nonce))?;
        let ciphertext = available(self.cipher.encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &Self::aad(identity),
            },
        ))?;
        let bytes = available(serde_json::to_vec(&Envelope {
            version: 1,
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        }))?;
        ensure(bytes.len() as u64 <= MAX_ENVELOPE, "CREDENTIAL_UNAVAILABLE")?;
        let mut file = available(AtomicWriteFile::open(path))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            available(
                file.as_file()
                    .set_permissions(fs::Permissions::from_mode(0o600)),
            )?;
        }
        available(file.write_all(&bytes))?;
        available(file.as_file().sync_all())?;
        #[cfg(test)]
        if self
            .fail_next_write
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(AiError("CREDENTIAL_UNAVAILABLE"));
        }
        available(file.commit())?;
        self.sync_directory()
    }
    fn sync_directory(&self) -> Result<()> {
        #[cfg(unix)]
        available(available(File::open(&self.directory))?.sync_all())?;
        Ok(())
    }
    fn decrypt(&self, path: &Path, identity: &str) -> Result<Vec<u8>> {
        let envelope: Envelope = available(serde_json::from_slice(&read_regular(
            path,
            MAX_ENVELOPE,
            true,
        )?))?;
        ensure(envelope.version == 1, "CREDENTIAL_UNAVAILABLE")?;
        let nonce = available(STANDARD.decode(&envelope.nonce))?;
        ensure(nonce.len() == 12, "CREDENTIAL_UNAVAILABLE")?;
        let ciphertext = available(STANDARD.decode(&envelope.ciphertext))?;
        available(self.cipher.decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &Self::aad(identity),
            },
        ))
    }
}

impl CredentialStore for EncryptedCredentials {
    fn put_new_revision(&self, revision: &str, secret: &str) -> Result<()> {
        ensure(
            !secret.is_empty() && secret.len() <= 8192 && !secret.chars().any(char::is_control),
            "INVALID_CREDENTIAL",
        )?;
        let path = self.entry_path(revision)?;
        let _lock = self.lock()?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(AiError("CREDENTIAL_UNAVAILABLE")),
        }
        self.write_envelope(&path, &format!("entry\0{revision}"), secret.as_bytes())
    }
    fn acquire_scoped_lease(&self, revision: &str) -> Result<CredentialLease> {
        let path = self.entry_path(revision)?;
        let _lock = self.lock()?;
        let secret = available(String::from_utf8(
            self.decrypt(&path, &format!("entry\0{revision}"))?,
        ))?;
        ensure(
            !secret.is_empty() && secret.len() <= 8192 && !secret.chars().any(char::is_control),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        Ok(CredentialLease::new(Some(secret)))
    }
    fn delete(&self, revision: &str) -> Result<()> {
        let path = self.entry_path(revision)?;
        let _lock = self.lock()?;
        match fs::remove_file(path) {
            Ok(()) => self.sync_directory(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => available(Err(error)),
        }
    }
    fn present(&self, revision: &str) -> bool {
        self.acquire_scoped_lease(revision).is_ok()
    }
    fn persistent(&self) -> bool {
        true
    }
    fn backend_kind(&self) -> AiSettingsViewCredentialBackend {
        AiSettingsViewCredentialBackend::Encryptedfile
    }
}

#[cfg(test)]
mod tests;
