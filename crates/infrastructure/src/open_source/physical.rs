//! Descriptor-relative creative-file access. An opened parent prevents an
//! ancestor replacement from redirecting writes; path rechecks report the race.
use super::*;
#[cfg(unix)]
use std::{
    ffi::CString,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
};
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Identity {
    device: u64,
    inode: u64,
}
#[cfg(unix)]
fn identity(file: &File) -> Result<Identity> {
    let m = db(file.metadata())?;
    Ok(Identity {
        device: m.dev(),
        inode: m.ino(),
    })
}
pub(crate) struct Parent {
    #[cfg(unix)]
    root: File,
    #[cfg(unix)]
    directory: File,
    #[cfg(unix)]
    root_path: PathBuf,
    #[cfg(unix)]
    relative: String,
    pub name: String,
}
impl Parent {
    #[cfg(unix)]
    pub fn file_identity(file: &File) -> Result<Identity> {
        identity(file)
    }
    #[cfg(not(unix))]
    pub fn file_identity(_: &File) -> Result<Identity> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(unix)]
    pub fn open(root: &Path, relative: &str) -> Result<Self> {
        scenesparrow_domain::open_project::validate_portable_paths(&[relative])
            .map_err(format_error)?;
        let root_file = db(File::options()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(root))?;
        let mut directory = db(root_file.try_clone())?;
        let mut parts = relative.split('/').peekable();
        let mut name = String::new();
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                name = part.into();
                break;
            }
            directory = Self::openat(&directory, part, libc::O_RDONLY | libc::O_DIRECTORY)?;
        }
        Ok(Self {
            root: root_file,
            directory,
            root_path: root.into(),
            relative: relative.into(),
            name,
        })
    }
    #[cfg(unix)]
    fn openat(directory: &File, name: &str, flags: i32) -> Result<File> {
        let name = CString::new(name).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        // SAFETY: the C string and descriptor live through the call; ownership
        // of the returned descriptor transfers to File exactly once.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(fail("SOURCE_PATH_UNSAFE"));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    /// Rebind the path proof after a directory rename while retaining its
    /// original live descriptor. A recycled persisted inode is not ownership.
    #[cfg(unix)]
    pub fn relocated_directory(mut self, relative: &str) -> Result<Self> {
        let current = Self::open(&self.root_path, relative)?;
        if identity(&current.root)? != identity(&self.root)?
            || identity(&current.directory)? != identity(&self.directory)?
        {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        self.relative = relative.into();
        self.name = current.name;
        self.verify()?;
        Ok(self)
    }
    #[cfg(not(unix))]
    pub fn relocated_directory(self, _: &str) -> Result<Self> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    /// Remove only this continuously held discarded container. Enumeration and
    /// recursion use descriptors; a stage pathname swap cannot redirect them.
    #[cfg(target_os = "linux")]
    pub fn remove_discarded_container(&self, entry: &Parent) -> Result<()> {
        entry.verify()?;
        let same_entry = || -> Result<()> {
            let current = Self::openat(
                &entry.directory,
                &entry.name,
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?;
            if identity(&current)? != identity(&self.directory)? {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            Ok(())
        };
        same_entry()?;
        // Private cleanup limits bound stack, live descriptors and traversal.
        // They do not change creative inventory/graph admission limits.
        let limits = (64, 100_000);
        #[cfg(test)]
        let limits = DISCARD_CLEANUP_TEST_LIMITS.get().unwrap_or(limits);
        let mut remaining_entries = limits.1;
        remove_discarded_entries(&self.directory, limits.0, &mut remaining_entries)?;
        same_entry()?;
        let name = CString::new(entry.name.as_str()).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        // SAFETY: parent descriptor and C name remain live; unlinkat never
        // traverses a replacement directory and refuses a nonempty stranger.
        if unsafe {
            libc::unlinkat(
                entry.directory.as_raw_fd(),
                name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } != 0
        {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
        entry.sync()?;
        entry.verify()
    }
    #[cfg(not(target_os = "linux"))]
    pub fn remove_discarded_container(&self, _: &Parent) -> Result<()> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    /// In-process preparation path anchored to this continuously held directory.
    /// The final dot allows existing no-follow root opens without treating the
    /// proc descriptor link itself as a creative symlink. Never persist this path
    /// or pass it to a worker: the owning Parent must remain alive in this process.
    #[cfg(target_os = "linux")]
    pub fn bound_directory_path(&self) -> Result<PathBuf> {
        self.verify()?;
        let path = PathBuf::from(format!("/proc/self/fd/{}/.", self.directory.as_raw_fd()));
        let held = db(File::open(&path))?;
        if identity(&held)? != identity(&self.directory)? {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        Ok(path)
    }
    #[cfg(not(target_os = "linux"))]
    pub fn bound_directory_path(&self) -> Result<PathBuf> {
        Err(fail("SOURCE_PLATFORM_UNSUPPORTED"))
    }
    #[cfg(unix)]
    pub fn directory_identity(&self) -> Result<Identity> {
        identity(&self.directory)
    }
    #[cfg(not(unix))]
    pub fn directory_identity(&self) -> Result<Identity> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(unix)]
    pub fn verify(&self) -> Result<()> {
        let current = Self::open(&self.root_path, &self.relative)?;
        if identity(&current.root)? != identity(&self.root)?
            || identity(&current.directory)? != identity(&self.directory)?
        {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        Ok(())
    }
    #[cfg(unix)]
    pub fn read(&self, name: &str, allow_link: bool) -> Result<Option<(Vec<u8>, Identity)>> {
        self.read_limit(
            name,
            allow_link,
            scenesparrow_domain::manuscript::MAX_DOCUMENT_BYTES as u64,
        )
    }
    #[cfg(unix)]
    pub fn read_limit(
        &self,
        name: &str,
        allow_link: bool,
        limit: u64,
    ) -> Result<Option<(Vec<u8>, Identity)>> {
        let c_name = CString::new(name).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                c_name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(fail("SOURCE_PATH_UNSAFE"))
            };
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let before = db(file.metadata())?;
        if !before.is_file() || (!allow_link && before.nlink() != 1) || before.len() > limit {
            return Err(fail("SOURCE_PATH_UNSAFE"));
        }
        use std::io::Read;
        let mut bytes = vec![];
        db((&file).take(limit + 1).read_to_end(&mut bytes))?;
        let after = db(file.metadata())?;
        if bytes.len() as u64 != before.len()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        self.verify()?;
        Ok(Some((bytes, identity(&file)?)))
    }
    #[cfg(unix)]
    pub fn stage(&self, name: &str, bytes: &[u8]) -> Result<Identity> {
        self.verify()?;
        let mut file = Self::openat(
            &self.directory,
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        db(file.write_all(bytes))?;
        db(file.sync_all())?;
        self.sync()?;
        identity(&file)
    }
    #[cfg(unix)]
    pub fn unlink(&self, name: &str) -> Result<()> {
        self.verify()?;
        let name = CString::new(name).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let result = unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) };
        if result != 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
        self.sync()?;
        self.verify()
    }
    #[cfg(unix)]
    pub fn sync(&self) -> Result<()> {
        db(self.directory.sync_all())
    }
}
impl Parent {
    #[cfg(target_os = "linux")]
    pub fn rename_no_replace(&self, from: &str, to: &str) -> Result<()> {
        self.verify()?;
        let from = CString::new(from).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let to = CString::new(to).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let result = unsafe {
            libc::renameat2(
                self.directory.as_raw_fd(),
                from.as_ptr(),
                self.directory.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        self.sync()?;
        self.verify()
    }
    #[cfg(target_os = "linux")]
    pub fn rename_into(&self, from: &str, other: &Parent, to: &str) -> Result<()> {
        self.verify()?;
        other.verify()?;
        let from = CString::new(from).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let to = CString::new(to).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let result = unsafe {
            libc::renameat2(
                self.directory.as_raw_fd(),
                from.as_ptr(),
                other.directory.as_raw_fd(),
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
        self.sync()?;
        other.sync()?;
        self.verify()?;
        other.verify()
    }
    #[cfg(not(target_os = "linux"))]
    pub fn rename_no_replace(&self, _: &str, _: &str) -> Result<()> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(target_os = "linux")]
    pub fn exchange(&self, first: &str, second: &str) -> Result<()> {
        self.verify()?;
        let first = CString::new(first).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let second = CString::new(second).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let result = unsafe {
            libc::renameat2(
                self.directory.as_raw_fd(),
                first.as_ptr(),
                self.directory.as_raw_fd(),
                second.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        };
        if result != 0 {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
        self.sync()?;
        self.verify()
    }
    #[cfg(not(target_os = "linux"))]
    pub fn exchange(&self, _: &str, _: &str) -> Result<()> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(not(unix))]
    pub fn open(_: &Path, _: &str) -> Result<Self> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(not(unix))]
    pub fn verify(&self) -> Result<()> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(not(unix))]
    pub fn read(&self, _: &str, _: bool) -> Result<Option<(Vec<u8>, Identity)>> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(not(unix))]
    pub fn read_limit(&self, _: &str, _: bool, _: u64) -> Result<Option<(Vec<u8>, Identity)>> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(not(unix))]
    pub fn stage(&self, _: &str, _: &[u8]) -> Result<Identity> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(not(unix))]
    pub fn unlink(&self, _: &str) -> Result<()> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
}

impl Parent {
    #[cfg(target_os = "linux")]
    pub fn entries(&self, limit: usize) -> Result<Vec<String>> {
        self.verify()?;
        let path = format!("/proc/self/fd/{}", self.directory.as_raw_fd());
        let mut names = Vec::new();
        for entry in db(std::fs::read_dir(path))? {
            if names.len() >= limit {
                return Err(fail("GRAPH_BUDGET_EXCEEDED"));
            }
            names.push(
                db(entry)?
                    .file_name()
                    .into_string()
                    .map_err(|_| fail("SOURCE_PATH_UNSAFE"))?,
            );
        }
        names.sort();
        Ok(names)
    }
    #[cfg(not(target_os = "linux"))]
    pub fn entries(&self, limit: usize) -> Result<Vec<String>> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(unix)]
    pub fn open_file(&self, name: &str) -> Result<Option<(File, Identity)>> {
        let c_name = CString::new(name).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                c_name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(fail("SOURCE_PATH_UNSAFE"))
            };
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = db(file.metadata())?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(fail("SOURCE_PATH_UNSAFE"));
        }
        let id = identity(&file)?;
        Ok(Some((file, id)))
    }
    #[cfg(not(unix))]
    pub fn open_file(&self, _: &str) -> Result<Option<(File, Identity)>> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    pub fn streamed(&self, name: &str, limit: u64) -> Result<Option<(String, u64, Identity)>> {
        self.streamed_checked(name, limit, &mut || Ok(()))
    }
    pub fn streamed_checked(
        &self,
        name: &str,
        limit: u64,
        check: &mut dyn FnMut() -> Result<()>,
    ) -> Result<Option<(String, u64, Identity)>> {
        let Some((mut file, id)) = self.open_file(name)? else {
            return Ok(None);
        };
        let before = db(file.metadata())?;
        struct CheckedRead<'a> {
            file: &'a mut File,
            check: &'a mut dyn FnMut() -> Result<()>,
        }
        impl std::io::Read for CheckedRead<'_> {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                (self.check)().map_err(|_| std::io::Error::other("work cancelled"))?;
                std::io::Read::read(self.file, bytes)
            }
        }
        let copied = crate::storage::objects::stream_copy(
            &mut CheckedRead {
                file: &mut file,
                check,
            },
            &mut std::io::sink(),
            limit,
        );
        check()?;
        let (hash, size) = copied?;
        let after = db(file.metadata())?;
        if size != before.len()
            || size != after.len()
            || before.modified().ok() != after.modified().ok()
        {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        #[cfg(unix)]
        if before.ctime() != after.ctime() || before.ctime_nsec() != after.ctime_nsec() {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        self.verify()?;
        #[cfg(test)]
        crate::storage::objects::counted_stream(&hash, size);
        Ok(Some((hash, size, id)))
    }
    #[cfg(unix)]
    pub fn create_file(&self, name: &str) -> Result<File> {
        self.verify()?;
        Self::openat(
            &self.directory,
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )
    }
    #[cfg(not(unix))]
    pub fn create_file(&self, _: &str) -> Result<File> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(unix)]
    pub fn stage_object(
        &self,
        name: &str,
        repo: &SqliteProjectRepository,
        hash: &str,
    ) -> Result<Identity> {
        self.verify()?;
        let mut file = Self::openat(
            &self.directory,
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        repo.stream_object_to(hash, &mut file)?;
        db(file.sync_all())?;
        self.sync()?;
        identity(&file)
    }
    #[cfg(not(unix))]
    pub fn stage_object(&self, _: &str, _: &SqliteProjectRepository, _: &str) -> Result<Identity> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(target_os = "linux")]
    fn check_alias(directory: &File, name: &str) -> Result<()> {
        let expected = scenesparrow_domain::open_project::portable_key(name);
        for (index, entry) in db(std::fs::read_dir(format!(
            "/proc/self/fd/{}",
            directory.as_raw_fd()
        )))?
        .enumerate()
        {
            if index > 640_000 {
                return Err(fail("GRAPH_BUDGET_EXCEEDED"));
            }
            let entry = db(entry)?
                .file_name()
                .into_string()
                .map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
            if entry != name && scenesparrow_domain::open_project::portable_key(&entry) == expected
            {
                return Err(fail("PATH_COLLISION"));
            }
        }
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    fn check_alias(_: &File, _: &str) -> Result<()> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(unix)]
    pub fn open_creating(root: &Path, relative: &str) -> Result<Self> {
        scenesparrow_domain::open_project::validate_portable_paths(&[relative])
            .map_err(format_error)?;
        let root_file = db(File::options()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(root))?;
        let mut directory = db(root_file.try_clone())?;
        let parts = relative.split('/').collect::<Vec<_>>();
        for part in &parts[..parts.len() - 1] {
            Self::check_alias(&directory, part)?;
            let name = CString::new(*part).map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
            let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
            if result != 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(fail("SOURCE_PATH_UNSAFE"));
            }
            db(directory.sync_all())?;
            directory = Self::openat(&directory, part, libc::O_RDONLY | libc::O_DIRECTORY)?;
        }
        Self::check_alias(&directory, parts[parts.len() - 1])?;
        let parent = Self {
            root: root_file,
            directory,
            root_path: root.into(),
            relative: relative.into(),
            name: parts[parts.len() - 1].into(),
        };
        parent.verify()?;
        Ok(parent)
    }
    #[cfg(not(unix))]
    pub fn open_creating(_: &Path, _: &str) -> Result<Self> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
}

