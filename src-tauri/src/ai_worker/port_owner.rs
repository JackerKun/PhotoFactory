use std::process::Output;
use std::time::Duration;

async fn command(program: &str, args: &[&str]) -> Option<Output> {
    let mut cmd = tokio::process::Command::from(crate::process::background_command(program));
    cmd.args(args).kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(3), cmd.output())
        .await
        .ok()?
        .ok()
}

#[cfg(any(windows, test))]
fn windows_listener_pids(table: &str, port: u16) -> Vec<u32> {
    let mut pids: Vec<_> = table
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            if columns.next()? != "TCP" {
                return None;
            }
            let (host, number) = columns.next()?.rsplit_once(':')?;
            if number.parse::<u16>().ok()? != port
                || !matches!(
                    host,
                    "127.0.0.1" | "0.0.0.0" | "[::]" | "[::ffff:127.0.0.1]"
                )
            {
                return None;
            }
            // The remote address of a listener has port zero, independent of display language.
            if !matches!(columns.next()?, "0.0.0.0:0" | "[::]:0") {
                return None;
            }
            columns.last()?.parse::<u32>().ok().filter(|&pid| pid > 0)
        })
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(windows)]
pub async fn describe(port: u16) -> Option<String> {
    let output = command("netstat.exe", &["-ano"]).await?;
    let pids = windows_listener_pids(&String::from_utf8_lossy(&output.stdout), port);
    let mut owners = Vec::new();
    for pid in pids.into_iter().take(4) {
        let filter = format!("PID eq {pid}");
        let name = command("tasklist.exe", &["/FI", &filter, "/FO", "CSV", "/NH"])
            .await
            .and_then(|output| {
                let text = String::from_utf8_lossy(&output.stdout);
                let row = text
                    .lines()
                    .find(|line| line.trim_start().starts_with('"'))?;
                let (name, columns) = row.trim_start().strip_prefix('"')?.split_once("\",\"")?;
                (columns.split('"').next()?.parse::<u32>().ok()? == pid).then(|| name.to_string())
            });
        owners.push(name.map_or_else(
            || format!("PID {pid}"),
            |name| format!("{name}（PID {pid}）"),
        ));
    }
    (!owners.is_empty()).then(|| owners.join("、"))
}

#[cfg(not(windows))]
pub async fn describe(port: u16) -> Option<String> {
    let address = format!("-iTCP:{port}");
    let output = command("lsof", &["-nP", "-a", &address, "-sTCP:LISTEN", "-Fpc"]).await?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut pid = None;
    let mut owners = Vec::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
        } else if let (Some(name), Some(pid)) = (line.strip_prefix('c'), pid.take()) {
            owners.push(format!("{name}（PID {pid}）"));
        }
    }
    (!owners.is_empty()).then(|| owners.join("、"))
}

#[cfg(test)]
mod tests {
    use super::windows_listener_pids;

    #[test]
    fn ignores_established_connections_and_unrelated_listeners() {
        let listing = "TCP  127.0.0.1:9876  0.0.0.0:0  LISTENING  8468\n\
                       TCP  127.0.0.1:9876  127.0.0.1:3000  ESTABLISHED  777\n\
                       TCP  192.168.5.205:9876  0.0.0.0:0  LISTENING  888\n\
                       TCP  [::]:9876  [::]:0  本地化状态  123\n\
                       TCP  0.0.0.0:9877  0.0.0.0:0  LISTENING  999";
        assert_eq!(windows_listener_pids(listing, 9876), [123, 8468]);
    }
}
