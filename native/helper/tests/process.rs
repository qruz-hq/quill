//! The built binary as main sees it: a child process with three pipes. Covers
//! what needs no capability (boot, the handshake, ignored input, the early
//! outs, every quit path); the full contract is the bun suite in
//! tests/helper at the repository root.
//!
//! Like that suite, every run sends `duck off` and `holdkey off` first and
//! gets a throwaway home folder, so the user's volume, hold key and log are
//! left alone.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use serde_json::Value;

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    seen: Vec<Value>,
    home: PathBuf,
}

impl Helper {
    fn spawn() -> Self {
        let home = std::env::temp_dir().join(format!("flow-stt-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join("Library").join("Logs")).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_flow-stt"))
            .env("HOME", &home)
            .env("CFFIXED_USER_HOME", &home)
            .env("USERPROFILE", &home)
            .env("LOCALAPPDATA", home.join("AppData").join("Local"))
            .env("XDG_STATE_HOME", home.join("state"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn flow-stt");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut helper = Helper { stdin: child.stdin.take(), child, lines, seen: Vec::new(), home };
        // Before it has printed anything, exactly as main writes its settings.
        helper.send("duck off");
        helper.send("holdkey off");
        helper
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin already closed");
        stdin.write_all(format!("{line}\n").as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    /// The next event, which must be one JSON object with a string `type`.
    fn next(&mut self, within: Duration) -> Option<Value> {
        let line = self.lines.recv_timeout(within).ok()?;
        let value: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("not JSON on stdout: {line:?}"));
        assert!(value.is_object() && value["type"].is_string(), "not an event: {line}");
        self.seen.push(value.clone());
        Some(value)
    }

    fn wait_for(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.next(left) {
                Some(event) if event["type"] == kind => return event,
                Some(_) => {}
                None => panic!("no {kind} event; saw {:?}", self.seen),
            }
        }
    }

    /// Everything else it says until it goes quiet.
    fn drain(&mut self) -> Vec<Value> {
        let mut rest = Vec::new();
        while let Some(event) = self.next(Duration::from_millis(300)) {
            rest.push(event);
        }
        rest
    }

    fn wait_exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "helper still running after 3 s");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn stderr(&mut self) -> String {
        let mut text = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    }

    fn log(&self) -> String {
        let candidates = [
            self.home.join("Library").join("Logs").join("Quill-stt.log"),
            self.home.join("AppData").join("Local").join("Quill").join("Logs").join("Quill-stt.log"),
            self.home.join("state").join("quill").join("Quill-stt.log"),
        ];
        candidates.iter().find_map(|p| std::fs::read_to_string(p).ok()).unwrap_or_default()
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        // Never leave a helper behind, whatever the test did.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn types(events: &[Value]) -> Vec<String> {
    events.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect()
}

#[test]
fn boot_is_first_then_the_capabilities_handshake() {
    let mut h = Helper::spawn();
    let boot = h.next(Duration::from_secs(5)).expect("a first line");
    assert_eq!(boot["type"], "boot");
    assert_eq!(boot["pid"], h.child.id());
    let caps = h.next(Duration::from_secs(5)).expect("a second line");
    assert_eq!(caps["type"], "capabilities");
    assert_eq!(caps["protocol"], 1);
    let platform = if cfg!(target_os = "macos") { "macos" } else if cfg!(windows) { "windows" } else { "linux" };
    assert_eq!(caps["platform"], platform);
    assert!(caps["helper"].as_str().unwrap().starts_with("flow-stt "));
    assert!(caps["capabilities"].as_array().unwrap().iter().all(Value::is_string));
    assert!(caps["holdKeys"].as_array().unwrap().iter().all(Value::is_u64));
    assert!(caps["notes"].is_object());
    // The device list arrives by itself, with nothing pinned.
    let devices = h.wait_for("devices");
    assert_eq!(devices["pinned"], "");
    assert!(devices["devices"].is_array());
    assert_eq!(h.seen.iter().filter(|e| e["type"] == "boot").count(), 1);
}

#[test]
fn commands_written_before_boot_are_honoured() {
    let mut h = Helper::spawn();
    h.send("mic not-a-connected-device");
    h.send("stop pre-1");
    let answer = h.wait_for("final");
    assert_eq!(answer, serde_json::json!({"type": "final", "id": "pre-1", "text": ""}));
    assert_eq!(h.seen[0]["type"], "boot");
    assert!(h.seen.iter().any(|e| e["type"] == "devices" && e["pinned"] == "not-a-connected-device"));
}

#[test]
fn unknown_commands_and_junk_are_ignored() {
    let mut h = Helper::spawn();
    h.wait_for("devices");
    h.drain();
    for line in ["bogus-command", "bogus with arguments", "", "   ", "{\"type\":\"start\"}", "START", "Stop 9", "startx",
        "start now", "transcribe-file", "transcribe-file onlyid", "cal", "cal not-json", "cal []", "cal {\"op\":\"status\"}",
        "cal {\"id\":7,\"op\":\"status\"}", "insert", "insert !!!", "duck loud", "holdkey none", "hold-ms soon", "unlatch",
        "model ", "lang ", "engine cloud", "engine local", "stream on", "stream off", "mic-test-stop"] {
        h.send(line);
    }
    h.send("devices");
    h.wait_for("devices");
    let after = h.drain();
    // Nothing but the answer to `devices` (and a hold key status, which needs no command).
    let said: Vec<String> = types(&h.seen[h.seen.len() - after.len() - 1..]).into_iter().filter(|t| t != "hotkey-status").collect();
    assert_eq!(said, vec!["devices".to_string()]);
    assert!(h.child.try_wait().unwrap().is_none(), "still running");
}

#[test]
fn early_outs_answer_in_order_with_their_ids() {
    let mut h = Helper::spawn();
    h.wait_for("devices");
    h.drain();
    for line in ["stop 0007", "retry c1760000000000123456", "stop id with spaces", "stop", "cancel", "cancel"] {
        h.send(line);
    }
    h.send("devices");
    h.wait_for("devices");
    let said: Vec<&Value> = h.seen.iter().filter(|e| e["type"] == "final" || e["type"] == "cancelled").collect();
    assert_eq!(said.iter().filter(|e| e["type"] == "final").map(|e| e["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["0007", "c1760000000000123456", "id with spaces", ""]);
    assert_eq!(said.iter().filter(|e| e["type"] == "cancelled").count(), 2);
    assert!(said.iter().all(|e| e["type"] != "final" || (e["text"] == "" && e.get("error").is_none())));
    assert!(!h.seen.iter().any(|e| e["type"] == "transcribing" || e["type"] == "error"));
}

#[test]
fn queries_answer_whatever_the_build_supports() {
    let mut h = Helper::spawn();
    h.send("ax-check");
    assert!(h.wait_for("ax")["trusted"].is_boolean());
    h.send(r#"cal {"id":"c-bogus","op":"no-such-op"}"#);
    let bogus = h.wait_for("cal");
    assert_eq!((&bogus["id"], bogus["error"].is_string()), (&Value::from("c-bogus"), true));
    h.send(r#"cal {"id":"c-status","op":"status"}"#);
    let status = h.wait_for("cal");
    assert_eq!(status["id"], "c-status");
    assert!(status.get("status").is_some() || status["error"].is_string());
    h.send("model ");
    h.send("transcribe-file tf-9 /nonexistent/file.wav");
    let fallback = h.wait_for("final");
    assert_eq!(fallback["id"], "tf-9");
    assert!(fallback["error"].as_str().unwrap().to_lowercase().contains("model"));
}

#[test]
fn quit_exits_zero_with_nothing_but_json_on_stdout() {
    let mut h = Helper::spawn();
    h.wait_for("devices");
    h.drain();
    h.send("quit");
    assert_eq!(h.wait_exit().code(), Some(0));
    assert_eq!(h.drain(), Vec::<Value>::new());
    assert_eq!(h.stderr(), "");
    let log = h.log();
    assert!(log.contains("boot: flow-stt") && log.contains("exit: quit"), "log was: {log}");
    assert!(log.lines().all(|l| l.starts_with('[') && l.contains("Z] ")), "log was: {log}");
}

#[test]
fn quit_does_not_wait_for_answers_still_owed() {
    let mut h = Helper::spawn();
    h.send("stop q-1");
    h.send("retry q-2");
    h.send("quit");
    h.stdin = None;
    assert_eq!(h.wait_exit().code(), Some(0));
    h.drain(); // whatever it did say parsed as events
}

#[test]
fn closing_stdin_exits_zero() {
    let mut h = Helper::spawn();
    h.wait_for("devices");
    h.stdin = None;
    assert_eq!(h.wait_exit().code(), Some(0));
    assert!(h.log().contains("exit: stdin closed"));
}

#[cfg(unix)]
#[test]
fn sigterm_exits_zero() {
    let mut h = Helper::spawn();
    h.wait_for("devices");
    let killed = Command::new("kill").args(["-TERM", &h.child.id().to_string()]).status().unwrap();
    assert!(killed.success());
    assert_eq!(h.wait_exit().code(), Some(0));
    assert!(h.log().contains("exit: signal"));
}

#[test]
fn a_very_long_line_is_one_command() {
    let mut h = Helper::spawn();
    h.wait_for("devices");
    // An id of 200 kB: there is no length limit on a line.
    let id = "x".repeat(200_000);
    h.send(&format!("stop {id}"));
    assert_eq!(h.wait_for("final")["id"].as_str().unwrap().len(), 200_000);
}
