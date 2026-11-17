use super::*;
use std::sync::atomic::Ordering;

fn key(path: &Path, byte: u8) {
    fs::write(path, STANDARD.encode([byte; 32])).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o444)).unwrap();
    }
}

#[test]
fn revisions_are_encrypted_immutable_nonce_unique_and_restartable() {
    let root = tempfile::tempdir().unwrap();
    let master = root.path().join("master");
    let app = root.path().join("app");
    key(&master, 7);
    let vault = EncryptedCredentials::open(&app, &master).unwrap();
    for id in ["first", "second"] {
        vault
            .put_new_revision(id, "SYNTHETIC_ENCRYPTED_CANARY")
            .unwrap();
    }
    let first = fs::read(vault.entry_path("first").unwrap()).unwrap();
    let second = fs::read(vault.entry_path("second").unwrap()).unwrap();
    assert!(!String::from_utf8_lossy(&first).contains("SYNTHETIC_ENCRYPTED_CANARY"));
    let a: Envelope = serde_json::from_slice(&first).unwrap();
    let b: Envelope = serde_json::from_slice(&second).unwrap();
    assert_ne!(a.nonce, b.nonce);
    assert!(vault.put_new_revision("first", "replacement").is_err());
    assert_eq!(fs::read(vault.entry_path("first").unwrap()).unwrap(), first);
    let lease = vault.acquire_scoped_lease("first").unwrap();
    drop(vault);
    let restarted = EncryptedCredentials::open(&app, &master).unwrap();
    assert_eq!(
        restarted.acquire_scoped_lease("first").unwrap().expose(),
        Some("SYNTHETIC_ENCRYPTED_CANARY")
    );
    restarted.delete("first").unwrap();
    restarted.delete("first").unwrap();
    assert!(!restarted.present("first"));
    assert_eq!(lease.expose(), Some("SYNTHETIC_ENCRYPTED_CANARY"));
    assert!(restarted.present("second"));
    assert!(super::super::for_application(&app, None).is_err());
}

#[test]
fn missing_wrong_malformed_master_and_header_never_downgrade_or_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let master = root.path().join("master");
    let app = root.path().join("app");
    assert!(EncryptedCredentials::open(&app, &master).is_err());
    for invalid in [
        "invalid".to_string(),
        STANDARD.encode([1; 31]),
        "a".repeat(129),
    ] {
        fs::write(&master, invalid).unwrap();
        assert!(EncryptedCredentials::open(&app, &master).is_err());
    }
    fs::remove_file(&master).unwrap();
    key(&master, 1);
    let vault = EncryptedCredentials::open(&app, &master).unwrap();
    let header = vault.directory.join(HEADER);
    let original = fs::read(&header).unwrap();
    let wrong = root.path().join("wrong");
    key(&wrong, 2);
    assert!(EncryptedCredentials::open(&app, &wrong).is_err());
    assert_eq!(fs::read(&header).unwrap(), original);
    assert!(super::super::for_application(&app, None).is_err()); // Header-only vault.
    fs::write(&header, b"{}").unwrap();
    assert!(EncryptedCredentials::open(&app, &master).is_err());
    fs::write(&header, original).unwrap();
    vault.put_new_revision("live", "secret").unwrap();
    fs::remove_file(&header).unwrap();
    assert!(EncryptedCredentials::open(&app, &master).is_err());
    assert!(!header.exists());
}

