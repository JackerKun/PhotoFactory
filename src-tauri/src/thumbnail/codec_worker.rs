use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Stdio},
    sync::Mutex,
};

use crate::commands::ai::{ai_worker_python, find_ai_worker_dir};

static WORKERS: [Mutex<Option<Worker>>; 2] = [Mutex::new(None), Mutex::new(None)];

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Worker {
    fn start() -> Option<Self> {
        let dir = find_ai_worker_dir()?;
        let executable = dir.join("photofactory-ai.exe");
        let mut command = if executable.is_file() {
            crate::process::background_command(executable)
        } else {
            let mut command = crate::process::background_command(ai_worker_python(&dir));
            command.arg(dir.join("server.py"));
            command
        };
        let mut child = command
            .arg("--thumbnail-stream")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let input = child.stdin.take().expect("piped thumbnail worker stdin");
        let output = BufReader::new(child.stdout.take().expect("piped thumbnail worker stdout"));
        Some(Self {
            child,
            input,
            output,
        })
    }

    fn render(&mut self, source: &Path, target: &Path, size: u32) -> Option<bool> {
        let request = serde_json::json!({ "source": source.to_str()?, "target": target.to_str()?, "size": size });
        serde_json::to_writer(&mut self.input, &request).ok()?;
        self.input.write_all(b"\n").ok()?;
        self.input.flush().ok()?;
        let mut response = String::new();
        self.output.read_line(&mut response).ok()?;
        serde_json::from_str::<bool>(&response).ok()
    }
}

pub fn thumbnail(source: &Path, target: &Path, size: u32) -> bool {
    let mut slot = WORKERS[0]
        .try_lock()
        .unwrap_or_else(|_| WORKERS[1].lock().unwrap());
    if slot.is_none() {
        *slot = Worker::start();
    }
    match slot
        .as_mut()
        .and_then(|worker| worker.render(source, target, size))
    {
        Some(success) => success,
        None => {
            *slot = None;
            false
        }
    }
}
