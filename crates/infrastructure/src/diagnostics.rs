//! Operational records have no content identity, paths, messages or external errors.
//! The Web supervisor supplies the persisted envelope and revalidates this payload.
use std::{
    io::Write,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, SyncSender, sync_channel},
    },
    time::Instant,
};

const MAX_EVENT_BYTES: usize = 4096;
const MAX_DROPS: u64 = 9_007_199_254_740_991;
static DROPPED: AtomicU64 = AtomicU64::new(0);
static OUTPUT: OnceLock<Option<SyncSender<Vec<u8>>>> = OnceLock::new();

fn note_drop(counter: &AtomicU64, count: u64) {
    let _ = counter.try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        Some(value.saturating_add(count).min(MAX_DROPS))
    });
}

fn enqueue(sender: &SyncSender<Vec<u8>>, value: serde_json::Value, dropped: &AtomicU64) {
    let Ok(mut bytes) = serde_json::to_vec(&value) else {
        return;
    };
    bytes.push(b'\n');
    if bytes.len() > MAX_EVENT_BYTES || sender.try_send(bytes).is_err() {
        note_drop(dropped, 1);
    }
}

fn drain(receiver: Receiver<Vec<u8>>, output: &mut impl Write, dropped: &AtomicU64) {
    for bytes in receiver {
        let count = dropped.swap(0, Ordering::Relaxed);
        if count > 0 {
            let mut marker = serde_json::to_vec(&serde_json::json!({
                "schemaVersion":1, "component":"core", "level":"warn",
                "eventCode":"DIAGNOSTICS_DEGRADED", "stage":"collection",
                "droppedEvents":count
            }))
            .unwrap_or_default();
            marker.push(b'\n');
            if output.write_all(&marker).is_err() {
                note_drop(dropped, count);
            }
        }
        // A full, disconnected or nonblocking stderr must never panic a business
        // task. Only this detached logger thread can wait on the output device.
        if output.write_all(&bytes).is_err() {
            note_drop(dropped, 1);
        }
    }
}

fn send(value: serde_json::Value) {
    let sender = OUTPUT.get_or_init(|| {
        let (sender, receiver) = sync_channel(256);
        std::thread::Builder::new()
            .name("safe-diagnostics".into())
            .spawn(move || drain(receiver, &mut std::io::stderr(), &DROPPED))
            .ok()
            .map(|_| sender)
    });
    if let Some(sender) = sender {
        enqueue(sender, value, &DROPPED);
    }
}

#[derive(Clone, Copy)]
pub enum Event {
    CoreStart,
    CoreReady,
    CoreStop,
    CoreFailed,
    CoreRequest,
    StorageFailed,
    WorkerStart,
    WorkerResult,
}

