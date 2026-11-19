//! Private native new-file delivery. Paths never cross the renderer contract.
use super::*;
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Delivery {
    digest: String,
    archive_id: String,
    source: String,
    result: NativePackageSaveResult,
}
impl ProjectTransferStore {
    pub fn package_native_save_status(
        &self,
        r: &SqliteProjectRepository,
        archive_id: &str,
        request_id: &str,
    ) -> Result<NativePackageSaveResult> {
        uuid(request_id)?;
        uuid(archive_id)?;
        let path = self.package_path("native-delivery", request_id);
        if !path.exists() {
            return Err(fail("PACKAGE_NOT_FOUND"));
        }
        let record: Delivery = journal::read(&path)?;
        if record.archive_id != archive_id
            || record.result.request_id != request_id
            || record.source != r.migration_source_identity()?
        {
            return Err(fail("PACKAGE_NOT_FOUND"));
        }
        Ok(record.result)
    }
    pub fn save_package_new(
        &self,
        r: &SqliteProjectRepository,
        archive_id: &str,
        request_id: &str,
        destination: &Path,
    ) -> Result<NativePackageSaveResult> {
        self.save_package_new_limited(
            r,
            archive_id,
            request_id,
            destination,
            Limits::default().compressed,
        )
    }
    pub(super) fn save_package_new_limited(
        &self,
        r: &SqliteProjectRepository,
        archive_id: &str,
        request_id: &str,
        destination: &Path,
        limit: u64,
    ) -> Result<NativePackageSaveResult> {
        uuid(request_id)?;
        uuid(archive_id)?;
        if !cfg!(target_os = "linux") {
            return Err(fail("SOURCE_PLATFORM_UNSUPPORTED"));
        }
        let digest = hash(&db(serde_json::to_vec(&(archive_id, destination)))?);
        let source = r.migration_source_identity()?;
        let record = self.package_path("native-delivery", request_id);
        let _lease = journal::lock(&self.package_path("native-delivery-lock", request_id))?;
        if record.exists() {
            let previous: Delivery = journal::read(&record)?;
            if previous.digest != digest
                || previous.archive_id != archive_id
                || previous.result.request_id != request_id
                || previous.source != source
            {
                return Err(fail("PACKAGE_REQUEST_CONFLICT"));
            }
            return Ok(previous.result);
        }
        // Authorization and immutable size/hash are owned by the core reader.
        let mut reader = self.read_package_archive(r, archive_id)?;
        let view = reader.view().clone();
        if view.size < 0 || view.size as u64 > limit {
            return Err(fail("PACKAGE_SIZE_LIMIT"));
        }
        let parent_path = destination
            .parent()
            .filter(|p| p.is_absolute())
            .ok_or(fail("SOURCE_PATH_UNSAFE"))?;
        let name = destination
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(fail("SOURCE_PATH_UNSAFE"))?;
        let parent = Parent::open(parent_path, name)?;
        let outcome = if parent.open_file(name)?.is_some() {
            NativePackageSaveResultOutcome::Exists
        } else {
            NativePackageSaveResultOutcome::Unknown
        };
        let mut delivery = Delivery {
            digest,
            archive_id: archive_id.into(),
            source,
            result: NativePackageSaveResult {
                request_id: request_id.into(),
                outcome,
                filename: name.chars().take(120).collect(),
            },
        };
        // Unknown is durable before the first destination write. Replays never publish again.
        journal::save(&record, &delivery)?;
        if delivery.result.outcome == NativePackageSaveResultOutcome::Exists {
            return Ok(delivery.result);
        }
        let stage = format!(".scenesparrow-package-{request_id}.tmp");
        let result = (|| -> Result<()> {
            let mut output = parent.create_file(&stage)?;
            let created = Parent::file_identity(&output)?;
            reader.stream_held(&mut output)?;
            db(output.flush())?;
            db(output.sync_all())?;
            parent.sync()?;
            parent.verify()?;
            r.source_cut("package-native-staged")?;
            let closing = reader.cancellation_flag();
            let mut check = || {
                r.source_cut("package-native-proof")?;
                if closing.load(std::sync::atomic::Ordering::Acquire) {
                    Err(fail("PROJECT_CLOSING"))
                } else {
                    Ok(())
                }
            };
            let proof = parent
                .streamed_checked(&stage, limit, &mut check)?
                .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
            if (proof.0, proof.1) != (view.hash.clone(), view.size as u64) || proof.2 != created {
                return Err(fail("PACKAGE_ARCHIVE_INVALID"));
            }
            if reader
                .cancellation_flag()
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return Err(fail("PROJECT_CLOSING"));
            }
            r.source_cut("package-native-publish")?;
            parent.rename_no_replace(&stage, name)?;
            let published = parent
                .streamed_checked(name, limit, &mut check)?
                .ok_or(fail("DELIVERY_STATUS_UNKNOWN"))?;
            if (published.0, published.1, published.2) != (view.hash, view.size as u64, proof.2) {
                return Err(fail("DELIVERY_STATUS_UNKNOWN"));
            }
            parent.verify()
        })();
        if result.is_ok() {
            delivery.result.outcome = NativePackageSaveResultOutcome::Saved;
            journal::save(&record, &delivery)?;
        }
        // Unknown stage/destination bytes are preserved. No pathname cleanup/retry.
        Ok(delivery.result)
    }
}