// This capability is private to one-shot recorded-copy disposal. It is never
// reconstructed from a persisted pathname or exposed to a renderer.
#[cfg(target_os = "linux")]
fn remove_discarded_entries(
    directory: &File,
    remaining_depth: usize,
    remaining_entries: &mut usize,
) -> Result<()> {
    struct Entries(*mut libc::DIR);
    impl Drop for Entries {
        fn drop(&mut self) {
            // SAFETY: fdopendir transferred sole ownership to this stream.
            unsafe { libc::closedir(self.0) };
        }
    }
    // SAFETY: dup creates a descriptor owned by fdopendir/Entries below.
    let fd = unsafe { libc::dup(directory.as_raw_fd()) };
    if fd < 0 {
        return Err(fail("STORAGE_UNAVAILABLE"));
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err(fail("STORAGE_UNAVAILABLE"));
    }
    let entries = Entries(stream);
    loop {
        // SAFETY: this stream is local to this call and used synchronously.
        unsafe { *libc::__errno_location() = 0 };
        let entry = unsafe { libc::readdir(entries.0) };
        if entry.is_null() {
            if unsafe { *libc::__errno_location() } != 0 {
                return Err(fail("STORAGE_UNAVAILABLE"));
            }
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        // Count before any child open or recursive call. One shared counter
        // covers the whole traversal, including entries that disappear mid-read.
        if *remaining_entries == 0 {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
        *remaining_entries -= 1;
        let flags = if remaining_depth == 0 {
            // At the depth boundary inspect without opening another directory.
            // Ordinary leaf files can still be unlinked; deeper trees remain.
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                    continue;
                }
                return Err(fail("STORAGE_UNAVAILABLE"));
            }
            let metadata = unsafe { metadata.assume_init() };
            if metadata.st_mode & libc::S_IFMT == libc::S_IFDIR {
                return Err(fail("STORAGE_UNAVAILABLE"));
            }
            0
        } else {
            let child = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if child >= 0 {
                let child = unsafe { File::from_raw_fd(child) };
                remove_discarded_entries(&child, remaining_depth - 1, remaining_entries)?;
                libc::AT_REMOVEDIR
            } else {
                let error = std::io::Error::last_os_error().raw_os_error();
                if error == Some(libc::ENOENT) {
                    continue;
                }
                if !matches!(error, Some(libc::ENOTDIR) | Some(libc::ELOOP)) {
                    return Err(fail("STORAGE_UNAVAILABLE"));
                }
                0
            }
        };
        // Names come directly from this held directory, contain no path
        // components, and are never followed as symbolic links.
        if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), flags) } != 0 {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
    }
    db(directory.sync_all())
}

#[cfg(test)]
thread_local! {
    static DISCARD_CLEANUP_TEST_LIMITS: std::cell::Cell<Option<(usize,usize)>> = const {std::cell::Cell::new(None)};
}
#[cfg(test)]
pub(crate) fn with_discard_cleanup_limits<T>(
    depth: usize,
    entries: usize,
    action: impl FnOnce() -> T,
) -> T {
    struct Restore(Option<(usize, usize)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            DISCARD_CLEANUP_TEST_LIMITS.set(self.0);
        }
    }
    let _restore = Restore(DISCARD_CLEANUP_TEST_LIMITS.replace(Some((depth, entries))));
    action()
}
