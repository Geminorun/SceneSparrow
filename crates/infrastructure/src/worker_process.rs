//! Process primitives shared by the non-AI document utilities.
use std::{
    ops::{Deref, DerefMut},
    path::Path,
    process::{Child, Command, Stdio},
};

pub(crate) fn document_command(entry: &Path) -> Command {
    node_command(entry, 384)
}

pub(crate) fn node_command(entry: &Path, heap_mib: u32) -> Command {
    let mut command = Command::new("node");
    command.env_clear();
    for key in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .arg(format!("--max-old-space-size={heap_mib}"))
        .arg(entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

pub(crate) struct WorkerChild(pub(crate) Child);

impl Deref for WorkerChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for WorkerChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for WorkerChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn resident_kib(pid: u32) -> Option<u64> {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("VmRSS:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|value| value.parse().ok())
        })
}