pub fn valid_transport_trace(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

pub fn record(
    event: Event,
    trace: Option<&str>,
    status: Option<u16>,
    duration_ms: Option<u128>,
    category: Option<&str>,
    outcome: Option<bool>,
) -> serde_json::Value {
    let (component, code, stage) = match event {
        Event::CoreStart => ("core", "CORE_START", "startup"),
        Event::CoreReady => ("core", "CORE_READY", "startup"),
        Event::CoreStop => ("core", "CORE_STOP", "shutdown"),
        Event::CoreFailed => ("core", "CORE_FAILED", "shutdown"),
        Event::CoreRequest => ("core", "CORE_REQUEST", "request"),
        Event::StorageFailed => ("core", "CORE_FAILED", "request"),
        Event::WorkerStart => ("worker", "WORKER_START", "worker"),
        Event::WorkerResult => ("worker", "WORKER_RESULT", "worker"),
    };
    let mut value = serde_json::json!({"schemaVersion":1,"component":component,"eventCode":code,"stage":stage,"level":if outcome == Some(false) || matches!(event,Event::CoreFailed | Event::StorageFailed) {"error"} else {"info"}});
    if let Some(trace) = trace.filter(|v| valid_transport_trace(v)) {
        value["traceId"] = trace.into();
    }
    if let Some(status) = status.filter(|v| (100..=599).contains(v)) {
        value["status"] = status.into();
    }
    if let Some(duration) = duration_ms {
        value["durationMs"] = (duration.min(86_400_000) as u64).into();
    }
    if let Some(category) = category.filter(|v| ["text", "audio", "video"].contains(v)) {
        value["category"] = category.into();
    }
    if matches!(event, Event::StorageFailed) {
        value["code"] = "STORAGE_UNAVAILABLE".into();
    } else if let Some(success) = outcome {
        value["code"] = if success { "SUCCEEDED" } else { "FAILED" }.into();
    }
    value
}

pub fn emit(event: Event) {
    emit_record(event, None, None, None, None, None);
}

pub fn emit_record(
    event: Event,
    trace: Option<&str>,
    status: Option<u16>,
    duration_ms: Option<u128>,
    category: Option<&str>,
    outcome: Option<bool>,
) {
    send(record(event, trace, status, duration_ms, category, outcome));
}

pub struct WorkerSummary {
    started: Instant,
    category: Option<&'static str>,
    trace: String,
    result: Option<bool>,
}
impl WorkerSummary {
    pub fn new(category: Option<&'static str>) -> Self {
        let trace = uuid::Uuid::new_v4().simple().to_string();
        emit_record(Event::WorkerStart, Some(&trace), None, None, category, None);
        Self {
            started: Instant::now(),
            category,
            trace,
            result: None,
        }
    }
    pub fn finish(&mut self, success: bool) {
        self.result = Some(success);
    }
}
impl Drop for WorkerSummary {
    fn drop(&mut self) {
        let mut value = record(
            Event::WorkerResult,
            Some(&self.trace),
            None,
            Some(self.started.elapsed().as_millis()),
            self.category,
            self.result,
        );
        if self.result.is_none() {
            value["code"] = "INTERRUPTED".into();
            value["level"] = "warn".into();
        }
        send(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_output_drops_without_blocking_or_panicking_and_reports_safe_counts() {
        struct FailingOutput {
            failures: usize,
            bytes: Vec<u8>,
        }
        impl Write for FailingOutput {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.failures > 0 {
                    self.failures -= 1;
                    return Err(std::io::ErrorKind::WouldBlock.into());
                }
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let dropped = AtomicU64::new(0);
        let (sender, receiver) = sync_channel(1);
        enqueue(
            &sender,
            record(Event::CoreStart, None, None, None, None, None),
            &dropped,
        );
        enqueue(
            &sender,
            record(Event::CoreReady, None, None, None, None, None),
            &dropped,
        );
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        drop(sender);
        let mut output = FailingOutput {
            failures: 1,
            bytes: vec![],
        };
        drain(receiver, &mut output, &dropped);
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        assert!(!output.bytes.is_empty());
        assert!(!String::from_utf8_lossy(&output.bytes).contains("WouldBlock"));
        let (sender, receiver) = sync_channel(1);
        enqueue(
            &sender,
            record(Event::CoreReady, None, None, None, None, None),
            &dropped,
        );
        drop(sender);
        drain(receiver, &mut output, &dropped);
        let lines: Vec<serde_json::Value> = String::from_utf8(output.bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(
            lines
                .iter()
                .any(|line| line["eventCode"] == "DIAGNOSTICS_DEGRADED"
                    && line["droppedEvents"] == 1)
        );
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn transport_trace_and_operational_fields_are_closed_and_bounded() {
        for value in [
            "",
            "../../CANARY",
            "ABCDEF01234567890123456789ABCDEF",
            "0123456789012345678901234567890g",
        ] {
            assert!(!valid_transport_trace(value));
        }
        let value = record(
            Event::CoreRequest,
            Some("CANARY https://provider.invalid/key"),
            Some(900),
            Some(u128::MAX),
            Some("秘密/filename"),
            Some(false),
        );
        assert!(value.get("traceId").is_none());
        assert!(value.get("status").is_none());
        assert!(value.get("category").is_none());
        assert_eq!(value["durationMs"], 86_400_000);
        assert_eq!(value["code"], "FAILED");
        assert!(!value.to_string().contains("CANARY"));
        let trace = "0123456789abcdef0123456789abcdef";
        assert!(valid_transport_trace(trace));
        assert_eq!(
            record(Event::CoreRequest, Some(trace), Some(200), None, None, None)["traceId"],
            trace
        );
    }
}
