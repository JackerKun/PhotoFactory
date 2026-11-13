use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_ENTRIES: usize = 240;
const MAX_LOG_BYTES: u64 = 3 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Service,
    Error,
    Stdout,
    Stderr,
    Warning,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Entry {
    id: u64,
    occurred_at: i64,
    source: Source,
    pid: Option<u32>,
    message: String,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    #[default]
    Idle,
    Starting,
    Ready,
    Exited,
    Failed,
}

#[derive(Serialize)]
pub struct Snapshot {
    version: &'static str,
    platform: &'static str,
    architecture: &'static str,
    status: WorkerStatus,
    port: u16,
    pid: Option<u32>,
    entries: Vec<Entry>,
    log_error: Option<String>,
}

#[derive(Default)]
struct Journal {
    status: WorkerStatus,
    port: u16,
    pid: Option<u32>,
    entries: VecDeque<Entry>,
    next_id: u64,
    path: Option<PathBuf>,
    log_error: Option<String>,
}

#[derive(Clone, Default)]
pub struct WorkerDiagnostics(Arc<Mutex<Journal>>);

impl WorkerDiagnostics {
    pub fn open(path: PathBuf) -> Self {
        let mut journal = Journal::default();
        match File::open(&path) {
            Ok(file) => {
                for line in BufReader::new(file.take(MAX_LOG_BYTES)).lines() {
                    let Ok(line) = line else { break };
                    if let Ok(entry) = serde_json::from_str::<Entry>(&line) {
                        journal.next_id = journal.next_id.max(entry.id);
                        journal.keep(entry);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => journal.log_error = Some(error.to_string()),
        }
        journal.path = Some(path);
        Self(Arc::new(Mutex::new(journal)))
    }

    pub fn snapshot(&self, default_port: u16) -> Snapshot {
        let journal = self.0.lock().unwrap();
        Snapshot {
            version: env!("CARGO_PKG_VERSION"),
            platform: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            status: journal.status,
            port: if journal.port == 0 {
                default_port
            } else {
                journal.port
            },
            pid: journal.pid,
            entries: journal.entries.iter().cloned().collect(),
            log_error: journal.log_error.clone(),
        }
    }

    pub fn status(&self, status: WorkerStatus, port: u16, pid: Option<u32>, message: &str) {
        let mut journal = self.0.lock().unwrap();
        journal.status = status;
        journal.port = port;
        journal.pid = pid;
        let source = match status {
            WorkerStatus::Failed | WorkerStatus::Exited => Source::Error,
            _ => Source::Service,
        };
        journal.append(source, pid, message);
    }

    pub fn exited(&self, pid: u32, detail: &str) {
        let mut journal = self.0.lock().unwrap();
        if journal.pid == Some(pid)
            && matches!(journal.status, WorkerStatus::Starting | WorkerStatus::Ready)
        {
            journal.status = WorkerStatus::Exited;
            journal.append(
                Source::Error,
                Some(pid),
                &format!("AI 服务进程已退出（{detail}）"),
            );
        }
    }

    pub fn output(&self, source: Source, pid: u32, line: &str) {
        let source = match source {
            Source::Stderr
                if ["ERROR:", "Fatal Python error:", "Windows fatal exception:"]
                    .iter()
                    .any(|prefix| line.starts_with(prefix)) =>
            {
                Source::Error
            }
            Source::Stderr if line.starts_with("WARNING:") => Source::Warning,
            _ => source,
        };
        self.record(source, Some(pid), line);
    }

    pub fn record(&self, source: Source, pid: Option<u32>, message: &str) {
        if !message.trim().is_empty() {
            self.0.lock().unwrap().append(source, pid, message);
        }
    }

    pub fn clear(&self, through: u64) -> std::io::Result<()> {
        let mut journal = self.0.lock().unwrap();
        let remaining: VecDeque<_> = journal
            .entries
            .iter()
            .filter(|entry| entry.id > through)
            .cloned()
            .collect();
        if let Some(path) = &journal.path {
            rewrite(path, &remaining)?;
        }
        journal.entries = remaining;
        journal.log_error = None;
        Ok(())
    }
}

impl Journal {
    fn keep(&mut self, entry: Entry) {
        self.entries.push_back(entry);
        if self.entries.len() > MAX_ENTRIES {
            let output = self
                .entries
                .iter()
                .take(MAX_ENTRIES / 2)
                .position(|entry| matches!(entry.source, Source::Stdout | Source::Stderr));
            self.entries.remove(output.unwrap_or(0));
        }
    }

    fn append(&mut self, source: Source, pid: Option<u32>, message: &str) {
        self.next_id += 1;
        let entry = Entry {
            id: self.next_id,
            occurred_at: chrono::Utc::now().timestamp(),
            source,
            pid,
            message: message.chars().take(1500).collect(),
        };
        let encoded = serde_json::to_vec(&entry);
        self.keep(entry);
        if let Some(path) = &self.path {
            let result = (|| {
                let mut line = encoded?;
                line.push(b'\n');
                fs::create_dir_all(path.parent().unwrap())?;
                let mut file = OpenOptions::new().create(true).append(true).open(path)?;
                if file.metadata()?.len() + line.len() as u64 > MAX_LOG_BYTES {
                    drop(file);
                    rewrite(path, &self.entries)
                } else {
                    file.write_all(&line)
                }
            })();
            self.log_error = result.err().map(|error| error.to_string());
        }
    }
}

fn rewrite(path: &Path, entries: &VecDeque<Entry>) -> std::io::Result<()> {
    let directory = path.parent().unwrap();
    fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    for entry in entries {
        serde_json::to_writer(&mut file, entry)?;
        file.write_all(b"\n")?;
    }
    file.persist(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_keeps_new_worker_errors_and_history_survives_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ai-worker.jsonl");
        let diagnostics = WorkerDiagnostics::open(path.clone());
        diagnostics.status(WorkerStatus::Ready, 9876, Some(42), "已就绪");
        diagnostics.output(Source::Stderr, 42, "ERROR: invalid model");
        diagnostics.exited(42, "exit code: 120");
        diagnostics.exited(42, "exit code: 120");
        let snapshot = diagnostics.snapshot(9876);
        assert!(matches!(snapshot.status, WorkerStatus::Exited));
        assert_eq!(snapshot.entries.len(), 3);
        assert!(matches!(snapshot.entries[1].source, Source::Error));
        let through = snapshot.entries.last().unwrap().id;
        diagnostics.record(Source::Error, None, "重试失败");
        diagnostics.clear(through).unwrap();

        let restored = WorkerDiagnostics::open(path).snapshot(9876);
        assert!(matches!(restored.status, WorkerStatus::Idle));
        assert_eq!(restored.entries.len(), 1);
        assert_eq!(restored.entries[0].message, "重试失败");
        assert!(restored.entries[0].id > through);
    }
}