#[test]
fn tamper_and_revision_swaps_only_make_the_affected_entry_unavailable() {
    let root = tempfile::tempdir().unwrap();
    let master = root.path().join("master");
    key(&master, 8);
    let vault = EncryptedCredentials::open(&root.path().join("app"), &master).unwrap();
    vault.put_new_revision("one", "secret-one").unwrap();
    vault.put_new_revision("two", "secret-two").unwrap();
    vault.put_new_revision("good", "secret-good").unwrap();
    let one = vault.entry_path("one").unwrap();
    fs::copy(&one, vault.entry_path("two").unwrap()).unwrap();
    assert!(!vault.present("two"));
    let mut envelope: Envelope = serde_json::from_slice(&fs::read(&one).unwrap()).unwrap();
    let mut bytes = STANDARD.decode(&envelope.ciphertext).unwrap();
    bytes[0] ^= 1;
    envelope.ciphertext = STANDARD.encode(bytes);
    fs::write(&one, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert!(!vault.present("one"));
    assert!(vault.present("good"));
    fs::write(&one, vec![b'x'; MAX_ENVELOPE as usize + 1]).unwrap();
    assert!(!vault.present("one"));
    // Even a revision named "header" containing the exact marker has a distinct
    // authenticated domain and cannot masquerade as the vault header.
    vault
        .put_new_revision("header", std::str::from_utf8(MARKER).unwrap())
        .unwrap();
    fs::copy(
        vault.entry_path("header").unwrap(),
        vault.directory.join(HEADER),
    )
    .unwrap();
    assert!(EncryptedCredentials::open(&root.path().join("app"), &master).is_err());
}

#[test]
fn bounds_and_atomic_failure_leave_no_partial_revision() {
    let root = tempfile::tempdir().unwrap();
    let master = root.path().join("master");
    key(&master, 5);
    let app = root.path().join("app");
    let vault = EncryptedCredentials::open(&app, &master).unwrap();
    for secret in ["".to_owned(), "a\nb".to_owned(), "x".repeat(8193)] {
        assert_eq!(
            vault.put_new_revision("bad", &secret).unwrap_err().0,
            "INVALID_CREDENTIAL"
        );
    }
    vault.put_new_revision("max", &"x".repeat(8192)).unwrap();
    assert!(vault.put_new_revision(&"x".repeat(257), "secret").is_err());
    vault.fail_next_write.store(true, Ordering::SeqCst);
    assert!(
        vault
            .put_new_revision("interrupted", "ATOMIC_SECRET_CANARY")
            .is_err()
    );
    assert!(!vault.present("interrupted"));
    assert_eq!(fs::read_dir(&vault.directory).unwrap().count(), 3); // Header, lock, max.
    vault.put_new_revision("interrupted", "complete").unwrap();
    assert_eq!(
        vault.acquire_scoped_lease("interrupted").unwrap().expose(),
        Some("complete")
    );
}

#[cfg(unix)]
#[test]
fn symlinks_nonregular_files_and_insecure_permissions_are_rejected() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let master = root.path().join("master");
    key(&master, 3);
    let alias = root.path().join("alias");
    symlink(&master, &alias).unwrap();
    let app = root.path().join("app");
    assert!(EncryptedCredentials::open(&app, &alias).is_err());
    assert!(EncryptedCredentials::open(&app, root.path()).is_err());
    fs::set_permissions(&master, fs::Permissions::from_mode(0o666)).unwrap();
    assert!(EncryptedCredentials::open(&app, &master).is_err());
    fs::set_permissions(&master, fs::Permissions::from_mode(0o444)).unwrap();
    let vault = EncryptedCredentials::open(&app, &master).unwrap();
    vault.put_new_revision("one", "secret").unwrap();
    let entry = vault.entry_path("one").unwrap();
    fs::set_permissions(&entry, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!vault.present("one"));
    fs::remove_file(&entry).unwrap();
    symlink(&master, &entry).unwrap();
    assert!(!vault.present("one"));
    assert!(vault.put_new_revision("one", "replacement").is_err());
    fs::set_permissions(&vault.directory, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(EncryptedCredentials::open(&app, &master).is_err());
}

#[test]
fn empty_or_lock_only_initialization_can_recover_but_unknown_files_fail_closed() {
    let root = tempfile::tempdir().unwrap();
    let master = root.path().join("master");
    key(&master, 6);
    let app = root.path().join("app");
    fs::create_dir(&app).unwrap();
    let directory = app.join("credentials-v1");
    private_directory(&directory).unwrap();
    assert!(!has_vault_data(&app).unwrap());
    assert!(super::super::for_application(&app, None).is_ok());
    fs::write(directory.join(".lock"), b"").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.join(".lock"), fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(!has_vault_data(&app).unwrap());
    fs::write(directory.join("unknown"), b"retain me").unwrap();
    assert!(EncryptedCredentials::open(&app, &master).is_err());
    assert!(super::super::for_application(&app, None).is_err());
    fs::remove_file(directory.join("unknown")).unwrap();
    assert!(EncryptedCredentials::open(&app, &master).is_ok());
}

#[test]
fn independent_handles_serialize_initialization_and_immutable_publication() {
    let root = tempfile::tempdir().unwrap();
    let master = root.path().join("master");
    key(&master, 12);
    let app = root.path().join("app");
    let start = std::sync::Arc::new(std::sync::Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|index| {
            let app = app.clone();
            let master = master.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                let vault = EncryptedCredentials::open(&app, &master).unwrap();
                vault
                    .put_new_revision("shared", &format!("secret-{index}"))
                    .is_ok()
            })
        })
        .collect();
    let wins = threads
        .into_iter()
        .map(|thread| usize::from(thread.join().unwrap()))
        .sum::<usize>();
    assert_eq!(wins, 1);
    let vault = EncryptedCredentials::open(&app, &master).unwrap();
    assert!(
        vault
            .acquire_scoped_lease("shared")
            .unwrap()
            .expose()
            .unwrap()
            .starts_with("secret-")
    );
    assert_eq!(fs::read_dir(&vault.directory).unwrap().count(), 3);
}
