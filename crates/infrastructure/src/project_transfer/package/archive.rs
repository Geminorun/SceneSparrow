//! Bounded ZIP validation. Index allocation is permitted only after central-directory preflight.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
};
#[derive(Clone, Copy)]
pub struct Limits {
    pub entries: u64,
    pub file: u64,
    pub expanded: u64,
    pub compressed: u64,
    pub central: u64,
    pub control: u64,
    pub ratio: u64,
    pub allowance: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: 20_000,
            file: 4 << 30,
            expanded: 16 << 30,
            compressed: 8 << 30,
            central: 32 << 20,
            control: 4 << 20,
            ratio: 200,
            allowance: 1 << 20,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    pub path: String,
    pub hash: String,
    pub size: u64,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub version: u32,
    pub kind: String,
    pub project_id: String,
    pub export_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture: Option<ProjectPackageBase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_graph_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_graph_generation: Option<i64>,
    pub members: Vec<Member>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inspected {
    pub descriptor: Option<Descriptor>,
    pub members: Vec<Member>,
    pub entry_count: u64,
    pub expanded: u64,
    pub unchanged: bool,
    pub manifest_project: String,
}
fn invalid<T>() -> Result<T> {
    Err(fail("PACKAGE_ARCHIVE_INVALID"))
}
fn limit<T>() -> Result<T> {
    Err(fail("PACKAGE_SIZE_LIMIT"))
}
fn u16le(b: &[u8], n: usize) -> u16 {
    u16::from_le_bytes(b[n..n + 2].try_into().unwrap())
}
fn u32le(b: &[u8], n: usize) -> u32 {
    u32::from_le_bytes(b[n..n + 4].try_into().unwrap())
}
fn u64le(b: &[u8], n: usize) -> u64 {
    u64::from_le_bytes(b[n..n + 8].try_into().unwrap())
}
fn at(f: &mut File, offset: u64, len: usize) -> Result<Vec<u8>> {
    db(f.seek(SeekFrom::Start(offset)))?;
    let mut b = vec![0; len];
    db(f.read_exact(&mut b))?;
    Ok(b)
}
fn end(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(fail("PACKAGE_ARCHIVE_INVALID"))
}
fn ratio(expanded: u64, compressed: u64, l: Limits) -> Result<()> {
    if expanded
        > compressed
            .checked_mul(l.ratio)
            .and_then(|n| n.checked_add(l.allowance))
            .ok_or(fail("PACKAGE_SIZE_LIMIT"))?
    {
        limit()
    } else {
        Ok(())
    }
}
/// Validates paths and types, including explicit directory/file collisions.
fn paths(entries: &[(String, bool)]) -> Result<()> {
    let mut keys = BTreeMap::new();
    let mut prefixes = BTreeMap::new();
    for (name, dir) in entries {
        if name.is_empty() || name.contains('\\') || name.contains('\0') || name.starts_with('/') {
            return invalid();
        }
        let path = if *dir {
            name.strip_suffix('/')
                .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?
        } else {
            name
        };
        if path.is_empty() {
            return invalid();
        }
        let mut parts = path.split('/');
        let first = parts.next().unwrap();
        let key = scenesparrow_domain::open_project::portable_key(first);
        let creative = if key == ".scenesparrow" {
            if first != ".scenesparrow" {
                return invalid();
            }
            let tail = parts.collect::<Vec<_>>().join("/");
            let allowed = tail == "project.sqlite"
                || tail == "managed.json"
                || tail == "transfer.json"
                || (*dir && matches!(tail.as_str(), "objects" | "exports"))
                || tail.strip_prefix("objects/").is_some_and(sha)
                || tail.strip_prefix("exports/").is_some_and(manuscript::uuid4);
            if !tail.is_empty() && !allowed {
                return invalid();
            }

            if tail.is_empty() && *dir {
                None
            } else {
                Some(tail)
            }
        } else {
            Some(path.to_owned())
        };
        if let Some(check) = creative {
            scenesparrow_domain::open_project::validate_portable_paths(&[&check])
                .map_err(|_| fail("PACKAGE_PATH_INVALID"))?;
        }
        // Reuse the authored creative path policy. The exact management envelope
        // is validated separately; management object hashes are not creative names.
        if first != ".scenesparrow"
            && path.split('/').any(|part| {
                crate::open_source::graph::inventory::excluded(part, true).unwrap_or(true)
            })
        {
            return invalid();
        }
        let key = scenesparrow_domain::open_project::portable_key(path);
        let mut prefix = String::new();
        for part in path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let k = scenesparrow_domain::open_project::portable_key(&prefix);
            if prefixes
                .insert(k, prefix.clone())
                .is_some_and(|old| old != prefix)
            {
                return invalid();
            }
        }
        if keys.insert(key, *dir).is_some() {
            return invalid();
        }
    }
    for key in keys.keys() {
        let mut p = key.as_str();
        while let Some((parent, _)) = p.rsplit_once('/') {
            if keys.get(parent) == Some(&false) {
                return invalid();
            }
            p = parent;
        }
    }
    Ok(())
}
struct Central {
    entries: u64,
    offset: u64,
    size: u64,
    names: Vec<(String, bool)>,
    proofs: Vec<(u64, u64, u64, u64, u16)>,
}
fn preflight(f: &mut File, l: Limits) -> Result<Central> {
    let len = db(f.metadata())?.len();
    if len > l.compressed {
        return limit();
    }
    if len < 22 {
        return invalid();
    }
    let tail_len = len.min(65_557) as usize;
    let tail = at(f, len - tail_len as u64, tail_len)?;
    let found = (0..=tail.len() - 22)
        .rev()
        .find(|&i| {
            tail[i..i + 4] == [0x50, 0x4b, 5, 6]
                && i + 22 + u16le(&tail, i + 20) as usize == tail.len()
        })
        .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
    let e = &tail[found..];
    if u16le(e, 4) != 0 || u16le(e, 6) != 0 || u16le(e, 8) != u16le(e, 10) {
        return invalid();
    }
    let eocd = len - tail_len as u64 + found as u64;
    let mut c = Central {
        entries: u16le(e, 10) as u64,
        size: u32le(e, 12) as u64,
        offset: u32le(e, 16) as u64,
        names: vec![],
        proofs: vec![],
    };
    if c.entries == 65535 || c.size == u32::MAX as u64 || c.offset == u32::MAX as u64 {
        if eocd < 20 {
            return invalid();
        }
        let loc = at(f, eocd - 20, 20)?;
        if u32le(&loc, 0) != 0x07064b50 || u32le(&loc, 4) != 0 || u32le(&loc, 16) != 1 {
            return invalid();
        }
        let pos = u64le(&loc, 8);
        let z = at(f, pos, 56)?;
        if u32le(&z, 0) != 0x06064b50
            || u64le(&z, 4) < 44
            || u64le(&z, 4) > 4096
            || end(pos, end(12, u64le(&z, 4))?)? != eocd - 20
            || u32le(&z, 16) != 0
            || u32le(&z, 20) != 0
            || u64le(&z, 24) != u64le(&z, 32)
        {
            return invalid();
        }
        c = Central {
            entries: u64le(&z, 32),
            size: u64le(&z, 40),
            offset: u64le(&z, 48),
            names: vec![],
            proofs: vec![],
        };
        if end(c.offset, c.size)? != pos {
            return invalid();
        }
    } else if end(c.offset, c.size)? != eocd {
        return invalid();
    }
    if c.entries > l.entries || c.size > l.central {
        return limit();
    }
    let mut pos = c.offset;
    let mut names = Vec::new();
    let mut spans = Vec::new();
    let mut sum = 0u64;
    let mut compressed = 0u64;
    for _ in 0..c.entries {
        if end(pos, 46)? > end(c.offset, c.size)? {
            return invalid();
        }
        let h = at(f, pos, 46)?;
        if u32le(&h, 0) != 0x02014b50 {
            return invalid();
        }
        let flags = u16le(&h, 8);
        let method = u16le(&h, 10);
        if flags & !0x080e != 0 || !matches!(method, 0 | 8) || (method == 0 && flags & 6 != 0) {
            return invalid();
        }
        let n = u16le(&h, 28) as usize;
        let x = u16le(&h, 30) as usize;
        let comment = u16le(&h, 32) as u64;
        let next = end(pos, 46 + n as u64 + x as u64 + comment)?;
        if next > end(c.offset, c.size)? || n == 0 {
            return invalid();
        }
        let variable = at(f, pos + 46, n + x)?;
        let raw = &variable[..n];
        if flags & 0x0800 == 0 && !raw.is_ascii() {
            return invalid();
        }
        let name = std::str::from_utf8(raw)
            .map_err(|_| fail("PACKAGE_PATH_INVALID"))?
            .to_owned();
        let mut size = u32le(&h, 24) as u64;
        let mut packed = u32le(&h, 20) as u64;
        let mut local = u32le(&h, 42) as u64;
        let mut disk = u16le(&h, 34) as u64;
        let mut resolved = [size, packed, local].map(|v| v != u32::MAX as u64);
        let central_wide = size == u32::MAX as u64 || packed == u32::MAX as u64;
        let mut xp = n;
        let mut zip64 = false;
        while xp < variable.len() {
            if xp + 4 > variable.len() {
                return invalid();
            }
            let tag = u16le(&variable, xp);
            let xl = u16le(&variable, xp + 2) as usize;
            xp += 4;
            if xp + xl > variable.len() {
                return invalid();
            }
            if tag == 0x7075 && (xl < 5 || variable[xp] != 1 || &variable[xp + 5..xp + xl] != raw) {
                return invalid();
            }
            if tag == 1 {
                if zip64 {
                    return invalid();
                }
                zip64 = true;
                let mut p = xp;
                for (i, v) in [&mut size, &mut packed, &mut local].into_iter().enumerate() {
                    if xl >= 24 || *v == u32::MAX as u64 {
                        if p + 8 > xp + xl {
                            return invalid();
                        }
                        let extended = u64le(&variable, p);
                        if *v != u32::MAX as u64 && *v != extended {
                            return invalid();
                        }
                        *v = extended;
                        resolved[i] = true;
                        p += 8;
                    }
                }
                if disk == 65535 {
                    if p + 4 > xp + xl {
                        return invalid();
                    }
                    disk = u32le(&variable, p) as u64;
                }
            }
            xp += xl;
        }
        if resolved.contains(&false) || disk != 0 {
            return invalid();
        }
        if size > l.file {
            return limit();
        }
        let mode = u32le(&h, 38) >> 16;
        let kind = mode & 0o170000;
        let dir = name.ends_with('/');
        if kind != 0 && kind != if dir { 0o040000 } else { 0o100000 } {
            return invalid();
        }
        if dir && size != 0 {
            return invalid();
        }
        if u32le(&h, 38) & 0x10 != 0 && !dir {
            return invalid();
        }
        let lh = at(f, local, 30)?;
        if u32le(&lh, 0) != 0x04034b50
            || u16le(&lh, 6) != flags
            || u16le(&lh, 8) != method
            || u16le(&lh, 4) != u16le(&h, 6)
            || lh[10..14] != h[12..16]
            || u16le(&lh, 26) as usize != n
        {
            return invalid();
        }
        let ln = at(f, local + 30, n)?;
        if ln != raw {
            return invalid();
        }
        let extra = at(f, local + 30 + n as u64, u16le(&lh, 28) as usize)?;
        let mut ls = u32le(&lh, 22) as u64;
        let mut lp = u32le(&lh, 18) as u64;
        let mut resolved = [ls, lp].map(|v| v != u32::MAX as u64);
        let mut ep = 0;
        let mut local64 = false;
        while ep < extra.len() {
            if ep + 4 > extra.len() {
                return invalid();
            }
            let tag = u16le(&extra, ep);
            let size = u16le(&extra, ep + 2) as usize;
            ep += 4;
            if ep + size > extra.len() {
                return invalid();
            }
            if tag == 0x7075 && (size < 5 || extra[ep] != 1 || &extra[ep + 5..ep + size] != raw) {
                return invalid();
            }
            if tag == 1 {
                if local64 || size > 16 {
                    return invalid();
                }
                local64 = true;
                let mut p = ep;
                for (i, value) in [&mut ls, &mut lp].into_iter().enumerate() {
                    if *value == u32::MAX as u64 {
                        if p + 8 > ep + size {
                            return invalid();
                        }
                        *value = u64le(&extra, p);
                        resolved[i] = true;
                        p += 8;
                    }
                }
            }
            ep += size;
        }
        if resolved.contains(&false) {
            return invalid();
        }
        if flags & 8 == 0 && (ls != size || lp != packed) {
            return invalid();
        }
        if flags & 8 != 0 && ((ls != 0 && ls != size) || (lp != 0 && lp != packed)) {
            return invalid();
        }
        let data = end(local, 30 + n as u64 + u16le(&lh, 28) as u64)?;
        let finish = end(data, packed)?;
        if finish > c.offset {
            return invalid();
        }
        let mut range_end = finish;
        if flags & 8 == 0 {
            if u32le(&lh, 14) != u32le(&h, 16)
                || (u32le(&lh, 18) != u32::MAX && u32le(&lh, 18) as u64 != packed)
                || (u32le(&lh, 22) != u32::MAX && u32le(&lh, 22) as u64 != size)
            {
                return invalid();
            }
        } else {
            let wide = central_wide
                || ((zip64 || local64)
                    && (size > u32::MAX as u64
                        || packed > u32::MAX as u64
                        || u32le(&lh, 18) == u32::MAX
                        || u32le(&lh, 22) == u32::MAX));
            let mut p = finish;
            let sig = at(f, p, 4)?;
            if u32le(&sig, 0) == 0x08074b50 {
                p += 4;
            }
            let dd = at(f, p, if wide { 20 } else { 12 })?;
            if u32le(&dd, 0) != u32le(&h, 16)
                || if wide {
                    u64le(&dd, 4) != packed || u64le(&dd, 12) != size
                } else {
                    u32le(&dd, 4) as u64 != packed || u32le(&dd, 8) as u64 != size
                }
            {
                return invalid();
            }
            range_end = end(p, dd.len() as u64)?;
            if range_end > c.offset {
                return invalid();
            }
        }
        spans.push((local, range_end));
        c.proofs.push((size, packed, local, data, method));
        names.push((name, dir));
        sum = end(sum, size)?;
        compressed = end(compressed, packed)?;
        if sum > l.expanded {
            return limit();
        }
        ratio(size, packed, l)?;
        pos = next;
    }
    if pos != end(c.offset, c.size)? {
        return invalid();
    }
    spans.sort();
    if spans.windows(2).any(|p| p[0].1 > p[1].0) {
        return invalid();
    }
    paths(&names)?;
    ratio(sum, compressed, l)?;
    c.names = names;
    Ok(c)
}
pub fn inspect(file: &File, l: Limits, cancel: &dyn Fn() -> bool) -> Result<Inspected> {
    let mut f = db(file.try_clone())?;
    let pre = preflight(&mut f, l)?;
    db(f.seek(SeekFrom::Start(0)))?;
    let mut zip = db(zip::ZipArchive::new(f))?;
    if zip.len() as u64 != pre.entries {
        return invalid();
    }
    let mut members = vec![];
    let mut controls = BTreeMap::new();
    let mut expanded = 0u64;
    let mut packed = 0u64;
    for (i, (expected_name, expected_directory)) in pre.names.iter().enumerate() {
        if cancel() {
            return Err(fail("PACKAGE_CANCELLED"));
        }
        let mut entry = db(zip.by_index(i))?;
        let (expected_size, expected_packed, local, data, method) = pre.proofs[i];
        if entry.name_raw() != expected_name.as_bytes()
            || entry.is_dir() != *expected_directory
            || entry.size() != expected_size
            || entry.compressed_size() != expected_packed
            || entry.header_start() != local
            || entry.data_start() != data
            || entry.compression()
                != if method == 0 {
                    zip::CompressionMethod::Stored
                } else {
                    zip::CompressionMethod::Deflated
                }
        {
            return invalid();
        }
        let directory = entry.is_dir();
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| fail("PACKAGE_PATH_INVALID"))?
            .to_owned();
        let mut sha = Sha256::new();
        let mut size = 0u64;
        let mut b = [0u8; 64 * 1024];
        let control = matches!(
            name.as_str(),
            "project.json"
                | "project/project.json"
                | "transfer.json"
                | ".scenesparrow/transfer.json"
                | ".scenesparrow/managed.json"
                | "context/scope.json"
        );
        let mut bytes = vec![];
        loop {
            if cancel() {
                return Err(fail("PACKAGE_CANCELLED"));
            }
            let n = db(entry.read(&mut b)).map_err(|_| fail("PACKAGE_ARCHIVE_INVALID"))?;
            if n == 0 {
                break;
            }
            size = end(size, n as u64)?;
            expanded = end(expanded, n as u64)?;
            if size > l.file || expanded > l.expanded {
                return limit();
            }
            ratio(size, entry.compressed_size(), l)?;
            sha.update(&b[..n]);
            if control {
                if size > l.control {
                    return limit();
                }
                bytes.extend_from_slice(&b[..n]);
            }
        }
        if size != entry.size() {
            return invalid();
        }
        packed = end(packed, entry.compressed_size())?;
        if control {
            controls.insert(name.clone(), bytes);
        }
        if directory {
            if size != 0 {
                return invalid();
            }
            continue;
        }
        let digest = format!("{:x}", sha.finalize());
        if name
            .strip_prefix(".scenesparrow/objects/")
            .is_some_and(|key| key != digest)
        {
            return invalid();
        }
        members.push(Member {
            path: name,
            hash: digest,
            size,
        });
    }
    ratio(expanded, packed, l)?;
    members.sort_by(|a, b| a.path.cmp(&b.path));
    let project_descriptor = controls.get(".scenesparrow/transfer.json");
    let work_descriptor = controls.get("transfer.json");
    if project_descriptor.is_some() && work_descriptor.is_some() {
        return invalid();
    }
    let descriptor: Option<Descriptor> = project_descriptor
        .or(work_descriptor)
        .map(|b| db(serde_json::from_slice(b)))
        .transpose()?;
    let mut unchanged = true;
    let (manifest, descriptor_path) = if let Some(d) = &descriptor {
        uuid(&d.project_id)?;
        uuid(&d.export_id)?;
        if d.version != 1 {
            return invalid();
        }
        let path = match d.kind.as_str() {
            "project" => {
                if d.capture
                    .as_ref()
                    .is_none_or(|c| c.project_id != d.project_id)
                    || d.work_item_id.is_some()
                    || d.base_graph_hash.is_some()
                    || work_descriptor.is_some()
                {
                    return invalid();
                }
                ".scenesparrow/transfer.json"
            }
            "work-copy" => {
                uuid(
                    d.work_item_id
                        .as_deref()
                        .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?,
                )?;
                if d.capture.is_some()
                    || !d.base_graph_hash.as_deref().is_some_and(sha)
                    || d.base_graph_generation.is_none_or(|n| n < 0)
                    || project_descriptor.is_some()
                {
                    return invalid();
                }
                "transfer.json"
            }
            _ => return invalid(),
        };
        if d.members.len() as u64 > l.entries
            || d.members.windows(2).any(|w| w[0].path >= w[1].path)
            || d.members
                .iter()
                .any(|m| !sha(&m.hash) || m.size > l.file || m.path == path)
        {
            return invalid();
        }
        paths(
            &d.members
                .iter()
                .map(|m| (m.path.clone(), false))
                .collect::<Vec<_>>(),
        )?;
        let original = d
            .members
            .iter()
            .map(|m| (m.path.as_str(), m))
            .collect::<BTreeMap<_, _>>();
        let actual = members
            .iter()
            .filter(|m| m.path != path)
            .map(|m| (m.path.as_str(), m))
            .collect::<BTreeMap<_, _>>();
        for name in original
            .keys()
            .chain(actual.keys())
            .collect::<BTreeSet<_>>()
        {
            if original.get(name) != actual.get(name) {
                let protected = if d.kind == "project" {
                    name.starts_with(".scenesparrow/")
                } else {
                    name.starts_with("context/")
                };
                if protected {
                    return Err(fail("PACKAGE_MANAGEMENT_CHANGED"));
                }
                unchanged = false;
            }
        }
        if d.kind == "work-copy"
            && members.iter().any(|m| {
                m.path != "transfer.json"
                    && !m.path.starts_with("project/")
                    && !m.path.starts_with("context/")
            })
        {
            return invalid();
        }
        (
            if d.kind == "project" {
                "project.json"
            } else {
                "project/project.json"
            },
            Some(path),
        )
    } else {
        if members.iter().any(|m| m.path.starts_with(".scenesparrow/")) {
            return invalid();
        }
        ("project.json", None)
    };
    let raw = controls
        .get(manifest)
        .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
    let value = db(serde_json::from_slice(raw))?;
    let manifest = match scenesparrow_domain::open_project::inspect_project_manifest(value)
        .map_err(|_| fail("PACKAGE_ARCHIVE_INVALID"))?
    {
        scenesparrow_domain::open_project::ManifestInspection::Supported(m) => m,
        _ => return invalid(),
    };
    if descriptor
        .as_ref()
        .is_some_and(|d| d.project_id != manifest.project_id)
    {
        return invalid();
    }
    let _ = descriptor_path;
    Ok(Inspected {
        descriptor,
        members,
        entry_count: pre.entries,
        expanded,
        unchanged,
        manifest_project: manifest.project_id,
    })
}
struct Output {
    file: File,
    limit: u64,
    exceeded: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Write for Output {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        let pos = self.file.stream_position()?;
        if pos
            .checked_add(b.len() as u64)
            .is_none_or(|n| n > self.limit)
        {
            self.exceeded
                .store(true, std::sync::atomic::Ordering::Release);
            return Err(std::io::Error::other("package size limit"));
        }
        self.file.write(b)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}
impl Seek for Output {
    fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
        let n = self.file.seek(p)?;
        if n > self.limit {
            self.exceeded
                .store(true, std::sync::atomic::Ordering::Release);
            return Err(std::io::Error::other("package size limit"));
        }
        Ok(n)
    }
}
pub(crate) fn admit_members(members: &[Member], descriptor_bytes: u64, l: Limits) -> Result<()> {
    if members.len() as u64 + 1 > l.entries
        || descriptor_bytes > l.control
        || descriptor_bytes > l.file
    {
        return limit();
    }
    let mut size = descriptor_bytes;
    for m in members {
        if m.size > l.file {
            return limit();
        }
        size = size.checked_add(m.size).ok_or(fail("PACKAGE_SIZE_LIMIT"))?;
        if size > l.expanded {
            return limit();
        }
    }
    Ok(())
}
pub fn write_archive(
    output: File,
    root: &Path,
    members: &[Member],
    descriptor: &Descriptor,
    cancel: &dyn Fn() -> bool,
) -> Result<()> {
    write_archive_limited(output, root, members, descriptor, cancel, Limits::default())
}
fn controlled_copy(
    input: &mut impl Read,
    output: &mut impl Write,
    limit: u64,
    cancel: &dyn Fn() -> bool,
) -> Result<(String, u64)> {
    struct Input<'a, R> {
        read: &'a mut R,
        cancel: &'a dyn Fn() -> bool,
        cancelled: &'a std::cell::Cell<bool>,
    }
    impl<R: Read> Read for Input<'_, R> {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            if (self.cancel)() {
                self.cancelled.set(true);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "package cancelled",
                ));
            }
            self.read.read(bytes)
        }
    }
    let cancelled = std::cell::Cell::new(false);
    let result = crate::storage::objects::stream_copy(
        &mut Input {
            read: input,
            cancel,
            cancelled: &cancelled,
        },
        output,
        limit,
    );
    if cancelled.get() {
        Err(fail("PACKAGE_CANCELLED"))
    } else {
        result
    }
}
fn write_archive_limited(
    output: File,
    root: &Path,
    members: &[Member],
    descriptor: &Descriptor,
    cancel: &dyn Fn() -> bool,
    limits: Limits,
) -> Result<()> {
    admit_members(
        members,
        db(serde_json::to_vec(descriptor))?.len() as u64,
        limits,
    )?;
    let exceeded = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let result = (|| {
        let mut zip = zip::ZipWriter::new(Output {
            file: output,
            limit: limits.compressed,
            exceeded: exceeded.clone(),
        });
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o600)
            .large_file(true);
        for m in members {
            if cancel() {
                return Err(fail("PACKAGE_CANCELLED"));
            }
            let parent = Parent::open(root, &m.path)?;
            let (mut input, _) = parent
                .open_file(&parent.name)?
                .ok_or(fail("PACKAGE_MEMBER_MISSING"))?;
            db(zip.start_file(&m.path, options))?;
            let actual = controlled_copy(&mut input, &mut zip, m.size, cancel)?;
            if actual != (m.hash.clone(), m.size) {
                return invalid();
            }
            parent.verify()?;
        }
        db(zip.start_file(
            if descriptor.kind == "project" {
                ".scenesparrow/transfer.json"
            } else {
                "transfer.json"
            },
            options,
        ))?;
        let bytes = db(serde_json::to_vec(descriptor))?;
        if bytes.len() > 4 << 20 {
            return limit();
        }
        db(zip.write_all(&bytes))?;
        let f = db(zip.finish())?;
        db(f.file.sync_all())?;
        Ok(())
    })();
    if exceeded.load(std::sync::atomic::Ordering::Acquire) {
        Err(fail("PACKAGE_SIZE_LIMIT"))
    } else {
        result
    }
}
pub fn extract(
    file: &File,
    root: &Path,
    inspected: &Inspected,
    cancel: &dyn Fn() -> bool,
) -> Result<()> {
    let mut f = db(file.try_clone())?;
    db(f.seek(SeekFrom::Start(0)))?;
    let mut zip = db(zip::ZipArchive::new(f))?;
    for i in 0..zip.len() {
        if cancel() {
            return Err(fail("PACKAGE_CANCELLED"));
        }
        let mut entry = db(zip.by_index(i))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_owned();
        let member = inspected
            .members
            .iter()
            .find(|m| m.path == name)
            .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
        let parent = Parent::open_creating(root, &name)?;
        let mut output = parent.create_file(&parent.name)?;
        let actual = controlled_copy(&mut entry, &mut output, member.size, cancel)?;
        if actual != (member.hash.clone(), member.size) {
            return invalid();
        }
        db(output.sync_all())?;
        parent.sync()?;
        parent.verify()?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn zip(files: &[(&str, &[u8])], compressed: bool) -> Vec<u8> {
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
        for (name, bytes) in files {
            let options =
                zip::write::SimpleFileOptions::default().compression_method(if compressed {
                    zip::CompressionMethod::Deflated
                } else {
                    zip::CompressionMethod::Stored
                });
            if name.ends_with('/') {
                z.add_directory(*name, options).unwrap();
            } else {
                z.start_file(*name, options).unwrap();
                z.write_all(bytes).unwrap();
            }
        }
        z.finish().unwrap().into_inner()
    }
    fn inspect_bytes(bytes: &[u8], limits: Limits) -> Result<Inspected> {
        let mut f = tempfile::tempfile().unwrap();
        f.write_all(bytes).unwrap();
        inspect(&f, limits, &|| false)
    }
    fn manifest() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"format":"scenesparrow","formatVersion":1,"projectId":uuid::Uuid::new_v4().to_string(),"manuscript":"manuscript.md"})).unwrap()
    }
    #[test]
    fn package_zip_paths_types_and_implicit_prefixes_refuse_before_extraction() {
        for paths in [
            vec!["../escape"],
            vec!["/absolute"],
            vec!["C:/drive"],
            vec!["a\\b"],
            vec!["NUL.txt"],
            vec![".git/config"],
            vec![".env"],
            vec!["credentials.json"],
            vec![".npmrc"],
            vec!["a", "a/b"],
            vec!["A/one", "a/two"],
            vec!["A/", "a/"],
            vec!["a/", "a"],
            vec![".ＳＣＥＮＥＳＰＡＲＲＯＷ/objects/a"],
        ] {
            let data = zip(
                &paths
                    .iter()
                    .map(|p| (*p, b"".as_slice()))
                    .collect::<Vec<_>>(),
                false,
            );
            assert!(
                inspect_bytes(&data, Limits::default()).is_err(),
                "{paths:?}"
            );
        }
        let m = manifest();
        let bytes = zip(
            &[
                ("project.json", &m),
                ("manuscript.md", b""),
                ("cache/audio.wav", b"allowed creative media"),
            ],
            false,
        );
        assert!(inspect_bytes(&bytes, Limits::default()).is_ok());
        let mut special = bytes.clone();
        let at = special
            .windows(4)
            .position(|b| b == [0x50, 0x4b, 1, 2])
            .unwrap();
        special[at + 38..at + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
        assert!(inspect_bytes(&special, Limits::default()).is_err());
    }
    #[test]
    fn package_zip_tiny_limits_apply_before_index_and_actual_inflation() {
        let m = manifest();
        let noisy = vec![b'x'; 16384];
        let data = zip(
            &[
                ("project.json", &m),
                ("manuscript.md", b""),
                ("public/repetitive.bin", &noisy),
            ],
            true,
        );
        for l in [
            Limits {
                entries: 2,
                ..Limits::default()
            },
            Limits {
                central: 20,
                ..Limits::default()
            },
            Limits {
                compressed: 100,
                ..Limits::default()
            },
            Limits {
                file: 100,
                ..Limits::default()
            },
            Limits {
                expanded: 1000,
                ..Limits::default()
            },
            Limits {
                control: 20,
                ..Limits::default()
            },
            Limits {
                ratio: 2,
                allowance: 16,
                ..Limits::default()
            },
        ] {
            assert!(inspect_bytes(&data, l).is_err());
        }
        // Each entry gets an allowance; the archive gets only one aggregate allowance.
        let data = zip(
            &[
                ("project.json", &m),
                ("manuscript.md", b""),
                ("a.bin", &vec![0; 400]),
                ("b.bin", &vec![0; 400]),
            ],
            true,
        );
        assert!(
            inspect_bytes(
                &data,
                Limits {
                    ratio: 1,
                    allowance: 500,
                    ..Limits::default()
                }
            )
            .is_err()
        );
        let planned = vec![
            Member {
                path: "a".into(),
                hash: "a".repeat(64),
                size: 60,
            },
            Member {
                path: "b".into(),
                hash: "b".repeat(64),
                size: 60,
            },
        ];
        assert_eq!(
            admit_members(
                &planned,
                1,
                Limits {
                    expanded: 100,
                    ..Limits::default()
                }
            )
            .unwrap_err()
            .0,
            "PACKAGE_SIZE_LIMIT"
        );
        let mut out = Output {
            file: tempfile::tempfile().unwrap(),
            limit: 12,
            exceeded: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        out.write_all(&[0; 12]).unwrap();
        assert!(out.write_all(&[0]).is_err());
        assert_eq!(out.file.metadata().unwrap().len(), 12);
    }
    #[test]
    fn package_zip_crc_local_header_size_encryption_and_truncation_are_checked() {
        let m = manifest();
        let data = zip(&[("project.json", &m), ("manuscript.md", b"hello")], false);
        assert!(inspect_bytes(&data, Limits::default()).is_ok());
        let mut corrupt = data.clone();
        let first = 30 + u16le(&corrupt, 26) as usize + u16le(&corrupt, 28) as usize;
        corrupt[first] ^= 1;
        assert!(inspect_bytes(&corrupt, Limits::default()).is_err());
        for offset in [6, 8, 18, 22, 30] {
            let mut corrupt = data.clone();
            corrupt[offset] ^= 1;
            assert!(
                inspect_bytes(&corrupt, Limits::default()).is_err(),
                "{offset}"
            );
        }
        for length in [0, 21, data.len() - 1, data.len() - 20] {
            assert!(inspect_bytes(&data[..length], Limits::default()).is_err());
        }
        let large = vec![b'x'; 16 * 1024];
        let mut lied = zip(&[("project.json", &m), ("manuscript.md", &large)], true);
        let central = lied
            .windows(4)
            .enumerate()
            .filter(|(_, b)| *b == [0x50, 0x4b, 1, 2])
            .nth(1)
            .unwrap()
            .0;
        let local = u32le(&lied, central + 42) as usize;
        lied[central + 24..central + 28].copy_from_slice(&1u32.to_le_bytes());
        lied[local + 22..local + 26].copy_from_slice(&1u32.to_le_bytes());
        assert!(
            inspect_bytes(
                &lied,
                Limits {
                    file: 1024,
                    ..Limits::default()
                }
            )
            .is_err()
        );
        let mut sentinel = data.clone();
        sentinel[18..22].copy_from_slice(&u32::MAX.to_le_bytes());
        sentinel[22..26].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(inspect_bytes(&sentinel, Limits::default()).is_err());
    }
    #[test]
    fn package_zip_unicode_path_extras_cannot_substitute_effective_names() {
        let m = manifest();
        let mut bytes = zip(&[("safe.txt", b"untrusted"), ("project.json", &m)], false);
        let eocd = bytes.len() - 22;
        let central = u32le(&bytes, eocd + 16) as usize;
        let old_size = u32le(&bytes, eocd + 12);
        let n = u16le(&bytes, central + 28) as usize;
        let x = u16le(&bytes, central + 30) as usize;
        let mut payload = vec![1];
        payload.extend_from_slice(&0x46d8_446bu32.to_le_bytes());
        payload.extend_from_slice(b".git/config");
        let mut field = 0x7075u16.to_le_bytes().to_vec();
        field.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        field.extend_from_slice(&payload);
        let size = field.len();
        let at = central + 46 + n + x;
        bytes.splice(at..at, field);
        bytes[central + 30..central + 32].copy_from_slice(&((x + size) as u16).to_le_bytes());
        let eocd = bytes.len() - 22;
        bytes[eocd + 12..eocd + 16].copy_from_slice(&(old_size + size as u32).to_le_bytes());
        let mut substituted = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        assert_eq!(substituted.by_index(0).unwrap().name(), ".git/config");
        assert!(inspect_bytes(&bytes, Limits::default()).is_err());
    }
    #[test]
    fn package_zip64_and_data_descriptors_are_supported_with_actual_limits() {
        let m = manifest();
        let mut z = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
        z.start_file(
            "project.json",
            zip::write::SimpleFileOptions::default().large_file(true),
        )
        .unwrap();
        z.write_all(&m).unwrap();
        let bytes = z.finish().unwrap().into_inner();
        assert!(inspect_bytes(&bytes, Limits::default()).is_ok());
        // ZIP streaming writers use the ordinary data descriptor path.
        let mut z = zip::ZipWriter::new_stream(std::io::Cursor::new(vec![]));
        z.start_file(
            "project.json",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        z.write_all(&m).unwrap();
        let bytes = z.finish().unwrap().into_inner().into_inner();
        assert!(inspect_bytes(&bytes, Limits::default()).is_ok());
    }
    #[test]
    fn package_zip_effective_zip64_offsets_and_non_utf8_flags_cannot_bypass_preflight() {
        let m = manifest();
        let mut bytes = zip(&[("project.json", &m), ("manuscript.md", b"hello")], false);
        let e = bytes.len() - 22;
        let c = u32le(&bytes, e + 16) as usize;
        let size = u32le(&bytes, c + 24);
        let packed = u32le(&bytes, c + 20);
        let n = u16le(&bytes, c + 28) as usize;
        let x = u16le(&bytes, c + 30) as usize;
        let next = c + 46 + n + x + u16le(&bytes, c + 32) as usize;
        let other_offset = u32le(&bytes, next + 42);
        let mut field = 1u16.to_le_bytes().to_vec();
        field.extend_from_slice(&24u16.to_le_bytes());
        for value in [size as u64, packed as u64, other_offset as u64] {
            field.extend_from_slice(&value.to_le_bytes());
        }
        let old_cd = u32le(&bytes, e + 12);
        bytes.splice(c + 46 + n + x..c + 46 + n + x, field);
        bytes[c + 30..c + 32].copy_from_slice(&((x + 28) as u16).to_le_bytes());
        let e = bytes.len() - 22;
        bytes[e + 12..e + 16].copy_from_slice(&(old_cd + 28).to_le_bytes());
        assert!(inspect_bytes(&bytes, Limits::default()).is_err());
        let mut bytes = zip(&[("café.txt", b"creative"), ("project.json", &m)], false);
        let e = bytes.len() - 22;
        let c = u32le(&bytes, e + 16) as usize;
        let flags = u16le(&bytes, 6) & !0x0800;
        bytes[6..8].copy_from_slice(&flags.to_le_bytes());
        bytes[c + 8..c + 10].copy_from_slice(&flags.to_le_bytes());
        assert!(inspect_bytes(&bytes, Limits::default()).is_err());
    }
    #[test]
    fn package_small_zip64_data_descriptor_uses_central_size_representation() {
        let m = manifest();
        let name = b"project.json";
        let mut normal = zip(&[("project.json", &m)], false);
        let e = normal.len() - 22;
        let c = u32le(&normal, e + 16) as usize;
        let crc = u32le(&normal, c + 16);
        let mut bytes = vec![];
        fn w16(b: &mut Vec<u8>, v: u16) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        fn w32(b: &mut Vec<u8>, v: u32) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        fn w64(b: &mut Vec<u8>, v: u64) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        w32(&mut bytes, 0x04034b50);
        w16(&mut bytes, 45);
        w16(&mut bytes, 8);
        w16(&mut bytes, 0);
        w16(&mut bytes, 0);
        w16(&mut bytes, 0);
        w32(&mut bytes, 0);
        w32(&mut bytes, 0);
        w32(&mut bytes, 0);
        w16(&mut bytes, name.len() as u16);
        w16(&mut bytes, 0);
        bytes.extend_from_slice(name);
        bytes.extend_from_slice(&m);
        w32(&mut bytes, 0x08074b50);
        w32(&mut bytes, crc);
        w64(&mut bytes, m.len() as u64);
        w64(&mut bytes, m.len() as u64);
        let start = bytes.len() as u32;
        normal[c + 6..c + 8].copy_from_slice(&45u16.to_le_bytes());
        normal[c + 8..c + 10].copy_from_slice(&8u16.to_le_bytes());
        normal[c + 12..c + 16].fill(0);
        normal[c + 20..c + 28].fill(255);
        normal[c + 30..c + 32].copy_from_slice(&20u16.to_le_bytes());
        bytes.extend_from_slice(&normal[c..c + 46 + name.len()]);
        w16(&mut bytes, 1);
        w16(&mut bytes, 16);
        w64(&mut bytes, m.len() as u64);
        w64(&mut bytes, m.len() as u64);
        let length = bytes.len() as u32 - start;
        w32(&mut bytes, 0x06054b50);
        for v in [0, 0, 1, 1] {
            w16(&mut bytes, v);
        }
        w32(&mut bytes, length);
        w32(&mut bytes, start);
        w16(&mut bytes, 0);
        assert!(inspect_bytes(&bytes, Limits::default()).is_ok());
        // A 32-bit descriptor cannot impersonate the central ZIP64 size form.
        let descriptor = 30 + name.len() + m.len();
        bytes[descriptor + 12..descriptor + 16].copy_from_slice(&(m.len() as u32).to_le_bytes());
        assert!(inspect_bytes(&bytes, Limits::default()).is_err());
    }
    #[test]
    fn package_archive_direct_write_and_extract_cancel_inside_one_large_member() {
        let d = tempfile::tempdir().unwrap();
        let data = vec![7; 1 << 20];
        std::fs::write(d.path().join("large.bin"), &data).unwrap();
        let members = vec![Member {
            path: "large.bin".into(),
            hash: hash(&data),
            size: data.len() as u64,
        }];
        let descriptor = Descriptor {
            version: 1,
            kind: "project".into(),
            project_id: uuid::Uuid::new_v4().to_string(),
            export_id: uuid::Uuid::new_v4().to_string(),
            capture: None,
            work_item_id: None,
            base_graph_hash: None,
            base_graph_generation: None,
            members: members.clone(),
        };
        let checks = std::cell::Cell::new(0);
        let cancel = || {
            checks.set(checks.get() + 1);
            checks.get() == 4
        };
        assert_eq!(
            write_archive(
                tempfile::tempfile().unwrap(),
                d.path(),
                &members,
                &descriptor,
                &cancel
            )
            .unwrap_err()
            .0,
            "PACKAGE_CANCELLED"
        );
        assert_eq!(checks.get(), 4);
        let m = manifest();
        let bytes = zip(&[("large.bin", &data), ("project.json", &m)], false);
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&bytes).unwrap();
        let inspected = inspect(&file, Limits::default(), &|| false).unwrap();
        let target = tempfile::tempdir().unwrap();
        checks.set(0);
        assert_eq!(
            extract(&file, target.path(), &inspected, &cancel)
                .unwrap_err()
                .0,
            "PACKAGE_CANCELLED"
        );
        assert_eq!(
            std::fs::metadata(target.path().join("large.bin"))
                .unwrap()
                .len(),
            2 * 64 * 1024
        );
    }
    #[test]
    fn package_zip64_resolved_size_equal_to_classic_sentinel_is_legal_preflight_metadata() {
        // Only three payload bytes are allocated. This tests metadata admission,
        // not a claim that those bytes expand to 4 GiB minus one.
        let mut bytes = vec![];
        fn w16(b: &mut Vec<u8>, v: u16) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        fn w32(b: &mut Vec<u8>, v: u32) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        fn w64(b: &mut Vec<u8>, v: u64) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        let name = b"large.bin";
        w32(&mut bytes, 0x04034b50);
        w16(&mut bytes, 45);
        w16(&mut bytes, 0);
        w16(&mut bytes, 8);
        w16(&mut bytes, 0);
        w16(&mut bytes, 0);
        w32(&mut bytes, 0);
        w32(&mut bytes, 3);
        w32(&mut bytes, u32::MAX);
        w16(&mut bytes, name.len() as u16);
        w16(&mut bytes, 12);
        bytes.extend_from_slice(name);
        w16(&mut bytes, 1);
        w16(&mut bytes, 8);
        w64(&mut bytes, u32::MAX as u64);
        bytes.extend_from_slice(b"abc");
        let central = bytes.len() as u32;
        w32(&mut bytes, 0x02014b50);
        w16(&mut bytes, 45);
        w16(&mut bytes, 45);
        w16(&mut bytes, 0);
        w16(&mut bytes, 8);
        w16(&mut bytes, 0);
        w16(&mut bytes, 0);
        w32(&mut bytes, 0);
        w32(&mut bytes, 3);
        w32(&mut bytes, u32::MAX);
        w16(&mut bytes, name.len() as u16);
        w16(&mut bytes, 12);
        w16(&mut bytes, 0);
        w16(&mut bytes, 0);
        w16(&mut bytes, 0);
        w32(&mut bytes, 0);
        w32(&mut bytes, 0);
        bytes.extend_from_slice(name);
        w16(&mut bytes, 1);
        w16(&mut bytes, 8);
        w64(&mut bytes, u32::MAX as u64);
        let size = bytes.len() as u32 - central;
        w32(&mut bytes, 0x06054b50);
        for v in [0, 0, 1, 1] {
            w16(&mut bytes, v);
        }
        w32(&mut bytes, size);
        w32(&mut bytes, central);
        w16(&mut bytes, 0);
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&bytes).unwrap();
        let admitted = preflight(
            &mut file,
            Limits {
                ratio: u32::MAX as u64,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(admitted.proofs[0].0, u32::MAX as u64);
        // Removing either required resolution is still invalid.
        for position in [28usize, central as usize + 30] {
            let mut corrupt = bytes.clone();
            corrupt[position..position + 2].copy_from_slice(&0u16.to_le_bytes());
            let mut file = tempfile::tempfile().unwrap();
            file.write_all(&corrupt).unwrap();
            assert!(
                preflight(
                    &mut file,
                    Limits {
                        ratio: u32::MAX as u64,
                        ..Limits::default()
                    }
                )
                .is_err()
            );
        }
    }
}
