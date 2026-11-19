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
pub(super) struct Identity {
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
pub(super) struct Parent {
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
        if !before.is_file()
            || (!allow_link && before.nlink() != 1)
            || before.len() > scenesparrow_domain::manuscript::MAX_DOCUMENT_BYTES as u64
        {
            return Err(fail("SOURCE_PATH_UNSAFE"));
        }
        use std::io::Read;
        let mut bytes = vec![];
        db((&file)
            .take(scenesparrow_domain::manuscript::MAX_DOCUMENT_BYTES as u64 + 1)
            .read_to_end(&mut bytes))?;
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
    pub fn stage(&self, _: &str, _: &[u8]) -> Result<Identity> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    #[cfg(not(unix))]
    pub fn unlink(&self, _: &str) -> Result<()> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
}
