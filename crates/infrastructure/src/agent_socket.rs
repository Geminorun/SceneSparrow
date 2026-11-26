use scenesparrow_application::external_agent::Result;
use serde_json::Value;
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const MAX_WIRE: usize = 8 * 1024 * 1024;

pub(super) struct AgentSocket {
    stream: UnixStream,
    pending: Vec<u8>,
    bytes: usize,
    messages: usize,
    max_line: usize,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl AgentSocket {
    pub(super) fn connect(
        socket: Option<&Path>,
        cancelled: Arc<AtomicBool>,
        timeout: Duration,
        max_line: usize,
    ) -> Result<Self> {
        let path = socket
            .filter(|p| p.is_absolute())
            .ok_or("AGENT_UNAVAILABLE")?;
        let stream = UnixStream::connect(path).map_err(|_| "AGENT_UNAVAILABLE")?;
        stream
            .set_read_timeout(Some(Duration::from_millis(50)))
            .map_err(|_| "AGENT_UNAVAILABLE")?;
        stream
            .set_write_timeout(Some(Duration::from_millis(100)))
            .map_err(|_| "AGENT_UNAVAILABLE")?;
        Ok(Self {
            stream,
            pending: vec![],
            bytes: 0,
            messages: 0,
            max_line,
            cancelled,
            deadline: Instant::now() + timeout,
        })
    }

    pub(super) fn check_active(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("AGENT_CANCELLED");
        }
        if Instant::now() >= self.deadline {
            return Err("AGENT_TIMEOUT");
        }
        Ok(())
    }

    pub(super) fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "AGENT_PROTOCOL_INVALID")?;
        if bytes.len() > self.max_line {
            return Err("AGENT_CONTEXT_LIMIT");
        }
        bytes.push(b'\n');
        self.stream
            .write_all(&bytes)
            .map_err(|_| "AGENT_INTERRUPTED")
    }

    pub(super) fn receive(&mut self) -> Result<Value> {
        loop {
            self.check_active()?;
            if let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
                if end > self.max_line || self.messages >= 32768 {
                    return Err("AGENT_OUTPUT_LIMIT");
                }
                let line: Vec<_> = self.pending.drain(..=end).collect();
                self.messages += 1;
                return serde_json::from_slice(&line).map_err(|_| "AGENT_PROTOCOL_INVALID");
            }
            if self.pending.len() > self.max_line {
                return Err("AGENT_OUTPUT_LIMIT");
            }
            let mut buffer = [0; 8192];
            match self.stream.read(&mut buffer) {
                Ok(0) => return Err("AGENT_INTERRUPTED"),
                Ok(n) => {
                    self.bytes += n;
                    if self.bytes > MAX_WIRE {
                        return Err("AGENT_OUTPUT_LIMIT");
                    }
                    self.pending.extend_from_slice(&buffer[..n]);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err("AGENT_INTERRUPTED"),
            }
        }
    }
}

impl Drop for AgentSocket {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

pub(super) fn deny_server_request(message: Value) -> Result<Value> {
    if message.get("method").is_some() && message.get("id").is_some() {
        return Err("AGENT_CAPABILITY_DENIED");
    }
    Ok(message)
}
