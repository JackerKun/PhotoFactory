// Test-only shim for the official Perl ExifTool on Windows runners.
// Forward arguments directly to Perl, without a shell or command interpolation.
use std::process::{Command, ExitCode};
fn main() -> ExitCode {
    let script = std::env::current_exe().expect("launcher location")
        .parent().expect("launcher directory").join("source/exiftool");
    match Command::new(env!("PHOTOFACTORY_EXIFTOOL_PERL"))
        .arg(script).args(std::env::args_os().skip(1)).status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(error) => { eprintln!("Cannot start test ExifTool: {error}"); ExitCode::FAILURE }
    }
}
