//! The stdin half of the protocol: one line, one typed [`Command`] (section 2).

use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Local,
    Cloud,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    // Recording.
    Start,
    Stop { id: String },
    Cancel,
    Retry { id: String },
    Unlatch,
    TranscribeFile { id: String, path: String },
    // Settings.
    /// Empty means no model installed.
    Model(String),
    Lang(Vec<String>),
    /// `None` is `duck off`; otherwise the fraction (0 to 1) of the current
    /// volume to drop to.
    Duck(Option<f32>),
    /// `None` is `holdkey off`.
    HoldKey(Option<u32>),
    /// `None` is `mic default`.
    Mic(Option<String>),
    Engine(Engine),
    Stream(bool),
    HoldMs(f64),
    DoubleTapMs(f64),
    // Devices and mic test.
    Devices,
    MicTest,
    MicTestStop,
    // Typing, permissions, calendar, lifecycle.
    /// The decoded text, never empty.
    Insert(String),
    AxCheck,
    Cal { id: String, op: String, args: Map<String, Value> },
    Quit,
    // Legacy: parsed, never sent by main.
    HotkeyInstall,
    HotkeyEnabled(bool),
    FnCapture(bool),
}

/// Parses one line (without its `\n`). `None` for anything that is not a known
/// command with a well-formed argument: the caller ignores it.
///
/// A command is a verb, optionally one space and an argument that runs to the
/// end of the line. Verbs are case sensitive. A verb that takes no argument is
/// not recognised with one.
pub fn parse(line: &str) -> Option<Command> {
    let line = line.strip_suffix('\r').unwrap_or(line).trim_start();
    let (verb, arg) = match line.split_once(' ') {
        Some((verb, rest)) => (verb, Some(rest.trim())),
        None => (line.trim_end(), None),
    };
    let text = arg.unwrap_or("");
    let bare = text.is_empty();
    // For the verbs whose empty argument means something ("model " is "no
    // model"), the space has to be there: a lone "model" is not a command.
    let given = arg.is_some();

    use Command::*;
    Some(match verb {
        "start" if bare => Start,
        "cancel" if bare => Cancel,
        "unlatch" if bare => Unlatch,
        "quit" if bare => Quit,
        "devices" if bare => Devices,
        "mic-test" if bare => MicTest,
        "mic-test-stop" if bare => MicTestStop,
        "ax-check" if bare => AxCheck,
        "hotkey-install" if bare => HotkeyInstall,
        "hotkey-on" if bare => HotkeyEnabled(true),
        "hotkey-off" if bare => HotkeyEnabled(false),
        "fn-capture-on" if bare => FnCapture(true),
        "fn-capture-off" if bare => FnCapture(false),

        "stop" => Stop { id: text.to_string() },
        "retry" => Retry { id: text.to_string() },
        "transcribe-file" => {
            let (id, path) = text.split_once(' ')?;
            let path = path.trim();
            if id.is_empty() || path.is_empty() {
                return None;
            }
            TranscribeFile { id: id.to_string(), path: path.to_string() }
        }

        "model" if given => Model(text.to_string()),
        "lang" if given => Lang(crate::text::parse_languages(text)),
        "mic" if given => Mic((!bare && text != "default").then(|| text.to_string())),
        "duck" => match text {
            "off" => Duck(None),
            number => {
                let percent: f32 = number.parse().ok().filter(|p: &f32| p.is_finite())?;
                Duck(Some((percent / 100.0).clamp(0.0, 1.0)))
            }
        },
        "holdkey" => match text {
            "off" => HoldKey(None),
            number => HoldKey(Some(number.parse().ok()?)),
        },
        "engine" => match text {
            "local" => Engine(self::Engine::Local),
            "cloud" => Engine(self::Engine::Cloud),
            _ => return None,
        },
        "stream" => match text {
            "on" => Stream(true),
            "off" => Stream(false),
            _ => return None,
        },
        "hold-ms" => HoldMs(millis(text)?),
        "doubletap-ms" => DoubleTapMs(millis(text)?),

        "insert" => Insert(crate::pcm::decode_text(text)?),
        "cal" => {
            let Value::Object(mut args) = serde_json::from_str::<Value>(text).ok()? else { return None };
            let id = args.get("id")?.as_str()?.to_string();
            let op = args.get("op")?.as_str()?.to_string();
            args.remove("id");
            args.remove("op");
            Cal { id, op, args }
        }
        _ => return None,
    })
}

fn millis(text: &str) -> Option<f64> {
    text.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0 && *v <= 60_000.0)
}

#[cfg(test)]
mod tests {
    use super::Command::*;
    use super::*;

    #[test]
    fn bare_verbs() {
        assert_eq!(parse("start"), Some(Start));
        assert_eq!(parse("cancel"), Some(Cancel));
        assert_eq!(parse("unlatch"), Some(Unlatch));
        assert_eq!(parse("quit"), Some(Quit));
        assert_eq!(parse("devices"), Some(Devices));
        assert_eq!(parse("mic-test"), Some(MicTest));
        assert_eq!(parse("mic-test-stop"), Some(MicTestStop));
        assert_eq!(parse("ax-check"), Some(AxCheck));
        assert_eq!(parse("start\r"), Some(Start));
        assert_eq!(parse("start  "), Some(Start));
    }

    #[test]
    fn a_verb_without_an_argument_is_not_recognised_with_one() {
        for line in ["start now", "cancel 3", "quit please", "devices all", "mic-test 6", "unlatch x"] {
            assert_eq!(parse(line), None, "{line}");
        }
    }

    #[test]
    fn junk_is_ignored() {
        for line in ["", "   ", "bogus-command", "bogus with arguments", "{\"type\":\"start\"}", "START", "Stop 9",
            "startx", "model", "lang", "mic", "duck", "holdkey", "engine", "stream"] {
            assert_eq!(parse(line), None, "{line:?}");
        }
    }

