use super::*;
use scenesparrow_application::ProjectRepository;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn setup() -> (
    tempfile::TempDir,
    PathBuf,
    SqliteProjectRepository,
    ProjectTransferStore,
) {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("source");
    let r = SqliteProjectRepository::create_format(&root).unwrap();

    std::fs::create_dir_all(root.join("public")).unwrap();
    std::fs::write(root.join("public/silence.bin"), vec![0; 2 << 20]).unwrap();
    for (path, bytes) in [
        (
            "package.json",
            b"{\"scripts\":{\"render\":\"remotion render\"}}".as_slice(),
        ),
        ("pnpm-lock.yaml", b"lockfileVersion: 9\n"),
        ("src/Root.tsx", b"export const Root=()=>null;"),
        ("references/notes.txt", b"retained creative reference"),
        ("captions/captions.vtt", b"WEBVTT\n"),
        ("public/fonts/fixture.bin", b"licensed test bytes"),
        ("cache/audio.wav", b"ordinary creative cache-named media"),
        ("AGENTS.md", b"Untrusted project instructions are data."),
        (".env", b"MUST_NOT_PACKAGE=secret"),
        (".git/config", b"private git config"),
        ("node_modules/private.txt", b"dependency cache"),
        ("output/process.pid", b"12345"),
    ] {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, bytes).unwrap();
    }
    r.register_file_graph().unwrap();
    let p = r.read().unwrap().unwrap();
    r.rename(&id(), &p.id, &p.title, "Package test").unwrap();
    let s = ProjectTransferStore::open(&d.path().join("app")).unwrap();
    (d, root, r, s)
}
#[test]
fn package_export_fixed_capture_and_roundtrip() {
    let (_d, root, r, s) = setup();
    let before = r.read_package_base().unwrap();
    let req = ProjectPackageExportRequest {
        request_id: id(),
        base: before.clone(),
    };
    s.start_package_export(&r, &req).unwrap();
    r.rename(&id(), &before.project_id, "Package test", "Later name")
        .unwrap();
    assert!(s.run_next(&r).unwrap());
    let v = s.package_status(&r, &req.request_id).unwrap();
    assert_eq!(v.state, PackageOperationViewState::Succeeded, "{:?}", v);
    let bytes = std::fs::read(s.directory.join(format!("archive-{}.zip", req.request_id))).unwrap();
    let archive = v.archive.unwrap();
    let z = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    let names = z.file_names().collect::<Vec<_>>();
    for path in [
        "package.json",
        "pnpm-lock.yaml",
        "src/Root.tsx",
        "references/notes.txt",
        "captions/captions.vtt",
        "public/fonts/fixture.bin",
        "cache/audio.wav",
        "AGENTS.md",
    ] {
        assert!(names.contains(&path), "{path}");
    }
    assert!(!names.iter().any(|p| p.contains(".env")
        || p.contains("node_modules")
        || p.contains(".git/")
        || p.contains("output/")
        || p.ends_with("-wal")
        || p.ends_with("-shm")
        || p.contains(".core.lock")
        || p.contains("staging/")));

    let intake = s
        .create_package_intake(
            &r,
            &PackageIntakeRequest {
                request_id: id(),
                owner_project_id: before.project_id.clone(),
                filename: "project.zip".into(),
                length: bytes.len() as i64,
                hash: hash(&bytes),
            },
        )
        .unwrap();
    for (offset, b) in bytes.chunks(MAX_CHUNK).enumerate() {
        s.write_package_chunk(
            &r,
            &PackageChunkRequest {
                owner_project_id: before.project_id.clone(),
                intake_id: intake.intake_id.clone(),
                offset: (offset * MAX_CHUNK) as i64,
                length: b.len() as i64,
                hash: hash(b),
            },
            b,
        )
        .unwrap();
    }
    let inspect = PackageInspectionRequest {
        request_id: id(),
        owner_project_id: before.project_id.clone(),
        intake_id: intake.intake_id,
    };
    s.start_package_inspection(&r, &inspect).unwrap();
    s.run_next(&r).unwrap();
    let view = s.package_status(&r, &inspect.request_id).unwrap();
    assert_eq!(view.state, PackageOperationViewState::Succeeded, "{view:?}");
    assert!(view.inspection.unwrap().verified_restore);
    let target = s
        .issue_package_restore_target(
            &r,
            &PackageRestoreTargetRequest {
                request_id: id(),
                owner_project_id: before.project_id.clone(),
                inspection_id: inspect.request_id.clone(),
                destination: PackageRestoreTargetRequestDestination::Managed,
            },
        )
        .unwrap();
    let restore = PackageRestoreRequest {
        request_id: id(),
        owner_project_id: before.project_id.clone(),
        inspection_id: inspect.request_id,
        target_id: target.target_id.clone(),
    };
    s.start_package_restore(&r, &restore).unwrap();
    s.run_next(&r).unwrap();
    let result = s.package_status(&r, &restore.request_id).unwrap();
    assert_eq!(
        result.state,
        PackageOperationViewState::Succeeded,
        "{result:?}"
    );
    let restored = SqliteProjectRepository::open_format(&s.roots.join(&target.target_id)).unwrap();
    assert_eq!(restored.read().unwrap().unwrap().title, "Package test");
    assert_eq!(r.read().unwrap().unwrap().title, "Later name");
    assert_eq!(restored.read_package_base().unwrap(), before);
    assert_eq!(
        std::fs::metadata(root.join("public/silence.bin"))
            .unwrap()
            .len(),
        2 << 20
    );
    assert_eq!(archive.size, bytes.len() as i64);
    assert!(s.start_package_export(&r, &req).is_ok());
}
fn export(r: &SqliteProjectRepository, s: &ProjectTransferStore) -> (String, Vec<u8>) {
    let req = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    s.start_package_export(r, &req).unwrap();
    s.run_next(r).unwrap();
    let view = s.package_status(r, &req.request_id).unwrap();
    assert_eq!(view.state, PackageOperationViewState::Succeeded, "{view:?}");
    let bytes = std::fs::read(s.directory.join(format!("archive-{}.zip", req.request_id))).unwrap();
    (req.request_id, bytes)
}
fn upload(
    r: &SqliteProjectRepository,
    s: &ProjectTransferStore,
    bytes: &[u8],
) -> PackageInspectionRequest {
    let owner = r.read().unwrap().unwrap().id;
    let intake = s
        .create_package_intake(
            r,
            &PackageIntakeRequest {
                request_id: id(),
                owner_project_id: owner.clone(),
                filename: "fixture.zip".into(),
                length: bytes.len() as i64,
                hash: hash(bytes),
            },
        )
        .unwrap();
    for (i, b) in bytes.chunks(MAX_CHUNK).enumerate() {
        s.write_package_chunk(
            r,
            &PackageChunkRequest {
                owner_project_id: owner.clone(),
                intake_id: intake.intake_id.clone(),
                offset: (i * MAX_CHUNK) as i64,
                length: b.len() as i64,
                hash: hash(b),
            },
            b,
        )
        .unwrap();
    }
    PackageInspectionRequest {
        request_id: id(),
        owner_project_id: owner,
        intake_id: intake.intake_id,
    }
}
fn inspect(
    r: &SqliteProjectRepository,
    s: &ProjectTransferStore,
    bytes: &[u8],
) -> PackageInspectionView {
    let request = upload(r, s, bytes);
    s.start_package_inspection(r, &request).unwrap();
    s.run_next(r).unwrap();
    let status = s.package_status(r, &request.request_id).unwrap();
    assert_eq!(
        status.state,
        PackageOperationViewState::Succeeded,
        "{status:?}"
    );
    status.inspection.unwrap()
}
fn whole() -> CreativeGrant {
    CreativeGrant {
        whole_tree: true,
        files: vec![],
        directories: vec![],
        manuscript_scope: CreativeGrantManuscriptScope {
            kind: CreativeGrantManuscriptScopeKind::All,
            block_ids: vec![],
        },
    }
}
fn copy(r: &SqliteProjectRepository) -> WorkItemView {
    let b = r.read_package_base().unwrap();
    let v = r
        .create_work_item(&WorkItemCreateRequest {
            request_id: id(),
            project_id: b.project_id,
            expected_working_revision: b.working_revision,
            expected_graph_hash: b.graph_hash,
            expected_graph_generation: b.graph_generation,
            origin: WorkItemCreateRequestOrigin::Copy,
            grant: whole(),
            reference_ids: vec![],
        })
        .unwrap();
    r.run_next_work_operation().unwrap();
    r.work_item(&v.item.unwrap().work_item_id).unwrap()
}
fn edit_zip(bytes: &[u8], path: &str, content: &[u8]) -> Vec<u8> {
    let mut input = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut output = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
    for i in 0..input.len() {
        let mut f = input.by_index(i).unwrap();
        let name = f.name().to_string();
        let mut body = vec![];
        f.read_to_end(&mut body).unwrap();
        output
            .start_file(
                &name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        output
            .write_all(if name == path { content } else { &body })
            .unwrap();
    }
    output.finish().unwrap().into_inner()
}
#[test]
fn package_chunks_replay_stable_end_reconcile_flush_and_never_append_old_ranges() {
    let (_d, _root, r, s) = setup();
    let owner = r.read().unwrap().unwrap().id;
    let req = PackageIntakeRequest {
        request_id: id(),
        owner_project_id: owner.clone(),
        filename: "chunks.zip".into(),
        length: 12,
        hash: hash(b"aaaabbbbcccc"),
    };
    let intake = s.create_package_intake(&r, &req).unwrap();
    let a = PackageChunkRequest {
        owner_project_id: owner.clone(),
        intake_id: intake.intake_id.clone(),
        offset: 0,
        length: 4,
        hash: hash(b"aaaa"),
    };
    *s.fault.lock().unwrap() = Some("package-chunk-flush");
    assert_eq!(
        s.write_package_chunk(&r, &a, b"aaaa").unwrap_err().0,
        "TEST_CUT"
    );
    let ack = s.write_package_chunk(&r, &a, b"aaaa").unwrap();
    let b = PackageChunkRequest {
        offset: 4,
        hash: hash(b"bbbb"),
        ..a.clone()
    };
    s.write_package_chunk(&r, &b, b"bbbb").unwrap();
    assert_eq!(s.write_package_chunk(&r, &a, b"aaaa").unwrap(), ack);
    assert_eq!(ack.acknowledged_end, 4);
    let changed = PackageChunkRequest {
        hash: hash(b"zzzz"),
        ..a.clone()
    };
    assert_eq!(
        s.write_package_chunk(&r, &changed, b"zzzz").unwrap_err().0,
        "PACKAGE_CHUNK_CONFLICT"
    );
    assert_eq!(
        s.package_intake(&r, &intake.intake_id)
            .unwrap()
            .received_bytes,
        8
    );
    assert_eq!(
        std::fs::metadata(s.directory.join(format!("intake-{}.zip", intake.intake_id)))
            .unwrap()
            .len(),
        8
    );
    let i = PackageInspectionRequest {
        request_id: id(),
        owner_project_id: owner,
        intake_id: intake.intake_id,
    };
    assert_eq!(
        s.start_package_inspection(&r, &i).unwrap_err().0,
        "PACKAGE_INTAKE_INCOMPLETE"
    );
    assert_eq!(
        s.start_package_inspection(&r, &i).unwrap_err().0,
        "PACKAGE_INTAKE_INCOMPLETE"
    );
}
#[test]
fn package_durable_rejections_preserve_codes_and_changed_dto_conflicts() {
    let (_d, _root, r, s) = setup();
    let mut request = PackageIntakeRequest {
        request_id: id(),
        owner_project_id: id(),
        filename: "fixture.zip".into(),
        length: 1,
        hash: hash(b"x"),
    };
    for _ in 0..2 {
        assert_eq!(
            s.create_package_intake(&r, &request).unwrap_err().0,
            "PROJECT_NOT_FOUND"
        );
    }
    request.owner_project_id = r.read().unwrap().unwrap().id;
    assert_eq!(
        s.create_package_intake(&r, &request).unwrap_err().0,
        "PACKAGE_REQUEST_CONFLICT"
    );
    let request = PackageIntakeRequest {
        request_id: id(),
        filename: "../bad.zip".into(),
        ..request
    };
    for _ in 0..2 {
        assert_eq!(
            s.create_package_intake(&r, &request).unwrap_err().0,
            "INVALID_REQUEST"
        );
    }
    let mut export = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    export.base.graph_generation += 1;
    for _ in 0..2 {
        assert_eq!(
            s.start_package_export(&r, &export).unwrap_err().0,
            "PACKAGE_BASE_MISMATCH"
        );
    }
}
#[test]
fn package_original_capture_and_archive_promotion_recover_across_restart() {
    for point in [
        "package-capture",
        "package-archive-promoted",
        "package-result",
    ] {
        let (d, _root, r, s) = setup();
        let req = ProjectPackageExportRequest {
            request_id: id(),
            base: r.read_package_base().unwrap(),
        };
        if point == "package-capture" {
            *s.fault.lock().unwrap() = Some(point);
            assert_eq!(s.start_package_export(&r, &req).unwrap_err().0, "TEST_CUT");
        } else {
            s.start_package_export(&r, &req).unwrap();
            *s.fault.lock().unwrap() = Some(point);
            if point == "package-archive-promoted" {
                s.run_next(&r).unwrap();
            } else {
                assert_eq!(s.run_next(&r).unwrap_err().0, "TEST_CUT");
            }
        }
        drop(s);
        let s = ProjectTransferStore::open(&d.path().join("app")).unwrap();
        let status = s.package_status(&r, &req.request_id).unwrap();
        if point == "package-capture" {
            assert_eq!(status.state, PackageOperationViewState::Interrupted);
            r.rename(&id(), &req.base.project_id, "Package test", "Newer edit")
                .unwrap();
            s.start_package_export(&r, &req).unwrap();
            s.control_package(
                &r,
                &PackageControlRequest {
                    request_id: id(),
                    owner_project_id: req.base.project_id.clone(),
                    operation_id: req.request_id.clone(),
                    expected_operation_revision: status.operation_revision,
                    action: PackageControlRequestAction::Retry,
                },
            )
            .unwrap();
            s.run_next(&r).unwrap();
        }
        let view = s.package_status(&r, &req.request_id).unwrap();
        assert_eq!(
            view.state,
            PackageOperationViewState::Succeeded,
            "{point}: {view:?}"
        );
        let mut out = vec![];
        s.read_package_archive(&r, &req.request_id)
            .unwrap()
            .stream(&mut out)
            .unwrap();
        assert!(!out.is_empty());
    }
}
#[test]
fn package_incomplete_capture_requires_explicit_original_base_retry_without_residual_deletion() {
    let (d, _root, r, s) = setup();
    let request = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    *s.fault.lock().unwrap() = Some("package-pending");
    assert_eq!(
        s.start_package_export(&r, &request).unwrap_err().0,
        "TEST_CUT"
    );
    drop(s);
    let s = ProjectTransferStore::open(&d.path().join("app")).unwrap();
    assert_eq!(
        s.start_package_export(&r, &request).unwrap_err().0,
        "PACKAGE_INTERRUPTED"
    );
    let status = s.package_status(&r, &request.request_id).unwrap();
    s.control_package(
        &r,
        &PackageControlRequest {
            request_id: id(),
            owner_project_id: request.base.project_id.clone(),
            operation_id: request.request_id.clone(),
            expected_operation_revision: status.operation_revision,
            action: PackageControlRequestAction::Retry,
        },
    )
    .unwrap();
    s.run_next(&r).unwrap();
    assert_eq!(
        s.package_status(&r, &request.request_id).unwrap().state,
        PackageOperationViewState::Succeeded
    );
}
#[test]
fn package_complete_return_uses_actual_grant_candidate_and_one_history() {
    let (_d, _root, r, s) = setup();
    let (_, bytes) = export(&r, &s);
    let edited = edit_zip(&bytes, "public/silence.bin", b"returned media");
    let inspection = inspect(&r, &s, &edited);
    assert!(!inspection.verified_restore);
    assert!(inspection.trusted_return);
    let before = r.read_package_base().unwrap();
    let request = PackageReturnRequest {
        request_id: id(),
        owner_project_id: before.project_id.clone(),
        inspection_id: inspection.inspection_id,
        work_item_id: None,
        grant: Some(whole()),
    };
    s.start_package_return(&r, &request).unwrap();
    s.run_next(&r).unwrap();
    let status = s.package_status(&r, &request.request_id).unwrap();
    assert_eq!(
        status.state,
        PackageOperationViewState::Succeeded,
        "{status:?}"
    );
    let candidate = status.candidate.unwrap();
    let c = r.connection.lock().unwrap();
    let item_id: String = c
        .query_row(
            "SELECT item_id FROM work_candidates WHERE id=?1",
            [&candidate.candidate_id],
            |r| r.get(0),
        )
        .unwrap();
    drop(c);
    let item = r.work_item(&item_id).unwrap();
    let accept = WorkCandidateAcceptRequest {
        request_id: id(),
        project_id: before.project_id.clone(),
        expected_working_revision: candidate.inspected_working_revision,
        expected_graph_hash: before.graph_hash.clone(),
        expected_graph_generation: candidate.inspected_graph_generation,
        work_item_id: item_id,
        candidate_id: candidate.candidate_id,
        candidate_digest: candidate.candidate_digest,
        expected_item_revision: item.item_revision,
    };
    let outcome = r.accept_work_candidate(&accept).unwrap();
    assert_eq!(
        r.accept_work_candidate(&accept).unwrap().receipt,
        outcome.receipt
    );
    assert_eq!(
        r.read_package_base().unwrap().working_revision,
        before.working_revision + 1
    );
    let undo=serde_json::from_value(serde_json::json!({"type":"UndoProject","requestId":id(),"projectId":before.project_id,"expectedWorkingRevision":r.read_package_base().unwrap().working_revision,"expectedHistoryRevision":outcome.receipt.history_revision,"expectedCursor":outcome.receipt.cursor,"payload":{}})).unwrap();
    use scenesparrow_application::manuscript::ManuscriptRepository;
    r.execute_manuscript(&undo).unwrap();
    assert_eq!(
        r.accepted_file_graph()
            .unwrap()
            .unwrap()
            .graph
            .files
            .iter()
            .find(|f| f.path == "public/silence.bin")
            .unwrap()
            .size,
        2 << 20
    );
}
#[test]
fn package_work_copy_exports_original_context_and_returns_through_existing_item() {
    let (_d, root, r, s) = setup();
    let item = copy(&r);
    let location = r.reveal_work_item_location(&item.work_item_id).unwrap();
    std::fs::write(
        location.join("context/credentials.json"),
        b"must never export secret",
    )
    .unwrap();
    let request = WorkCopyPackageExportRequest {
        request_id: id(),
        owner_project_id: item.project_id.clone(),
        work_item_id: item.work_item_id.clone(),
        expected_work_item_revision: item.item_revision,
    };
    s.start_work_copy_package(&r, &request).unwrap();
    s.run_next(&r).unwrap();
    let status = s.package_status(&r, &request.request_id).unwrap();
    assert_eq!(
        status.state,
        PackageOperationViewState::Succeeded,
        "{status:?}"
    );
    let bytes = std::fs::read(
        s.directory
            .join(format!("archive-{}.zip", request.request_id)),
    )
    .unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    assert!(z.by_name("context/credentials.json").is_err());
    drop(z);
    let edited = edit_zip(&bytes, "project/public/silence.bin", b"work return");
    let inspection = inspect(&r, &s, &edited);
    assert!(inspection.trusted_return);
    let returned = PackageReturnRequest {
        request_id: id(),
        owner_project_id: item.project_id,
        inspection_id: inspection.inspection_id,
        work_item_id: Some(item.work_item_id.clone()),
        grant: None,
    };
    s.start_package_return(&r, &returned).unwrap();
    s.run_next(&r).unwrap();
    let status = s.package_status(&r, &returned.request_id).unwrap();
    assert_eq!(
        status.state,
        PackageOperationViewState::Succeeded,
        "{status:?}"
    );
    assert!(
        r.work_item(&item.work_item_id)
            .unwrap()
            .latest_candidate
            .is_some()
    );
    assert!(root.join("public/silence.bin").exists());
}
#[test]
fn package_management_tampering_is_rejected_and_active_management_unchanged() {
    let (_d, _root, r, s) = setup();
    let (_, bytes) = export(&r, &s);
    let before = r.read_package_base().unwrap();
    let bytes = edit_zip(&bytes, ".scenesparrow/managed.json", b"{}");
    let req = upload(&r, &s, &bytes);
    s.start_package_inspection(&r, &req).unwrap();
    s.run_next(&r).unwrap();
    let view = s.package_status(&r, &req.request_id).unwrap();
    assert_eq!(
        view.failure_code.as_deref(),
        Some("PACKAGE_MANAGEMENT_CHANGED")
    );
    assert_eq!(r.read_package_base().unwrap(), before);
}
pub(crate) fn roundtrip(
    r: &SqliteProjectRepository,
) -> (tempfile::TempDir, SqliteProjectRepository) {
    let d = tempfile::tempdir().unwrap();
    let s = ProjectTransferStore::open(&d.path().join("app")).unwrap();
    let (_, bytes) = export(r, &s);
    let inspection = inspect(r, &s, &bytes);
    let target = s
        .issue_package_restore_target(
            r,
            &PackageRestoreTargetRequest {
                request_id: id(),
                owner_project_id: inspection.owner_project_id.clone(),
                inspection_id: inspection.inspection_id.clone(),
                destination: PackageRestoreTargetRequestDestination::Managed,
            },
        )
        .unwrap();
    let request = PackageRestoreRequest {
        request_id: id(),
        owner_project_id: inspection.owner_project_id,
        inspection_id: inspection.inspection_id,
        target_id: target.target_id.clone(),
    };
    s.start_package_restore(r, &request).unwrap();
    s.run_next(r).unwrap();
    let view = s.package_status(r, &request.request_id).unwrap();
    assert_eq!(view.state, PackageOperationViewState::Succeeded, "{view:?}");
    let restored = SqliteProjectRepository::open_format(&s.roots.join(&target.target_id)).unwrap();
    (d, restored)
}
#[test]
fn package_and_native_backup_revoke_copied_availability_preserve_terminal_outcomes_and_release_slot()
 {
    let (d, _root, r, s) = setup();
    let item = copy(&r);
    let original = r.work_operation(&item.operation_request_id).unwrap();
    let (_, bytes) = export(&r, &s);
    let view = inspect(&r, &s, &bytes);
    let target = s
        .issue_package_restore_target(
            &r,
            &PackageRestoreTargetRequest {
                request_id: id(),
                owner_project_id: item.project_id.clone(),
                inspection_id: view.inspection_id.clone(),
                destination: PackageRestoreTargetRequestDestination::Managed,
            },
        )
        .unwrap();
    let request = PackageRestoreRequest {
        request_id: id(),
        owner_project_id: item.project_id.clone(),
        inspection_id: view.inspection_id,
        target_id: target.target_id.clone(),
    };
    s.start_package_restore(&r, &request).unwrap();
    *s.fault.lock().unwrap() = Some("package-promoted");
    s.run_next(&r).unwrap();
    assert_eq!(
        s.package_status(&r, &request.request_id).unwrap().state,
        PackageOperationViewState::Succeeded
    );
    let packaged = SqliteProjectRepository::open_format(&s.roots.join(target.target_id)).unwrap();
    let backup = r.verified_backup().unwrap();
    let native =
        SqliteProjectRepository::restore_verified_copy(&backup, &d.path().join("backup-restored"))
            .unwrap();
    for restored in [&packaged, &native] {
        {
            let c = restored.connection.lock().unwrap();
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM package_capture_pins", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                0
            );
            assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM package_exports WHERE roots_hash IS NOT NULL OR capture_store IS NOT NULL OR capture_token IS NOT NULL OR capture_owner IS NOT NULL OR capture_expires_at IS NOT NULL OR materialized_token IS NOT NULL OR capture_state IN ('capturing','sql-captured','pinned','ready-pinned'))", [], |row| row.get::<_, bool>(0)).unwrap());
        }
        let copied = restored.work_item(&item.work_item_id).unwrap();
        assert!(!copied.copy_available);
        assert_eq!(
            restored.work_operation(&item.operation_request_id).unwrap(),
            original
        );
        let guessed = restored
            .directory
            .join("work-items")
            .join(&item.work_item_id)
            .join("project");
        std::fs::create_dir_all(&guessed).unwrap();
        std::fs::write(guessed.join("sentinel"), b"unknown bytes").unwrap();
        assert_eq!(
            restored
                .reveal_work_item_location(&item.work_item_id)
                .unwrap_err()
                .0,
            "WORK_COPY_UNAVAILABLE"
        );
        let base = restored.read_package_base().unwrap();
        restored
            .discard_work_item(&WorkItemDiscardRequest {
                request_id: id(),
                project_id: item.project_id.clone(),
                expected_working_revision: base.working_revision,
                expected_graph_hash: base.graph_hash,
                expected_graph_generation: base.graph_generation,
                work_item_id: item.work_item_id.clone(),
                expected_item_revision: copied.item_revision,
                candidate_id: None,
                disposition: WorkItemDiscardRequestDisposition::DiscardCopy,
            })
            .unwrap();
        assert_eq!(
            std::fs::read(guessed.join("sentinel")).unwrap(),
            b"unknown bytes"
        );
        assert_eq!(
            restored.work_item(&item.work_item_id).unwrap().state,
            WorkItemViewState::Discarded
        );
    }
}
#[test]
fn package_history_highwaters_original_success_failures_and_two_approvals_survive() {
    use scenesparrow_application::manuscript::ManuscriptRepository;
    let (_d, _root, r, _s) = setup();
    let bid = id();
    let p = r.read().unwrap().unwrap();
    let command = |r: &SqliteProjectRepository, kind: &str, payload: serde_json::Value| {
        let b = r.read_package_base().unwrap();
        let h = r.read_history().unwrap();
        let mut value = serde_json::json!({"type":kind,"requestId":id(),"projectId":p.id,"expectedWorkingRevision":b.working_revision,"payload":payload});
        if matches!(kind, "UndoProject" | "RedoProject") {
            value["expectedHistoryRevision"] = h.history_revision.into();
            value["expectedCursor"] = h.cursor.into();
        }
        serde_json::from_value::<ManuscriptCommand>(value).unwrap()
    };
    let edit = |r: &SqliteProjectRepository, text: &str, insert: bool| {
        let state = r.read_manuscript().unwrap();
        let operations = if insert {
            serde_json::json!([{"op":"insertBlock","after":null,"block":{"id":bid,"kind":"paragraph","attrs":{},"runs":[{"text":text,"marks":[]}]}}])
        } else {
            serde_json::json!([{"op":"setBlockContent","id":bid,"runs":[{"text":text,"marks":[]}]}])
        };
        command(
            r,
            "ApplyDocumentEdit",
            serde_json::json!({"operations":operations,"expectedBlockRevisions":state.blocks.iter().map(|b|serde_json::json!({"id":b.id,"revision":b.revision})).collect::<Vec<_>>(),"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}),
        )
    };
    let first = edit(&r, "old approved", true);
    let original = r.execute_manuscript(&first).unwrap();
    r.execute_manuscript(&command(
        &r,
        "SetUserLocks",
        serde_json::json!({"blockIds":[],"locked":true,"all":true}),
    ))
    .unwrap();
    r.execute_manuscript(&command(
        &r,
        "SetUserLocks",
        serde_json::json!({"blockIds":[bid],"locked":false,"all":false}),
    ))
    .unwrap();
    r.execute_manuscript(&edit(&r, "new approved", false))
        .unwrap();
    r.execute_manuscript(&command(
        &r,
        "SetUserLocks",
        serde_json::json!({"blockIds":[],"locked":true,"all":true}),
    ))
    .unwrap();
    let rejected = command(&r, "StartManualDraft", serde_json::json!({}));
    let error = r.execute_manuscript(&rejected).unwrap_err().0;
    let export = r
        .start_export(&ExportRequest {
            request_id: id(),
            expected_revision: r.read_manuscript().unwrap().working_revision,
            expected_body_hash: None,
            format: ExportRequestFormat::Txt,
        })
        .unwrap();
    r.run_export(&export.id).unwrap();
    let before = r.read_manuscript().unwrap();
    let history = r.read_history().unwrap();
    let roots = r.retained_object_roots().unwrap();
    let (_copy, restored) = roundtrip(&r);
    assert_eq!(restored.read_manuscript().unwrap(), before);
    assert_eq!(restored.read_history().unwrap(), history);
    assert_eq!(
        std::fs::read(restored.directory.join("exports").join(&export.id)).unwrap(),
        std::fs::read(r.directory.join("exports").join(&export.id)).unwrap()
    );
    assert_eq!(restored.execute_manuscript(&first).unwrap(), original);
    assert_eq!(restored.execute_manuscript(&rejected).unwrap_err().0, error);
    let approvals: i64 = restored
        .connection
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM approved_manifests", [], |r| r.get(0))
        .unwrap();
    assert_eq!(approvals, 2);
    for hash in &roots {
        assert!(restored.directory.join("objects").join(hash).is_file());
    }
    for kind in ["UndoProject", "RedoProject"] {
        for _ in 0..5 {
            restored
                .execute_manuscript(&command(&restored, kind, serde_json::json!({})))
                .unwrap();
        }
    }
    assert_eq!(
        restored.read_manuscript().unwrap().blocks[0].runs,
        before.blocks[0].runs
    );
    restored.collect_objects(std::time::Duration::ZERO).unwrap();
    for hash in restored.retained_object_roots().unwrap() {
        assert!(restored.directory.join("objects").join(hash).is_file());
    }
    restored.verified_backup().unwrap();
}
fn changed_zip(bytes: &[u8], changes: &[(&str, Option<&[u8]>)]) -> Vec<u8> {
    let mut input = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut output = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
    let mut remaining = changes
        .iter()
        .map(|(p, b)| ((*p).to_string(), *b))
        .collect::<std::collections::BTreeMap<_, _>>();
    for i in 0..input.len() {
        let mut f = input.by_index(i).unwrap();
        let name = f.name().to_string();
        let mut body = vec![];
        f.read_to_end(&mut body).unwrap();
        if let Some(change) = remaining.remove(&name) {
            match change {
                None => continue,
                Some(bytes) => body = bytes.to_vec(),
            }
        }
        output
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        output.write_all(&body).unwrap();
    }
    for (name, body) in remaining {
        if let Some(body) = body {
            output
                .start_file(
                    name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            output.write_all(body).unwrap();
        }
    }
    output.finish().unwrap().into_inner()
}
#[test]
fn package_raw_markdown_return_preserves_bom_mixed_endings_ids_marks_add_delete_and_grouped_undo_redo()
 {
    use scenesparrow_application::manuscript::ManuscriptRepository;
    let (_d, root, r, s) = setup();
    let snapshot = r.read_source_snapshot().unwrap();
    let raw = "\u{feff}First **bold** 中文\r\n\r\nSecond 🐦\n";
    let request=serde_json::from_value(serde_json::json!({"requestId":id(),"projectId":snapshot.project_id,"expectedWorkingRevision":snapshot.working_revision,"expectedGeneration":snapshot.generation,"expectedHash":snapshot.accepted_hash,"source":raw,"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}})).unwrap();
    r.save_source(&request).unwrap();
    let before = r.read_source_snapshot().unwrap();
    let history = r.read_history().unwrap();
    let (_, bytes) = export(&r, &s);
    let changed = before.source.replace("First", "Changed");
    let edited = changed_zip(
        &bytes,
        &[
            ("manuscript.md", Some(changed.as_bytes())),
            ("public/silence.bin", None),
            ("public/new.bin", Some(b"new media")),
        ],
    );
    let inspection = inspect(&r, &s, &edited);
    assert!(inspection.trusted_return);
    let request = PackageReturnRequest {
        request_id: id(),
        owner_project_id: before.project_id.clone(),
        inspection_id: inspection.inspection_id,
        work_item_id: None,
        grant: Some(whole()),
    };
    s.start_package_return(&r, &request).unwrap();
    s.run_next(&r).unwrap();
    let view = s.package_status(&r, &request.request_id).unwrap();
    assert_eq!(view.state, PackageOperationViewState::Succeeded, "{view:?}");
    let candidate = view.candidate.unwrap();
    let item = r.work_item(&candidate.work_item_id).unwrap();
    let base = r.read_package_base().unwrap();
    let accepted = r
        .accept_work_candidate(&WorkCandidateAcceptRequest {
            request_id: id(),
            project_id: base.project_id.clone(),
            expected_working_revision: candidate.inspected_working_revision,
            expected_graph_hash: base.graph_hash,
            expected_graph_generation: candidate.inspected_graph_generation,
            work_item_id: item.work_item_id,
            candidate_id: candidate.candidate_id,
            candidate_digest: candidate.candidate_digest,
            expected_item_revision: item.item_revision,
        })
        .unwrap();
    let after = r.read_source_snapshot().unwrap();
    assert_eq!(after.source, changed);
    assert_eq!(after.semantic_block_ids, before.semantic_block_ids);
    assert!(after.source.starts_with('\u{feff}'));
    assert!(after.source.contains("\r\n"));
    assert_eq!(
        accepted.receipt.history_revision,
        history.history_revision + 1
    );
    assert!(root.join("public/new.bin").exists());
    assert!(!root.join("public/silence.bin").exists());
    for (kind, text) in [
        ("UndoProject", before.source.as_str()),
        ("RedoProject", changed.as_str()),
    ] {
        let b = r.read_package_base().unwrap();
        let h = r.read_history().unwrap();
        let command=serde_json::from_value(serde_json::json!({"type":kind,"requestId":id(),"projectId":b.project_id,"expectedWorkingRevision":b.working_revision,"expectedHistoryRevision":h.history_revision,"expectedCursor":h.cursor,"payload":{}})).unwrap();
        r.execute_manuscript(&command).unwrap();
        assert_eq!(r.read_source_snapshot().unwrap().source, text);
    }
}
#[test]
fn package_cache_expiry_respects_readers_candidate_retention_and_never_replays_deletion() {
    let (_d, _root, r, s) = setup();
    let (archive, bytes) = export(&r, &s);
    let reader = s.read_package_archive(&r, &archive).unwrap();
    let mut ready: ArchiveReady =
        journal::read(&s.package_path("archive-ready", &archive)).unwrap();
    ready.view.expires_at = now() - 1;
    journal::save(&s.package_path("archive-ready", &archive), &ready).unwrap();
    assert_eq!(s.expire_packages(&r).unwrap(), 0);
    drop(reader);
    assert_eq!(s.expire_packages(&r).unwrap(), 1);
    let cache = s.directory.join(format!("archive-{archive}.zip"));
    assert!(!cache.exists());
    assert!(
        !std::fs::read_dir(&s.directory)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .any(
                |n| n.starts_with("capture-") || n.starts_with(&format!("materialized-{archive}-"))
            )
    );
    std::fs::write(&cache, b"later unknown bytes").unwrap();
    assert_eq!(s.expire_packages(&r).unwrap(), 0);
    assert_eq!(std::fs::read(cache).unwrap(), b"later unknown bytes");
    let inspection = inspect(
        &r,
        &s,
        &edit_zip(&bytes, "public/silence.bin", b"candidate"),
    );
    let request = PackageReturnRequest {
        request_id: id(),
        owner_project_id: inspection.owner_project_id.clone(),
        inspection_id: inspection.inspection_id,
        work_item_id: None,
        grant: Some(whole()),
    };
    s.start_package_return(&r, &request).unwrap();
    s.run_next(&r).unwrap();
    let view = s.package_status(&r, &request.request_id).unwrap();
    let candidate = view.candidate.unwrap();
    let mut intake: intake::Intake =
        journal::read(&s.package_path("intake", &inspection.intake_id)).unwrap();
    intake.view.expires_at = now() - 1;
    journal::save(&s.package_path("intake", &intake.view.intake_id), &intake).unwrap();
    assert_eq!(s.expire_packages(&r).unwrap(), 0);
    assert_eq!(
        s.package_intake(&r, &intake.view.intake_id).unwrap().state,
        PackageIntakeViewState::Sealed
    );
    {
        let c = r.connection.lock().unwrap();
        c.execute(
            "UPDATE work_candidates SET disposition='discarded' WHERE id=?1",
            [&candidate.candidate_id],
        )
        .unwrap();
    }
    assert_eq!(s.expire_packages(&r).unwrap(), 0);
    {
        let c = r.connection.lock().unwrap();
        c.execute(
            "UPDATE package_intake_leases SET retain_until=?1",
            [now() - 1],
        )
        .unwrap();
    }
    assert_eq!(s.expire_packages(&r).unwrap(), 1);
    assert_eq!(
        s.package_intake(&r, &intake.view.intake_id).unwrap().state,
        PackageIntakeViewState::Expired
    );
    let bytes = b"cancelled bounded intake bytes";
    let owner = r.read_package_base().unwrap().project_id;
    let cancelled = s
        .create_package_intake(
            &r,
            &PackageIntakeRequest {
                request_id: id(),
                owner_project_id: owner.clone(),
                filename: "cancelled.zip".into(),
                length: bytes.len() as i64,
                hash: hash(bytes),
            },
        )
        .unwrap();
    s.write_package_chunk(
        &r,
        &PackageChunkRequest {
            owner_project_id: owner.clone(),
            intake_id: cancelled.intake_id.clone(),
            offset: 0,
            length: bytes.len() as i64,
            hash: hash(bytes),
        },
        bytes,
    )
    .unwrap();
    let view = s.package_intake(&r, &cancelled.intake_id).unwrap();
    let control = PackageIntakeControlRequest {
        request_id: id(),
        owner_project_id: owner,
        intake_id: cancelled.intake_id.clone(),
        expected_revision: view.revision,
        action: PackageIntakeControlRequestAction::Cancel,
    };
    let original = s.control_package_intake(&r, &control).unwrap();
    assert_eq!(original.state, PackageIntakeViewState::Cancelled);
    let path = s.package_path("intake", &cancelled.intake_id);
    let mut record: intake::Intake = journal::read(&path).unwrap();
    record.view.expires_at = now() - 1;
    journal::save(&path, &record).unwrap();
    assert_eq!(s.expire_packages(&r).unwrap(), 1);
    assert_eq!(
        s.package_intake(&r, &cancelled.intake_id).unwrap().state,
        PackageIntakeViewState::Expired
    );
    assert_eq!(s.control_package_intake(&r, &control).unwrap(), original);
    let cache = s
        .directory
        .join(format!("intake-{}.zip", cancelled.intake_id));
    assert!(!cache.exists());
    std::fs::write(&cache, b"later unknown cancelled-intake bytes").unwrap();
    assert_eq!(s.expire_packages(&r).unwrap(), 0);
    assert_eq!(
        std::fs::read(cache).unwrap(),
        b"later unknown cancelled-intake bytes"
    );
    assert_eq!(s.control_package_intake(&r, &control).unwrap(), original);
}
#[test]
fn package_single_transfer_worker_and_cancel_leave_source_writer_responsive() {
    use std::{
        sync::{Arc, mpsc},
        time::Duration,
    };
    let (_d, _root, r, s) = setup();
    let r = Arc::new(r);
    let s = Arc::new(s);
    let request = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    s.start_package_export(&r, &request).unwrap();
    let (entered, enter) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let wait = std::sync::Mutex::new(wait);
    *s.hook.lock().unwrap() = Some(Arc::new(move || {
        entered.send(()).unwrap();
        wait.lock().unwrap().recv().unwrap();
    }));
    let worker = {
        let r = r.clone();
        let s = s.clone();
        std::thread::spawn(move || s.run_next(&r))
    };
    enter.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(!s.run_next(&r).unwrap());
    let start = std::time::Instant::now();
    let view = s.package_status(&r, &request.request_id).unwrap();
    r.rename(
        &id(),
        &request.base.project_id,
        "Package test",
        "Responsive save",
    )
    .unwrap();
    s.control_package(
        &r,
        &PackageControlRequest {
            request_id: id(),
            owner_project_id: request.base.project_id,
            operation_id: request.request_id.clone(),
            expected_operation_revision: view.operation_revision,
            action: PackageControlRequestAction::Cancel,
        },
    )
    .unwrap();
    assert!(start.elapsed() < Duration::from_secs(2));
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    assert_eq!(
        s.package_status(&r, &request.request_id).unwrap().state,
        PackageOperationViewState::Cancelled
    );
    assert_eq!(r.read().unwrap().unwrap().title, "Responsive save");
}
#[test]
fn package_and_migration_share_five_admissions_and_original_full_queue_outcome() {
    let (d, _root, r, s) = setup();
    let legacy = SqliteProjectRepository::open(&d.path().join("legacy")).unwrap();
    let p = legacy.create("fixture", "Legacy queue").unwrap();
    let target = s
        .issue_target(
            &legacy,
            &MigrationTargetRequest {
                request_id: id(),
                project_id: p.id.clone(),
                destination: MigrationTargetRequestDestination::Managed,
            },
        )
        .unwrap();
    let inspected = legacy.inspect_legacy_migration().unwrap();
    s.start(
        &legacy,
        &LegacyMigrationRequest {
            request_id: id(),
            project_id: p.id,
            content_base: inspected.content_base,
            target_id: target.target_id,
        },
    )
    .unwrap();
    let base = r.read_package_base().unwrap();
    let mut requests = vec![];
    for _ in 0..4 {
        let req = ProjectPackageExportRequest {
            request_id: id(),
            base: base.clone(),
        };
        s.start_package_export(&r, &req).unwrap();
        requests.push(req);
    }
    let full = ProjectPackageExportRequest {
        request_id: id(),
        base: base.clone(),
    };
    assert_eq!(
        s.start_package_export(&r, &full).unwrap_err().0,
        "PACKAGE_QUEUE_FULL"
    );
    let view = s.package_status(&r, &requests[0].request_id).unwrap();
    s.control_package(
        &r,
        &PackageControlRequest {
            request_id: id(),
            owner_project_id: base.project_id.clone(),
            operation_id: requests[0].request_id.clone(),
            expected_operation_revision: view.operation_revision,
            action: PackageControlRequestAction::Cancel,
        },
    )
    .unwrap();
    assert_eq!(
        s.start_package_export(&r, &full).unwrap_err().0,
        "PACKAGE_QUEUE_FULL"
    );
    s.start_package_export(
        &r,
        &ProjectPackageExportRequest {
            request_id: id(),
            base,
        },
    )
    .unwrap();
}
#[test]
fn package_return_cannot_reuse_an_unrelated_op4_request_identity() {
    let (_d, _root, r, s) = setup();
    let item = copy(&r);
    let b = r.read_package_base().unwrap();
    let graph = r.accepted_file_graph().unwrap().unwrap();
    let request = PackageReturnRequest {
        request_id: item.operation_request_id.clone(),
        owner_project_id: b.project_id,
        inspection_id: id(),
        work_item_id: Some(item.work_item_id),
        grant: None,
    };
    assert_eq!(
        r.prepare_package_return(&request, &graph, graph.graph.clone())
            .unwrap_err()
            .0,
        "PACKAGE_REQUEST_CONFLICT"
    );
    let (_, bytes) = export(&r, &s);
    let inspected = inspect(&r, &s, &bytes);
    assert!(inspected.trusted_return);
}
#[test]
#[cfg(target_os = "linux")]
fn package_held_capture_and_restore_stage_cannot_redirect_sql_or_files_into_source() {
    use std::os::unix::fs::symlink;
    let (_d, root, r, s) = setup();
    let base = r.read_package_base().unwrap();
    let directory = s.directory.clone();
    let source = root.clone();
    *r.source_action.lock().unwrap() = Some((
        "package-capture-held".into(),
        Box::new(move || {
            let capture = std::fs::read_dir(&directory)
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| {
                    p.file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .starts_with("capture-")
                })
                .unwrap();
            std::fs::rename(&capture, capture.with_extension("held")).unwrap();
            symlink(source, &capture).unwrap();
        }),
    ));
    assert!(
        s.start_package_export(
            &r,
            &ProjectPackageExportRequest {
                request_id: id(),
                base: base.clone()
            }
        )
        .is_err()
    );
    assert_eq!(r.read_package_base().unwrap(), base);
    assert!(!root.join("capture.json").exists());
    let (_, bytes) = export(&r, &s);
    let inspection = inspect(&r, &s, &bytes);
    let target = s
        .issue_package_restore_target(
            &r,
            &PackageRestoreTargetRequest {
                request_id: id(),
                owner_project_id: base.project_id.clone(),
                inspection_id: inspection.inspection_id.clone(),
                destination: PackageRestoreTargetRequestDestination::Managed,
            },
        )
        .unwrap();
    let request = PackageRestoreRequest {
        request_id: id(),
        owner_project_id: base.project_id,
        inspection_id: inspection.inspection_id,
        target_id: target.target_id.clone(),
    };
    let before = std::fs::read(root.join(".scenesparrow/project.sqlite")).unwrap();
    let roots = s.roots.clone();
    let source = root.clone();
    *r.source_action.lock().unwrap() = Some((
        "package-restore-held".into(),
        Box::new(move || {
            let stage = std::fs::read_dir(&roots)
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| {
                    p.file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .starts_with(".restore-")
                })
                .unwrap();
            std::fs::rename(&stage, stage.with_extension("held")).unwrap();
            symlink(source, &stage).unwrap();
        }),
    ));
    s.start_package_restore(&r, &request).unwrap();
    s.run_next(&r).unwrap();
    let status = s.package_status(&r, &request.request_id).unwrap();
    assert_eq!(status.state, PackageOperationViewState::Failed);
    assert!(!s.roots.join(target.target_id).exists());
    assert_eq!(
        std::fs::read(root.join(".scenesparrow/project.sqlite")).unwrap(),
        before
    );
    assert!(!root.join(".scenesparrow/package-ready.json").exists());
}
#[test]
fn package_return_cannot_edit_locked_text_and_original_rejection_replays() {
    use scenesparrow_application::manuscript::ManuscriptRepository;
    let (_d, _root, r, s) = setup();
    let before = r.read_source_snapshot().unwrap();
    let request=serde_json::from_value(serde_json::json!({"requestId":id(),"projectId":before.project_id,"expectedWorkingRevision":before.working_revision,"expectedGeneration":before.generation,"expectedHash":before.accepted_hash,"source":"Locked **text** 中文\n","group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}})).unwrap();
    r.save_source(&request).unwrap();
    let b = r.read_package_base().unwrap();
    let locks=serde_json::from_value(serde_json::json!({"type":"SetUserLocks","requestId":id(),"projectId":b.project_id,"expectedWorkingRevision":b.working_revision,"payload":{"blockIds":[],"all":true,"locked":true}})).unwrap();
    r.execute_manuscript(&locks).unwrap();
    let original = r.read_source_snapshot().unwrap();
    let (_, bytes) = export(&r, &s);
    let edited = edit_zip(
        &bytes,
        "manuscript.md",
        original.source.replace("Locked", "Tampered").as_bytes(),
    );
    let inspected = inspect(&r, &s, &edited);
    let request = PackageReturnRequest {
        request_id: id(),
        owner_project_id: b.project_id,
        inspection_id: inspected.inspection_id,
        work_item_id: None,
        grant: Some(whole()),
    };
    s.start_package_return(&r, &request).unwrap();
    s.run_next(&r).unwrap();
    let view = s.package_status(&r, &request.request_id).unwrap();
    let candidate = view.candidate.unwrap();
    let item = r.work_item(&candidate.work_item_id).unwrap();
    let base = r.read_package_base().unwrap();
    let accept = WorkCandidateAcceptRequest {
        request_id: id(),
        project_id: base.project_id,
        expected_working_revision: candidate.inspected_working_revision,
        expected_graph_hash: base.graph_hash,
        expected_graph_generation: candidate.inspected_graph_generation,
        work_item_id: item.work_item_id,
        candidate_id: candidate.candidate_id,
        candidate_digest: candidate.candidate_digest,
        expected_item_revision: item.item_revision,
    };
    for _ in 0..2 {
        assert_eq!(
            r.accept_work_candidate(&accept).unwrap_err().0,
            "CONTENT_LOCKED"
        );
    }
    assert_eq!(r.read_source_snapshot().unwrap().source, original.source);
    assert!(r.read_finalization().unwrap().finalized);
}

fn capture_roots(
    r: &SqliteProjectRepository,
    s: &ProjectTransferStore,
    id: &str,
) -> pins::CaptureRoots {
    let op = s.package_read(r, id).unwrap();
    large_read(
        &s.directory
            .join(op.capture_id.unwrap())
            .join("capture-roots.json"),
        16 << 20,
    )
    .unwrap()
}
fn cancel_export(
    r: &SqliteProjectRepository,
    s: &ProjectTransferStore,
    req: &ProjectPackageExportRequest,
) {
    let v = s.package_status(r, &req.request_id).unwrap();
    s.control_package(
        r,
        &PackageControlRequest {
            request_id: id(),
            owner_project_id: req.base.project_id.clone(),
            operation_id: req.request_id.clone(),
            expected_operation_revision: v.operation_revision,
            action: PackageControlRequestAction::Cancel,
        },
    )
    .unwrap();
}
fn retry_export(
    r: &SqliteProjectRepository,
    s: &ProjectTransferStore,
    req: &ProjectPackageExportRequest,
) {
    let v = s.package_status(r, &req.request_id).unwrap();
    s.control_package(
        r,
        &PackageControlRequest {
            request_id: id(),
            owner_project_id: req.base.project_id.clone(),
            operation_id: req.request_id.clone(),
            expected_operation_revision: v.operation_revision,
            action: PackageControlRequestAction::Retry,
        },
    )
    .unwrap();
    s.run_next(r).unwrap();
    let v = s.package_status(r, &req.request_id).unwrap();
    assert_eq!(v.state, PackageOperationViewState::Succeeded, "{v:?}");
}
#[test]
fn package_cancelled_capture_pins_only_original_closure_and_retry_ignores_later_edits() {
    let (_d, _root, r, s) = setup();
    let req = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    s.start_package_export(&r, &req).unwrap();
    let captured = capture_roots(&r, &s, &req.request_id);
    // Private staging metadata is evidence; only the immutable, SQL-bound record
    // supplies materialization roots after the start acknowledgment.
    let capture_id = s
        .package_read(&r, &req.request_id)
        .unwrap()
        .capture_id
        .unwrap();
    let mut tampered = captured.clone();
    tampered.objects.clear();
    std::fs::write(
        s.directory.join(capture_id).join("capture-roots.json"),
        serde_json::to_vec(&tampered).unwrap(),
    )
    .unwrap();
    cancel_export(&r, &s, &req);
    let mut previous = "Package test".to_owned();
    let mut orphans = vec![];
    for n in 0..12 {
        let title = format!("Later title {n}");
        r.rename(&id(), &req.base.project_id, &previous, &title)
            .unwrap();
        previous = title;
        orphans.push(
            r.object(format!("unrelated future orphan {n}").as_bytes())
                .unwrap(),
        );
    }
    assert!(r.collect_objects(std::time::Duration::ZERO).unwrap() >= orphans.len());
    for h in orphans {
        assert!(!r.directory.join("objects").join(h).exists());
    }
    for h in &captured.objects {
        assert!(r.directory.join("objects").join(h).is_file(), "{h}");
    }
    retry_export(&r, &s, &req);
    let op = s.package_read(&r, &req.request_id).unwrap();
    let Request::Export(original) = op.request else {
        panic!()
    };
    assert_eq!(original.base, req.base);
    assert_ne!(r.read_package_base().unwrap(), req.base);
}
#[test]
fn package_capture_pin_install_cuts_recover_original_sql_before_retry_after_later_edit() {
    for cut in ["package-pins-before-install", "package-pins-after-install"] {
        let (d, root, r, s) = setup();
        let req = ProjectPackageExportRequest {
            request_id: id(),
            base: r.read_package_base().unwrap(),
        };
        *r.source_fault.lock().unwrap() = Some(cut.into());
        assert_eq!(s.start_package_export(&r, &req).unwrap_err().0, "TEST_CUT");
        let op = s.package_read(&r, &req.request_id).unwrap();
        let capture = op.capture_id.unwrap();
        let sql = s
            .directory
            .join(&capture)
            .join(".scenesparrow/project.sqlite");
        let original_sql = hash(&std::fs::read(&sql).unwrap());
        drop(s);
        drop(r);
        let r = SqliteProjectRepository::open_format(&root).unwrap();
        let s = ProjectTransferStore::open(&d.path().join("app")).unwrap();
        r.rename(
            &id(),
            &req.base.project_id,
            "Package test",
            "Later edit after pin cut",
        )
        .unwrap();
        r.collect_objects(std::time::Duration::ZERO).unwrap();
        s.start_package_export(&r, &req).unwrap();
        assert_eq!(
            s.package_read(&r, &req.request_id)
                .unwrap()
                .capture_id
                .as_deref(),
            Some(capture.as_str())
        );
        assert_eq!(hash(&std::fs::read(&sql).unwrap()), original_sql);
        retry_export(&r, &s, &req);
        assert_eq!(hash(&std::fs::read(&sql).unwrap()), original_sql);
    }
}
#[test]
fn package_start_and_collector_recheck_pin_state_after_the_same_capture_lease() {
    let (_d, _root, r, s) = setup();
    let req = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    let entered = std::sync::Arc::new(std::sync::Barrier::new(2));
    let release = std::sync::Arc::new(std::sync::Barrier::new(2));
    let a = entered.clone();
    let b = release.clone();
    *r.source_action.lock().unwrap() = Some((
        "package-pins-before-install".into(),
        Box::new(move || {
            a.wait();
            b.wait();
        }),
    ));
    std::thread::scope(|scope| {
        let start = scope.spawn(|| s.start_package_export(&r, &req));
        entered.wait();
        let collect = scope.spawn(|| r.collect_objects(std::time::Duration::ZERO));
        release.wait();
        start.join().unwrap().unwrap();
        collect.join().unwrap().unwrap();
    });
    let c = r.connection.lock().unwrap();
    let (state, failure): (String, Option<String>) = c
        .query_row(
            "SELECT capture_state,capture_failure FROM package_exports WHERE export_id=?1",
            [&req.request_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "ready-pinned");
    assert_eq!(failure, None);
    drop(c);
    s.run_next(&r).unwrap();
    assert_eq!(
        s.package_status(&r, &req.request_id).unwrap().state,
        PackageOperationViewState::Succeeded
    );
}
#[test]
fn package_new_capture_does_not_inherit_old_cache_only_pins_and_old_expiry_collects_them() {
    let (_d, _root, r, s) = setup();
    let (a, _) = export(&r, &s);
    let old = capture_roots(&r, &s, &a);
    let project = r.read_package_base().unwrap().project_id;
    let mut previous = "Package test".to_owned();
    for n in 0..12 {
        let title = format!("New generation {n}");
        r.rename(&id(), &project, &previous, &title).unwrap();
        previous = title;
    }
    let b = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    s.start_package_export(&r, &b).unwrap();
    let new = capture_roots(&r, &s, &b.request_id);
    let unique = old
        .objects
        .difference(&new.objects)
        .cloned()
        .collect::<Vec<_>>();
    assert!(!unique.is_empty(), "new capture inherited every old root");
    let path = s.package_path("archive-ready", &a);
    let mut ready: ArchiveReady = journal::read(&path).unwrap();
    ready.view.expires_at = now() - 1;
    journal::save(&path, &ready).unwrap();
    assert_eq!(s.expire_packages(&r).unwrap(), 1);
    r.collect_objects(std::time::Duration::ZERO).unwrap();
    assert!(
        unique
            .iter()
            .any(|h| !r.directory.join("objects").join(h).exists()),
        "all old cache-only roots survived expiry"
    );
    for h in &new.objects {
        assert!(r.directory.join("objects").join(h).is_file(), "{h}");
    }
    s.run_next(&r).unwrap();
    assert_eq!(
        s.package_status(&r, &b.request_id).unwrap().state,
        PackageOperationViewState::Succeeded
    );
}
#[test]
fn package_payload_object_stream_and_final_hash_probe_cancellation_every_buffer() {
    let (_d, _root, r, _s) = setup();
    let checks = std::rc::Rc::new(std::cell::Cell::new(0));
    let calls = checks.clone();
    let guard = crate::storage::operation::Cancellation::begin(move || {
        calls.set(calls.get() + 1);
        calls.get() == 3
    });
    let mut input = std::io::Cursor::new(vec![1; 1 << 20]);
    assert_eq!(
        r.object_stream(&mut input, 1 << 20).unwrap_err().0,
        "PACKAGE_CANCELLED"
    );
    assert_eq!(input.position(), 2 * 64 * 1024);
    drop(guard);
    let calls = checks.clone();
    checks.set(0);
    let _guard = crate::storage::operation::Cancellation::begin(move || {
        calls.set(calls.get() + 1);
        calls.get() == 3
    });
    let mut input = std::io::Cursor::new(vec![2; 1 << 20]);
    assert_eq!(
        crate::storage::objects::stream_copy(&mut input, &mut std::io::sink(), 1 << 20)
            .unwrap_err()
            .0,
        "PACKAGE_CANCELLED"
    );
    assert_eq!(input.position(), 2 * 64 * 1024);
}

#[test]
fn package_corrupt_original_capture_control_records_failure_and_releases_coarse_gc_fence() {
    let (_d, _root, r, s) = setup();
    let save = |text: &str| {
        let snapshot = r.read_source_snapshot().unwrap();
        let request = serde_json::from_value(serde_json::json!({"requestId":id(),"projectId":snapshot.project_id,"expectedWorkingRevision":snapshot.working_revision,"expectedGeneration":snapshot.generation,"expectedHash":snapshot.accepted_hash,"source":text,"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}})).unwrap();
        r.save_source(&request).unwrap();
    };
    save("Original captured control\n");
    let req = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    *r.source_fault.lock().unwrap() = Some("package-pins-before-install".into());
    assert_eq!(s.start_package_export(&r, &req).unwrap_err().0, "TEST_CUT");
    let original = capture_roots(&r, &s, &req.request_id);
    for n in 0..12 {
        save(&format!("Later source generation {n}\n"));
    }
    let current = r.retained_object_roots().unwrap();
    let op = s.package_read(&r, &req.request_id).unwrap();
    let capture = s.directory.join(op.capture_id.unwrap());
    let sql = rusqlite::Connection::open(capture.join(".scenesparrow/project.sqlite")).unwrap();
    let mut q = sql
        .prepare(
            "SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries",
        )
        .unwrap();
    let control = q
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|h| h.unwrap())
        .find(|h| original.objects.contains(h) && !current.contains(h))
        .unwrap();
    std::fs::write(
        r.directory.join("objects").join(control),
        b"corrupt original history control",
    )
    .unwrap();
    let orphan = r
        .object(b"future unrelated bytes after damaged original")
        .unwrap();
    r.collect_objects(std::time::Duration::ZERO).unwrap();
    assert!(!r.directory.join("objects").join(orphan).exists());
    let c = r.connection.lock().unwrap();
    let (state, failure): (String, Option<String>) = c
        .query_row(
            "SELECT capture_state,capture_failure FROM package_exports WHERE export_id=?1",
            [&req.request_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "failed");
    assert_eq!(failure.as_deref(), Some("PACKAGE_CAPTURE_INVALID"));
    drop(c);
    for h in current {
        assert!(r.directory.join("objects").join(h).is_file());
    }
    assert!(capture.join("sql-capture.json").is_file());
    assert_eq!(
        s.start_package_export(&r, &req).unwrap_err().0,
        "PACKAGE_CAPTURE_INVALID"
    );
    assert_eq!(
        s.start_package_export(&r, &req).unwrap_err().0,
        "PACKAGE_CAPTURE_INVALID"
    );
}
#[test]
fn package_unknown_restore_target_remains_intact_and_original_failure_status_replays() {
    let (_d, _root, r, s) = setup();
    let (_, bytes) = export(&r, &s);
    let inspection = inspect(&r, &s, &bytes);
    let target = s
        .issue_package_restore_target(
            &r,
            &PackageRestoreTargetRequest {
                request_id: id(),
                owner_project_id: inspection.owner_project_id.clone(),
                inspection_id: inspection.inspection_id.clone(),
                destination: PackageRestoreTargetRequestDestination::Managed,
            },
        )
        .unwrap();
    let path = s.roots.join(&target.target_id);
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("sentinel"), b"unknown").unwrap();
    let request = PackageRestoreRequest {
        request_id: id(),
        owner_project_id: inspection.owner_project_id,
        inspection_id: inspection.inspection_id,
        target_id: target.target_id,
    };
    let original = s.start_package_restore(&r, &request).unwrap();
    s.run_next(&r).unwrap();
    for _ in 0..2 {
        let view = s.package_status(&r, &request.request_id).unwrap();
        assert_eq!(view.state, PackageOperationViewState::Failed);
        assert_eq!(view.failure_code.as_deref(), Some("PACKAGE_TARGET_EXISTS"));
        assert_eq!(s.start_package_restore(&r, &request).unwrap(), original);
        assert_eq!(std::fs::read(path.join("sentinel")).unwrap(), b"unknown");
    }
}

#[test]
fn package_published_restore_io_failure_preserves_status_until_explicit_original_retry() {
    let (_d, _root, r, s) = setup();
    let (_, bytes) = export(&r, &s);
    let inspection = inspect(&r, &s, &bytes);
    let target = s
        .issue_package_restore_target(
            &r,
            &PackageRestoreTargetRequest {
                request_id: id(),
                owner_project_id: inspection.owner_project_id.clone(),
                inspection_id: inspection.inspection_id.clone(),
                destination: PackageRestoreTargetRequestDestination::Managed,
            },
        )
        .unwrap();
    let request = PackageRestoreRequest {
        request_id: id(),
        owner_project_id: inspection.owner_project_id,
        inspection_id: inspection.inspection_id,
        target_id: target.target_id.clone(),
    };
    let original = s.start_package_restore(&r, &request).unwrap();
    *r.source_fault.lock().unwrap() = Some("package-promoted-io".into());
    s.run_next(&r).unwrap();
    let sql = s
        .roots
        .join(&target.target_id)
        .join(".scenesparrow/project.sqlite");
    let captured_sql = hash(&std::fs::read(&sql).unwrap());
    let mut status = s.package_status(&r, &request.request_id).unwrap();
    for _ in 0..2 {
        assert_eq!(status.state, PackageOperationViewState::Failed);
        assert_eq!(status.failure_code.as_deref(), Some("STORAGE_UNAVAILABLE"));
        assert_eq!(s.start_package_restore(&r, &request).unwrap(), original);
        status = s.package_status(&r, &request.request_id).unwrap();
    }
    let retry = PackageControlRequest {
        request_id: id(),
        owner_project_id: request.owner_project_id.clone(),
        operation_id: request.request_id.clone(),
        expected_operation_revision: status.operation_revision,
        action: PackageControlRequestAction::Retry,
    };
    let accepted = s.control_package(&r, &retry).unwrap();
    s.run_next(&r).unwrap();
    assert_eq!(
        s.package_status(&r, &request.request_id).unwrap().state,
        PackageOperationViewState::Succeeded
    );
    assert_eq!(s.control_package(&r, &retry).unwrap(), accepted);
    assert_eq!(hash(&std::fs::read(&sql).unwrap()), captured_sql);
}

#[test]
fn package_stale_expiry_poll_cannot_overwrite_renewed_chunk_ack_or_seal() {
    let (_d, _root, r, s) = setup();
    let bytes = b"a complete archive-shaped fixture";
    let owner = r.read_package_base().unwrap().project_id;
    let intake = s
        .create_package_intake(
            &r,
            &PackageIntakeRequest {
                request_id: id(),
                owner_project_id: owner.clone(),
                filename: "fixture.zip".into(),
                length: bytes.len() as i64,
                hash: hash(bytes),
            },
        )
        .unwrap();
    let chunk = PackageChunkRequest {
        owner_project_id: owner,
        intake_id: intake.intake_id.clone(),
        offset: 0,
        length: bytes.len() as i64,
        hash: hash(bytes),
    };
    let chunk_loaded = std::sync::Arc::new(std::sync::Barrier::new(2));
    let chunk_release = std::sync::Arc::new(std::sync::Barrier::new(2));
    let a = chunk_loaded.clone();
    let b = chunk_release.clone();
    *r.source_action.lock().unwrap() = Some((
        "package-chunk-loaded".into(),
        Box::new(move || {
            a.wait();
            b.wait();
        }),
    ));
    std::thread::scope(|scope| {
        let upload = scope.spawn(|| s.write_package_chunk(&r, &chunk, bytes));
        chunk_loaded.wait();
        // Advance the persisted deadline after the leased upload loaded its valid
        // record, then hold a poll after it observes that expired old generation.
        let path = s.package_path("intake", &intake.intake_id);
        let mut old: intake::Intake = journal::read(&path).unwrap();
        old.view.expires_at = now() - 1;
        journal::save(&path, &old).unwrap();
        let poll_loaded = std::sync::Arc::new(std::sync::Barrier::new(2));
        let poll_release = std::sync::Arc::new(std::sync::Barrier::new(2));
        let a = poll_loaded.clone();
        let b = poll_release.clone();
        *r.source_action.lock().unwrap() = Some((
            "package-intake-observed".into(),
            Box::new(move || {
                a.wait();
                b.wait();
            }),
        ));
        let status = scope.spawn(|| s.package_intake(&r, &intake.intake_id));
        poll_loaded.wait();
        chunk_release.wait();
        assert_eq!(
            upload.join().unwrap().unwrap().acknowledged_end,
            bytes.len() as i64
        );
        s.seal_intake(&r, &intake.intake_id).unwrap();
        let renewed: intake::Intake = journal::read(&path).unwrap();
        assert_eq!(renewed.view.state, PackageIntakeViewState::Sealed);
        assert_eq!(renewed.view.received_bytes, bytes.len() as i64);
        assert!(renewed.stamp.is_some());
        assert!(renewed.view.expires_at > now());
        poll_release.wait();
        assert_eq!(
            status.join().unwrap().unwrap().state,
            PackageIntakeViewState::Expired
        );
        let after: intake::Intake = journal::read(&path).unwrap();
        assert_eq!(after.view, renewed.view);
        assert!(after.stamp == renewed.stamp);
        assert_eq!(
            s.package_intake(&r, &intake.intake_id).unwrap(),
            renewed.view
        );
    });
    assert_eq!(
        s.write_package_chunk(&r, &chunk, bytes)
            .unwrap()
            .acknowledged_end,
        bytes.len() as i64
    );
    assert_eq!(
        std::fs::read(s.directory.join(format!("intake-{}.zip", intake.intake_id))).unwrap(),
        bytes
    );
}
#[test]
fn package_original_control_hashes_refuse_after_ack_sql_and_management_tampering_on_retry() {
    for path in [".scenesparrow/project.sqlite", ".scenesparrow/managed.json"] {
        let (_d, _root, r, s) = setup();
        let request = ProjectPackageExportRequest {
            request_id: id(),
            base: r.read_package_base().unwrap(),
        };
        let original = s.start_package_export(&r, &request).unwrap();
        let op = s.package_read(&r, &request.request_id).unwrap();
        let capture_id = op.capture_id.unwrap();
        let capture = s.directory.join(&capture_id);
        let roots = capture_roots(&r, &s, &request.request_id);
        let recorded = roots.controls.get(path).unwrap();
        assert_eq!(member_at(&capture, path).unwrap().hash, recorded.hash);
        if path.ends_with("sqlite") {
            let sql = rusqlite::Connection::open(capture.join(path)).unwrap();
            sql.execute(
                "UPDATE project SET title='Tampered after acknowledgment' WHERE singleton=1",
                [],
            )
            .unwrap();
        } else {
            let mut bytes = std::fs::read(capture.join(path)).unwrap();
            bytes.push(b' ');
            std::fs::write(capture.join(path), bytes).unwrap();
        }
        let tampered = hash(&std::fs::read(capture.join(path)).unwrap());
        assert_ne!(tampered, recorded.hash);
        for attempt in 0..2 {
            assert_eq!(s.start_package_export(&r, &request).unwrap(), original);
            if attempt > 0 {
                let status = s.package_status(&r, &request.request_id).unwrap();
                s.control_package(
                    &r,
                    &PackageControlRequest {
                        request_id: id(),
                        owner_project_id: request.base.project_id.clone(),
                        operation_id: request.request_id.clone(),
                        expected_operation_revision: status.operation_revision,
                        action: PackageControlRequestAction::Retry,
                    },
                )
                .unwrap();
            }
            s.run_next(&r).unwrap();
            let status = s.package_status(&r, &request.request_id).unwrap();
            assert_eq!(
                status.state,
                PackageOperationViewState::Failed,
                "{path}: {status:?}"
            );
            assert_eq!(
                status.failure_code.as_deref(),
                Some("PACKAGE_CAPTURE_INVALID")
            );
            assert!(status.archive.is_none());
            assert_eq!(
                s.package_read(&r, &request.request_id)
                    .unwrap()
                    .capture_id
                    .as_deref(),
                Some(capture_id.as_str())
            );
            assert_eq!(hash(&std::fs::read(capture.join(path)).unwrap()), tampered);
        }
        assert_eq!(r.read().unwrap().unwrap().title, "Package test");
        assert_eq!(r.read_package_base().unwrap(), request.base);
    }
}

fn expire_capture_at(r: &SqliteProjectRepository, id: &str, at: i64) {
    r.connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE package_exports SET capture_expires_at=?2 WHERE export_id=?1",
            rusqlite::params![id, at],
        )
        .unwrap();
}
#[test]
fn package_terminal_no_ready_capture_expiry_releases_only_owned_custody_and_preserves_original_outcomes()
 {
    for kind in [
        "cancelled",
        "failed",
        "interrupted",
        "unknown",
        "record-only",
    ] {
        let (d, _root, r, s) = setup();
        let save = |text: &str| {
            let snapshot = r.read_source_snapshot().unwrap();
            let request=serde_json::from_value(serde_json::json!({"requestId":id(),"projectId":snapshot.project_id,"expectedWorkingRevision":snapshot.working_revision,"expectedGeneration":snapshot.generation,"expectedHash":snapshot.accepted_hash,"source":text,"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}})).unwrap();
            r.save_source(&request).unwrap();
        };
        save("Captured original source\n");
        let req = ProjectPackageExportRequest {
            request_id: id(),
            base: r.read_package_base().unwrap(),
        };
        let original = s.start_package_export(&r, &req).unwrap();
        assert!(
            r.package_capture_expiry(&req.request_id)
                .unwrap()
                .unwrap()
                .1
                .unwrap()
                > now() + CACHE_TTL - 60_000
        );
        let captured = capture_roots(&r, &s, &req.request_id);
        let mut cancellation = None;
        if matches!(kind, "cancelled" | "unknown") {
            let view = s.package_status(&r, &req.request_id).unwrap();
            let control = PackageControlRequest {
                request_id: id(),
                owner_project_id: req.base.project_id.clone(),
                operation_id: req.request_id.clone(),
                expected_operation_revision: view.operation_revision,
                action: PackageControlRequestAction::Cancel,
            };
            let result = s.control_package(&r, &control).unwrap();
            cancellation = Some((control, result));
        } else if matches!(kind, "failed" | "record-only") {
            *r.source_fault.lock().unwrap() = Some(
                if kind == "failed" {
                    "package-archive-write"
                } else {
                    "package-archive-ready"
                }
                .into(),
            );
            s.run_next(&r).unwrap();
        }
        let s = if kind == "interrupted" {
            drop(s);
            ProjectTransferStore::open(&d.path().join("app")).unwrap()
        } else {
            s
        };
        if kind == "failed" {
            let before = s.package_status(&r, &req.request_id).unwrap();
            let token = r
                .package_materialized_token(&req.request_id)
                .unwrap()
                .unwrap();
            let control = PackageControlRequest {
                request_id: id(),
                owner_project_id: req.base.project_id.clone(),
                operation_id: req.request_id.clone(),
                expected_operation_revision: before.operation_revision,
                action: PackageControlRequestAction::Retry,
            };
            s.control_package(&r, &control).unwrap();
            *r.source_fault.lock().unwrap() = Some("package-archive-write".into());
            s.run_next(&r).unwrap();
            assert_eq!(
                r.package_materialized_token(&req.request_id)
                    .unwrap()
                    .as_deref(),
                Some(token.as_str())
            );
            assert!(
                !s.directory
                    .join(format!("materialized-{}-2", req.request_id))
                    .exists()
            );
        }
        let original_status = s.package_status(&r, &req.request_id).unwrap();
        assert!(matches!(
            original_status.state,
            PackageOperationViewState::Cancelled
                | PackageOperationViewState::Failed
                | PackageOperationViewState::Interrupted
        ));
        let op = s.package_read(&r, &req.request_id).unwrap();
        let token = op.capture_id.unwrap();
        let stage = s.directory.join(&token);
        let materialized = if matches!(kind, "failed" | "record-only") {
            Some(
                s.directory.join(
                    r.package_materialized_token(&req.request_id)
                        .unwrap()
                        .unwrap(),
                ),
            )
        } else {
            None
        };
        if let Some(path) = &materialized {
            assert!(path.is_dir());
            assert_eq!(
                r.package_capture_expiry(&req.request_id)
                    .unwrap()
                    .unwrap()
                    .0,
                "complete"
            );
        }
        if kind == "record-only" {
            assert!(s.package_path("archive-ready", &req.request_id).exists());
            assert!(
                !s.directory
                    .join(format!("archive-{}.zip", req.request_id))
                    .exists()
            );
        }
        if kind == "unknown" {
            std::fs::write(stage.join("unknown-evidence"), b"preserve unknown").unwrap();
        }
        for n in 0..12 {
            save(&format!("Later unrelated source {n}\n"));
        }
        let current = {
            let c = r.connection.lock().unwrap();
            r.retention_roots_mode(&c, false).unwrap()
        };
        let old_only = captured
            .objects
            .difference(&current)
            .cloned()
            .collect::<Vec<_>>();
        assert!(!old_only.is_empty());
        expire_capture_at(&r, &req.request_id, now() - 1);
        let mut clocked = s.package_read(&r, &req.request_id).unwrap();
        if clocked.capture_retry_until.is_some() {
            clocked.capture_retry_until = Some(now() - 1);
            journal::save(&s.package_op(&req.request_id), &clocked).unwrap();
        }
        let reader = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(
                s.directory
                    .join(format!("package-reader-{}.lock", req.request_id)),
            )
            .unwrap();
        reader.try_lock_shared().unwrap();
        assert_eq!(s.expire_packages(&r).unwrap(), 0);
        assert!(stage.is_dir());
        drop(reader);
        assert_eq!(s.expire_packages(&r).unwrap(), 1);
        assert_eq!(
            r.package_capture_expiry(&req.request_id)
                .unwrap()
                .unwrap()
                .0,
            "expired"
        );
        {
            let c = r.connection.lock().unwrap();
            assert_eq!(
                c.query_row(
                    "SELECT COUNT(*) FROM package_capture_pins WHERE export_id=?1",
                    [&req.request_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
            assert!(!c.query_row("SELECT roots_hash IS NOT NULL OR capture_store IS NOT NULL OR capture_token IS NOT NULL OR capture_owner IS NOT NULL OR materialized_token IS NOT NULL FROM package_exports WHERE export_id=?1",[&req.request_id],|row|row.get::<_,bool>(0)).unwrap());
        }
        if kind == "unknown" {
            assert_eq!(
                std::fs::read(stage.join("unknown-evidence")).unwrap(),
                b"preserve unknown"
            );
        } else {
            assert!(!stage.exists());
            std::fs::create_dir(&stage).unwrap();
            std::fs::write(stage.join("later-sentinel"), b"later unknown stage").unwrap();
        }
        if let Some(path) = materialized {
            assert!(!path.exists());
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("sentinel"), b"later unknown materialization").unwrap();
        }
        assert_eq!(s.start_package_export(&r, &req).unwrap(), original);
        assert_eq!(
            s.package_status(&r, &req.request_id).unwrap(),
            original_status
        );
        if let Some((control, result)) = cancellation {
            assert_eq!(s.control_package(&r, &control).unwrap(), result);
        }
        let retry = PackageControlRequest {
            request_id: id(),
            owner_project_id: req.base.project_id.clone(),
            operation_id: req.request_id.clone(),
            expected_operation_revision: original_status.operation_revision,
            action: PackageControlRequestAction::Retry,
        };
        for _ in 0..2 {
            assert_eq!(
                s.control_package(&r, &retry).unwrap_err().0,
                "PACKAGE_EXPIRED"
            );
        }
        assert_eq!(
            s.package_read(&r, &req.request_id)
                .unwrap()
                .capture_id
                .as_deref(),
            Some(token.as_str())
        );
        let orphan = r
            .object(format!("later orphan after {kind} expiry").as_bytes())
            .unwrap();
        r.collect_objects(std::time::Duration::ZERO).unwrap();
        assert!(!r.directory.join("objects").join(orphan).exists());
        assert!(
            old_only
                .iter()
                .any(|hash| !r.directory.join("objects").join(hash).exists())
        );
        assert_eq!(s.expire_packages(&r).unwrap(), 0);
        assert!(stage.is_dir());
    }
}
#[test]
fn package_pending_capture_expiry_protects_active_accepted_retry_and_serializes_expired_retry() {
    let (_d, _root, r, s) = setup();
    let req = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    let original = s.start_package_export(&r, &req).unwrap();
    expire_capture_at(&r, &req.request_id, now() - 1);
    assert_eq!(s.expire_packages(&r).unwrap(), 0);
    cancel_export(&r, &s, &req);
    expire_capture_at(&r, &req.request_id, now() + 60_000);
    let status = s.package_status(&r, &req.request_id).unwrap();
    let retry = PackageControlRequest {
        request_id: id(),
        owner_project_id: req.base.project_id.clone(),
        operation_id: req.request_id.clone(),
        expected_operation_revision: status.operation_revision,
        action: PackageControlRequestAction::Retry,
    };
    let accepted = s.control_package(&r, &retry).unwrap();
    let retention = journal::lock(
        &s.directory
            .join(format!("package-retention-{}.lock", req.request_id)),
    )
    .unwrap();
    assert_eq!(s.start_package_export(&r, &req).unwrap(), original);
    assert_eq!(s.control_package(&r, &retry).unwrap(), accepted);
    drop(retention);
    let until = s
        .package_read(&r, &req.request_id)
        .unwrap()
        .capture_retry_until
        .unwrap();
    assert!(until > now() + CACHE_TTL - 60_000);
    expire_capture_at(&r, &req.request_id, now() - 1);
    assert_eq!(s.expire_packages(&r).unwrap(), 0);
    assert!(
        r.package_capture_expiry(&req.request_id)
            .unwrap()
            .unwrap()
            .1
            .unwrap()
            >= until
    );
    cancel_export(&r, &s, &req);
    expire_capture_at(&r, &req.request_id, now() - 1);
    assert_eq!(s.expire_packages(&r).unwrap(), 0);
    assert_eq!(s.control_package(&r, &retry).unwrap(), accepted);
    let mut op = s.package_read(&r, &req.request_id).unwrap();
    op.capture_retry_until = Some(now() - 1);
    journal::save(&s.package_op(&req.request_id), &op).unwrap();
    expire_capture_at(&r, &req.request_id, now() - 1);
    let claimed = std::sync::Arc::new(std::sync::Barrier::new(2));
    let release = std::sync::Arc::new(std::sync::Barrier::new(2));
    let a = claimed.clone();
    let b = release.clone();
    *r.source_action.lock().unwrap() = Some((
        "package-expiry-claimed".into(),
        Box::new(move || {
            a.wait();
            b.wait();
        }),
    ));
    let retry = PackageControlRequest {
        request_id: id(),
        owner_project_id: req.base.project_id.clone(),
        operation_id: req.request_id.clone(),
        expected_operation_revision: op.view.operation_revision,
        action: PackageControlRequestAction::Retry,
    };
    std::thread::scope(|scope| {
        let expiry = scope.spawn(|| s.expire_packages(&r));
        claimed.wait();
        let started = std::sync::Arc::new(std::sync::Barrier::new(2));
        let start = started.clone();
        let (store, repository, request) = (&s, &r, &retry);
        let concurrent = scope.spawn(move || {
            start.wait();
            store.control_package(repository, request)
        });
        started.wait();
        release.wait();
        assert_eq!(expiry.join().unwrap().unwrap(), 1);
        assert_eq!(concurrent.join().unwrap().unwrap_err().0, "PACKAGE_EXPIRED");
    });
    assert_eq!(
        s.control_package(&r, &retry).unwrap_err().0,
        "PACKAGE_EXPIRED"
    );
}

#[test]
#[cfg(target_os = "linux")]
fn package_ready_record_without_archive_expires_custody_when_completed_stage_is_replaced() {
    use std::os::unix::fs::symlink;
    for special in ["file", "symlink"] {
        let (d, _root, r, s) = setup();
        let req = ProjectPackageExportRequest {
            request_id: id(),
            base: r.read_package_base().unwrap(),
        };
        let original = s.start_package_export(&r, &req).unwrap();
        *r.source_fault.lock().unwrap() = Some("package-archive-ready".into());
        s.run_next(&r).unwrap();
        let status = s.package_status(&r, &req.request_id).unwrap();
        assert_eq!(status.state, PackageOperationViewState::Failed);
        let token = r
            .package_materialized_token(&req.request_id)
            .unwrap()
            .unwrap();
        let stage = s.directory.join(&token);
        let original_stage = stage.with_extension("preserved");
        std::fs::rename(&stage, &original_stage).unwrap();
        let outside = d.path().join("outside-evidence");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), b"outside untouched").unwrap();
        if special == "file" {
            std::fs::write(&stage, b"unknown file").unwrap();
        } else {
            symlink(&outside, &stage).unwrap();
        }
        let ready_path = s.package_path("archive-ready", &req.request_id);
        let mut ready: ArchiveReady = journal::read(&ready_path).unwrap();
        ready.view.expires_at = now() - 1;
        journal::save(&ready_path, &ready).unwrap();
        expire_capture_at(&r, &req.request_id, now() - 1);
        s.expire_packages(&r).unwrap();
        assert_eq!(
            r.package_capture_expiry(&req.request_id)
                .unwrap()
                .unwrap()
                .0,
            "expired"
        );
        assert_eq!(
            r.connection
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM package_capture_pins WHERE export_id=?1",
                    [&req.request_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            std::fs::read(outside.join("sentinel")).unwrap(),
            b"outside untouched"
        );
        if special == "file" {
            assert_eq!(std::fs::read(&stage).unwrap(), b"unknown file");
        } else {
            assert!(
                std::fs::symlink_metadata(&stage)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        }
        assert_eq!(s.package_status(&r, &req.request_id).unwrap(), status);
        assert_eq!(s.start_package_export(&r, &req).unwrap(), original);
        std::fs::remove_file(&stage).unwrap();
        std::fs::rename(&original_stage, &stage).unwrap();
        let archive = s.directory.join(format!("archive-{}.zip", req.request_id));
        let original_bytes = std::fs::read(
            s.directory
                .join(format!(".archive-{}-1.zip", req.request_id)),
        )
        .unwrap();
        std::fs::write(&archive, &original_bytes).unwrap();
        s.expire_packages(&r).unwrap();
        assert!(stage.is_dir());
        assert_eq!(std::fs::read(archive).unwrap(), original_bytes);
    }
}
#[test]
fn package_interrupted_bad_archive_and_restore_proofs_keep_status_revision_and_explicit_control_available()
 {
    for kind in ["archive", "restore"] {
        let (d, _root, r, s) = setup();
        if kind == "archive" {
            let req = ProjectPackageExportRequest {
                request_id: id(),
                base: r.read_package_base().unwrap(),
            };
            let original = s.start_package_export(&r, &req).unwrap();
            drop(s);
            let s = ProjectTransferStore::open(&d.path().join("app")).unwrap();
            let path = s.directory.join(format!("archive-{}.zip", req.request_id));
            std::fs::write(&path, b"unknown archive").unwrap();
            let status = s.package_status(&r, &req.request_id).unwrap();
            assert_eq!(status.state, PackageOperationViewState::Interrupted);
            let retry = PackageControlRequest {
                request_id: id(),
                owner_project_id: req.base.project_id.clone(),
                operation_id: req.request_id.clone(),
                expected_operation_revision: status.operation_revision,
                action: PackageControlRequestAction::Retry,
            };
            s.control_package(&r, &retry).unwrap();
            s.run_next(&r).unwrap();
            let failed = s.package_status(&r, &req.request_id).unwrap();
            assert_eq!(failed.state, PackageOperationViewState::Failed);
            assert_eq!(
                failed.failure_code.as_deref(),
                Some("PACKAGE_ARCHIVE_INVALID")
            );
            assert_eq!(std::fs::read(path).unwrap(), b"unknown archive");
            assert_eq!(s.start_package_export(&r, &req).unwrap(), original);
        } else {
            let (_, bytes) = export(&r, &s);
            let inspection = inspect(&r, &s, &bytes);
            let target = s
                .issue_package_restore_target(
                    &r,
                    &PackageRestoreTargetRequest {
                        request_id: id(),
                        owner_project_id: inspection.owner_project_id.clone(),
                        inspection_id: inspection.inspection_id.clone(),
                        destination: PackageRestoreTargetRequestDestination::Managed,
                    },
                )
                .unwrap();
            let request = PackageRestoreRequest {
                request_id: id(),
                owner_project_id: inspection.owner_project_id.clone(),
                inspection_id: inspection.inspection_id.clone(),
                target_id: target.target_id.clone(),
            };
            let original = s.start_package_restore(&r, &request).unwrap();
            let root = s.roots.join(&target.target_id);
            std::fs::create_dir_all(root.join(".scenesparrow")).unwrap();
            std::fs::write(root.join("sentinel"), b"unknown target").unwrap();
            let marker = serde_json::json!({"version":1,"requestId":request.request_id,"target":target,"intakeId":inspection.intake_id,"archiveHash":s.intake_scoped(&r,&inspection.intake_id).unwrap().view.hash});
            std::fs::write(
                root.join(".scenesparrow/package-ready.json"),
                serde_json::to_vec(&marker).unwrap(),
            )
            .unwrap();
            drop(s);
            let s = ProjectTransferStore::open(&d.path().join("app")).unwrap();
            let status = s.package_status(&r, &request.request_id).unwrap();
            assert_eq!(status.state, PackageOperationViewState::Interrupted);
            let retry = PackageControlRequest {
                request_id: id(),
                owner_project_id: request.owner_project_id.clone(),
                operation_id: request.request_id.clone(),
                expected_operation_revision: status.operation_revision,
                action: PackageControlRequestAction::Retry,
            };
            s.control_package(&r, &retry).unwrap();
            s.run_next(&r).unwrap();
            let failed = s.package_status(&r, &request.request_id).unwrap();
            assert_eq!(failed.state, PackageOperationViewState::Failed);
            assert_eq!(
                failed.failure_code.as_deref(),
                Some("PACKAGE_TARGET_INVALID")
            );
            assert_eq!(
                std::fs::read(root.join("sentinel")).unwrap(),
                b"unknown target"
            );
            assert_eq!(s.start_package_restore(&r, &request).unwrap(), original);
        }
    }
}

#[test]
fn package_original_capture_replay_proof_releases_journal_and_preserves_concurrent_cancel() {
    let (d, _root, r, s) = setup();
    let req = ProjectPackageExportRequest {
        request_id: id(),
        base: r.read_package_base().unwrap(),
    };
    *r.source_fault.lock().unwrap() = Some("package-pins-after-install".into());
    assert_eq!(s.start_package_export(&r, &req).unwrap_err().0, "TEST_CUT");
    drop(s);
    let s = ProjectTransferStore::open(&d.path().join("app")).unwrap();
    let entered = std::sync::Arc::new(std::sync::Barrier::new(2));
    let release = std::sync::Arc::new(std::sync::Barrier::new(2));
    let a = entered.clone();
    let b = release.clone();
    *r.source_action.lock().unwrap() = Some((
        "package-capture-replay-proof".into(),
        Box::new(move || {
            a.wait();
            b.wait();
        }),
    ));
    std::thread::scope(|scope| {
        let replay = scope.spawn(|| s.start_package_export(&r, &req));
        entered.wait();
        let status = s.package_status(&r, &req.request_id).unwrap();
        assert_eq!(status.state, PackageOperationViewState::Interrupted);
        let control = PackageControlRequest {
            request_id: id(),
            owner_project_id: req.base.project_id.clone(),
            operation_id: req.request_id.clone(),
            expected_operation_revision: status.operation_revision,
            action: PackageControlRequestAction::Cancel,
        };
        let cancelled = s.control_package(&r, &control).unwrap();
        release.wait();
        let original = replay.join().unwrap().unwrap();
        assert!(original.accepted);
        assert_eq!(s.start_package_export(&r, &req).unwrap(), original);
        assert_eq!(s.package_status(&r, &req.request_id).unwrap(), cancelled);
    });
}

#[test]
fn package_known_complete_work_capture_expires_after_discard_without_refreshing_original_authority()
{
    for terminal in ["failed", "cancelled"] {
        let (_d, _root, r, s) = setup();
        let item = copy(&r);
        let request = WorkCopyPackageExportRequest {
            request_id: id(),
            owner_project_id: item.project_id.clone(),
            work_item_id: item.work_item_id.clone(),
            expected_work_item_revision: item.item_revision,
        };
        let original = s.start_work_copy_package(&r, &request).unwrap();
        *r.source_fault.lock().unwrap() = Some("package-archive-ready".into());
        s.run_next(&r).unwrap();
        let path = s.package_path("work-inventory", &request.request_id);
        let mut capture: WorkCapture = large_read(&path, 16 << 20).unwrap();
        assert!(capture.expires_at > now() + CACHE_TTL - 60_000);
        assert!(!capture.expired);
        let stage = s.directory.join(&capture.stage);
        assert!(stage.join("project/public/silence.bin").is_file());
        let failed = s.package_status(&r, &request.request_id).unwrap();
        assert_eq!(failed.state, PackageOperationViewState::Failed);
        let retry = PackageControlRequest {
            request_id: id(),
            owner_project_id: item.project_id.clone(),
            operation_id: request.request_id.clone(),
            expected_operation_revision: failed.operation_revision,
            action: PackageControlRequestAction::Retry,
        };
        let accepted = s.control_package(&r, &retry).unwrap();
        assert!(
            s.package_read(&r, &request.request_id)
                .unwrap()
                .capture_retry_until
                .unwrap()
                > now() + CACHE_TTL - 60_000
        );
        capture.expires_at = now() - 1;
        journal::save(&path, &capture).unwrap();
        assert_eq!(s.expire_packages(&r).unwrap(), 0);
        let cancellation = if terminal == "cancelled" {
            let cancel = PackageControlRequest {
                request_id: id(),
                owner_project_id: item.project_id.clone(),
                operation_id: request.request_id.clone(),
                expected_operation_revision: accepted.operation_revision,
                action: PackageControlRequestAction::Cancel,
            };
            let result = s.control_package(&r, &cancel).unwrap();
            Some((cancel, result))
        } else {
            *r.source_fault.lock().unwrap() = Some("package-archive-ready".into());
            s.run_next(&r).unwrap();
            None
        };
        assert_eq!(s.expire_packages(&r).unwrap(), 0); // last accepted retry owns seven more days
        let base = r.read_package_base().unwrap();
        let current = r.work_item(&item.work_item_id).unwrap();
        r.discard_work_item(&WorkItemDiscardRequest {
            request_id: id(),
            project_id: item.project_id.clone(),
            expected_working_revision: base.working_revision,
            expected_graph_hash: base.graph_hash,
            expected_graph_generation: base.graph_generation,
            work_item_id: item.work_item_id.clone(),
            expected_item_revision: current.item_revision,
            candidate_id: None,
            disposition: WorkItemDiscardRequestDisposition::DiscardCopy,
        })
        .unwrap();
        assert!(stage.is_dir());
        let before = s.package_status(&r, &request.request_id).unwrap();
        let mut op = s.package_read(&r, &request.request_id).unwrap();
        op.capture_retry_until = Some(now() - 1);
        journal::save(&s.package_op(&request.request_id), &op).unwrap();
        let reader = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(
                s.directory
                    .join(format!("package-reader-{}.lock", request.request_id)),
            )
            .unwrap();
        reader.try_lock_shared().unwrap();
        assert_eq!(s.expire_packages(&r).unwrap(), 0);
        drop(reader);
        assert_eq!(s.expire_packages(&r).unwrap(), 1);
        assert!(!stage.exists());
        let expired: WorkCapture = large_read(&path, 16 << 20).unwrap();
        assert!(expired.expired);
        assert_eq!(s.start_work_copy_package(&r, &request).unwrap(), original);
        assert_eq!(s.package_status(&r, &request.request_id).unwrap(), before);
        assert_eq!(s.control_package(&r, &retry).unwrap(), accepted);
        if let Some((control, result)) = cancellation {
            assert_eq!(s.control_package(&r, &control).unwrap(), result);
        }
        let retry = PackageControlRequest {
            request_id: id(),
            owner_project_id: item.project_id.clone(),
            operation_id: request.request_id.clone(),
            expected_operation_revision: before.operation_revision,
            action: PackageControlRequestAction::Retry,
        };
        for _ in 0..2 {
            assert_eq!(
                s.control_package(&r, &retry).unwrap_err().0,
                "PACKAGE_EXPIRED"
            );
        }
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(stage.join("sentinel"), b"later unknown work stage").unwrap();
        assert_eq!(s.expire_packages(&r).unwrap(), 0);
        assert_eq!(
            std::fs::read(stage.join("sentinel")).unwrap(),
            b"later unknown work stage"
        );
        assert_eq!(
            r.work_item(&item.work_item_id).unwrap().state,
            WorkItemViewState::Discarded
        );
        assert_eq!(
            r.connection
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM package_capture_pins", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }
}

#[test]
fn package_actual_large_work_capture_expiry_uses_its_large_atomic_record_bound() {
    for ready in [false, true] {
        let (_d, _root, r, s) = setup();
        let item = copy(&r);
        let location = r.reveal_work_item_location(&item.work_item_id).unwrap();
        let files = location.join("project/public/many-small-files");
        std::fs::create_dir_all(&files).unwrap();
        for n in 0..800 {
            std::fs::write(files.join(format!("creative-reference-{n:04}.txt")), b"x").unwrap();
        }
        let request = WorkCopyPackageExportRequest {
            request_id: id(),
            owner_project_id: item.project_id.clone(),
            work_item_id: item.work_item_id.clone(),
            expected_work_item_revision: item.item_revision,
        };
        let original = s.start_work_copy_package(&r, &request).unwrap();
        if !ready {
            *r.source_fault.lock().unwrap() = Some("package-archive-ready".into());
        }
        s.run_next(&r).unwrap();
        let original_status = s.package_status(&r, &request.request_id).unwrap();
        assert_eq!(
            original_status.state,
            if ready {
                PackageOperationViewState::Succeeded
            } else {
                PackageOperationViewState::Failed
            }
        );
        let path = s.package_path("work-inventory", &request.request_id);
        assert!(std::fs::metadata(&path).unwrap().len() > 64 * 1024);
        let mut capture: WorkCapture = large_read(&path, 16 << 20).unwrap();
        assert!(capture.descriptor.members.len() >= 800);
        let original_descriptor = serde_json::to_vec(&capture.descriptor).unwrap();
        let stage = s.directory.join(&capture.stage);
        assert!(stage.is_dir());
        capture.expires_at = now() - 1;
        large_save(&path, &capture, 16 << 20).unwrap();
        if ready {
            let ready_path = s.package_path("archive-ready", &request.request_id);
            let mut archive: ArchiveReady = journal::read(&ready_path).unwrap();
            archive.view.expires_at = now() - 1;
            journal::save(&ready_path, &archive).unwrap();
        }
        assert_eq!(s.expire_packages(&r).unwrap(), 1);
        let expired: WorkCapture = large_read(&path, 16 << 20).unwrap();
        assert!(expired.expired);
        assert_eq!(
            serde_json::to_vec(&expired.descriptor).unwrap(),
            original_descriptor
        );
        assert!(std::fs::metadata(&path).unwrap().len() > 64 * 1024);
        assert!(!stage.exists());
        assert!(files.join("creative-reference-0799.txt").is_file());
        assert_eq!(s.start_work_copy_package(&r, &request).unwrap(), original);
        assert_eq!(
            s.package_status(&r, &request.request_id).unwrap(),
            original_status
        );
        if !ready {
            let retry = PackageControlRequest {
                request_id: id(),
                owner_project_id: item.project_id.clone(),
                operation_id: request.request_id.clone(),
                expected_operation_revision: original_status.operation_revision,
                action: PackageControlRequestAction::Retry,
            };
            for _ in 0..2 {
                assert_eq!(
                    s.control_package(&r, &retry).unwrap_err().0,
                    "PACKAGE_EXPIRED"
                );
            }
        }
        std::fs::create_dir(&stage).unwrap();
        std::fs::write(stage.join("sentinel"), b"later unknown large-work stage").unwrap();
        assert_eq!(s.expire_packages(&r).unwrap(), 0);
        assert_eq!(
            std::fs::read(stage.join("sentinel")).unwrap(),
            b"later unknown large-work stage"
        );
    }
}
