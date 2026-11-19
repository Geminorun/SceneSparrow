//! Bounded verification/projection data scoped to one serialized writer operation.
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Instant, SystemTime},
};
#[derive(PartialEq, Eq)]
struct Stamp {
    length: u64,
    modified: Option<SystemTime>,
    identity: String,
    #[cfg(unix)]
    change_time: (i64, i64),
}
struct Entry {
    stamp: Stamp,
    bytes: Vec<u8>,
}
#[derive(Default)]
struct Metrics {
    objects: BTreeMap<PathBuf, Entry>,
    read_bytes: u64,
    hash_bytes: u64,
    cache_hits: u64,
    cached_bytes: usize,
}
thread_local! {static VERIFIED:RefCell<Option<Metrics>>=const{RefCell::new(None)};}
pub(crate) struct Operation {
    label: &'static str,
    started: Instant,
    last: Instant,
    phases: Vec<(&'static str, u128)>,
}
impl Operation {
    pub fn begin(label: &'static str) -> Self {
        VERIFIED.with(|v| *v.borrow_mut() = Some(Metrics::default()));
        let now = Instant::now();
        Self {
            label,
            started: now,
            last: now,
            phases: vec![],
        }
    }
    pub fn phase(&mut self, name: &'static str) {
        let now = Instant::now();
        self.phases
            .push((name, now.duration_since(self.last).as_micros()));
        self.last = now;
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let metrics = VERIFIED.with(|v| v.borrow_mut().take()).unwrap_or_default();
        if std::env::var_os("SCENESPARROW_PROFILE_WRITES").is_some() {
            eprintln!(
                "{}",
                serde_json::json!({"event":"storage.operation","operation":self.label,"totalUs":self.started.elapsed().as_micros(),"phases":self.phases,"objectReadBytes":metrics.read_bytes,"objectHashBytes":metrics.hash_bytes,"verifiedReuse":metrics.cache_hits})
            );
        }
    }
}
/// Reuse verified bytes only while their file identity/size/time still match in this
/// operation. Missing/replaced/corrupt bytes are never reconstructed from a cache.
pub(crate) fn read(path: &Path, digest: &str, mut file: std::fs::File) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let metadata = file.metadata()?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = format!("{:?}", file_id::get_file_id(path)?);
    if !metadata.is_file() {
        return Err(std::io::Error::other("immutable object unavailable"));
    }
    let stamp = Stamp {
        length: metadata.len(),
        modified: metadata.modified().ok(),
        identity,
        #[cfg(unix)]
        change_time: {
            use std::os::unix::fs::MetadataExt;
            (metadata.ctime(), metadata.ctime_nsec())
        },
    };
    VERIFIED.with(|v| {
        let mut state = v.borrow_mut();
        if let Some(metrics) = state.as_mut()
            && let Some(previous) = metrics.objects.get(path)
            && previous.stamp == stamp
        {
            metrics.cache_hits += 1;
            return Ok(previous.bytes.clone());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if after.ctime() != metadata.ctime() || after.ctime_nsec() != metadata.ctime_nsec() {
                return Err(std::io::Error::other("immutable object changed"));
            }
        }
        if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
            return Err(std::io::Error::other("immutable object changed"));
        }
        if let Some(metrics) = state.as_mut() {
            metrics.read_bytes += bytes.len() as u64;
            metrics.hash_bytes += bytes.len() as u64;
        }
        if crate::storage::hash(&bytes) != digest {
            return Err(std::io::Error::other("immutable object integrity"));
        }
        if let Some(metrics) = state.as_mut()
            && metrics.cached_bytes + bytes.len() <= 64 * 1024 * 1024
        {
            if let Some(previous) = metrics.objects.remove(path) {
                metrics.cached_bytes -= previous.bytes.len();
            }
            metrics.cached_bytes += bytes.len();
            metrics.objects.insert(
                path.to_path_buf(),
                Entry {
                    stamp,
                    bytes: bytes.clone(),
                },
            );
        }
        Ok(bytes)
    })
}