    #[test]
    fn ids_are_opaque_and_run_to_the_end_of_the_line() {
        assert_eq!(parse("stop 41"), Some(Stop { id: "41".into() }));
        assert_eq!(parse("stop 0007"), Some(Stop { id: "0007".into() }));
        assert_eq!(parse("stop   id with spaces  "), Some(Stop { id: "id with spaces".into() }));
        assert_eq!(parse("stop"), Some(Stop { id: String::new() }));
        assert_eq!(parse("stop "), Some(Stop { id: String::new() }));
        assert_eq!(parse("retry c1760000000000123456"), Some(Retry { id: "c1760000000000123456".into() }));
        assert_eq!(parse("retry"), Some(Retry { id: String::new() }));
    }

    #[test]
    fn transcribe_file_splits_id_from_path() {
        assert_eq!(
            parse("transcribe-file tf-8 /tmp/a recording with spaces.wav"),
            Some(TranscribeFile { id: "tf-8".into(), path: "/tmp/a recording with spaces.wav".into() })
        );
        assert_eq!(parse("transcribe-file"), None);
        assert_eq!(parse("transcribe-file onlyid"), None);
        assert_eq!(parse("transcribe-file onlyid   "), None);
    }

    #[test]
    fn settings() {
        assert_eq!(parse("model "), Some(Model(String::new())));
        assert_eq!(parse("model /path with spaces/ggml model.bin"), Some(Model("/path with spaces/ggml model.bin".into())));
        assert_eq!(parse("lang en,fr"), Some(Lang(vec!["en".into(), "fr".into()])));
        assert_eq!(parse("lang "), Some(Lang(vec!["auto".into()])));
        assert_eq!(parse("mic BuiltInMicrophoneDevice"), Some(Mic(Some("BuiltInMicrophoneDevice".into()))));
        assert_eq!(parse("mic Some Device: With Spaces"), Some(Mic(Some("Some Device: With Spaces".into()))));
        assert_eq!(parse("mic default"), Some(Mic(None)));
        assert_eq!(parse("mic "), Some(Mic(None)));
        assert_eq!(parse("engine cloud"), Some(Engine(super::Engine::Cloud)));
        assert_eq!(parse("engine local"), Some(Engine(super::Engine::Local)));
        assert_eq!(parse("engine remote"), None);
        assert_eq!(parse("stream on"), Some(Stream(true)));
        assert_eq!(parse("stream off"), Some(Stream(false)));
        assert_eq!(parse("stream maybe"), None);
        assert_eq!(parse("hold-ms 300"), Some(HoldMs(300.0)));
        assert_eq!(parse("doubletap-ms 350.5"), Some(DoubleTapMs(350.5)));
        assert_eq!(parse("hold-ms soon"), None);
        assert_eq!(parse("hold-ms -1"), None);
    }

    #[test]
    fn duck_is_a_clamped_percentage() {
        assert_eq!(parse("duck off"), Some(Duck(None)));
        assert_eq!(parse("duck 15"), Some(Duck(Some(0.15))));
        assert_eq!(parse("duck 0"), Some(Duck(Some(0.0))));
        assert_eq!(parse("duck 12.5"), Some(Duck(Some(0.125))));
        assert_eq!(parse("duck 250"), Some(Duck(Some(1.0))));
        assert_eq!(parse("duck -4"), Some(Duck(Some(0.0))));
        assert_eq!(parse("duck loud"), None);
        assert_eq!(parse("duck NaN"), None);
        assert_eq!(parse("duck inf"), None);
    }

    #[test]
    fn holdkey_is_a_keycode_or_off() {
        assert_eq!(parse("holdkey off"), Some(HoldKey(None)));
        assert_eq!(parse("holdkey 63"), Some(HoldKey(Some(63))));
        assert_eq!(parse("holdkey none"), None);
        assert_eq!(parse("holdkey -1"), None);
        assert_eq!(parse("holdkey 6.3"), None);
    }

    #[test]
    fn insert_carries_decoded_text() {
        assert_eq!(parse("insert aGVsbG8gd29ybGQ="), Some(Insert("hello world".into())));
        assert_eq!(parse("insert"), None);
        assert_eq!(parse("insert !!!"), None);
        assert_eq!(parse("insert "), None);
    }

    #[test]
    fn cal_needs_a_json_object_with_string_id_and_op() {
        let cal = parse(r#"cal {"id":"c12","op":"upsert","title":"Dentist","minutes":45}"#).unwrap();
        let Cal { id, op, args } = cal else { panic!("not a cal") };
        assert_eq!((id.as_str(), op.as_str()), ("c12", "upsert"));
        assert_eq!(args.get("title").and_then(Value::as_str), Some("Dentist"));
        assert_eq!(args.get("minutes").and_then(Value::as_i64), Some(45));
        assert!(!args.contains_key("id") && !args.contains_key("op"));
        for line in ["cal", "cal not-json", "cal []", r#"cal {"op":"status"}"#, r#"cal {"id":7,"op":"status"}"#,
            r#"cal {"id":"no-op"}"#] {
            assert_eq!(parse(line), None, "{line}");
        }
    }

    #[test]
    fn legacy_verbs_still_parse() {
        assert_eq!(parse("hotkey-install"), Some(HotkeyInstall));
        assert_eq!(parse("hotkey-on"), Some(HotkeyEnabled(true)));
        assert_eq!(parse("hotkey-off"), Some(HotkeyEnabled(false)));
        assert_eq!(parse("fn-capture-on"), Some(FnCapture(true)));
        assert_eq!(parse("fn-capture-off"), Some(FnCapture(false)));
    }
}
