//! Which display server this session runs on. It decides what the helper can
//! honestly offer: X11 lets any client watch keys and post them, Wayland lets
//! none, and a session with neither (a console, a service) has no keyboard to
//! speak of.
//!
//! The environment is read once: it cannot change under a running process.

use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desktop {
    /// An X server, and no Wayland compositor above it.
    X11,
    /// A Wayland compositor. `DISPLAY` is usually set too (XWayland), but an
    /// X client there only sees keys while an X11 window has the focus, and
    /// its synthetic keys only reach X11 windows, so the X11 code is not used.
    Wayland,
    /// Neither.
    Headless,
}

/// Works the session out from environment variables, given as a lookup so it
/// can be tested. An empty value counts as unset.
pub fn detect(env: impl Fn(&str) -> Option<String>) -> Desktop {
    let set = |name: &str| env(name).filter(|value| !value.trim().is_empty());
    let session = set("XDG_SESSION_TYPE").map(|value| value.trim().to_ascii_lowercase());
    if set("WAYLAND_DISPLAY").is_some() || session.as_deref() == Some("wayland") {
        return Desktop::Wayland;
    }
    if set("DISPLAY").is_some() {
        return Desktop::X11;
    }
    Desktop::Headless
}

/// The session this process was started in.
pub fn current() -> Desktop {
    static CURRENT: OnceLock<Desktop> = OnceLock::new();
    *CURRENT.get_or_init(|| detect(|name| std::env::var(name).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(vars: &[(&str, &str)]) -> Desktop {
        detect(|name| vars.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string()))
    }

    #[test]
    fn a_plain_x_session_is_x11() {
        assert_eq!(with(&[("DISPLAY", ":0"), ("XDG_SESSION_TYPE", "x11")]), Desktop::X11);
        assert_eq!(with(&[("DISPLAY", ":1")]), Desktop::X11);
    }

    #[test]
    fn wayland_wins_over_the_xwayland_display() {
        assert_eq!(with(&[("DISPLAY", ":0"), ("WAYLAND_DISPLAY", "wayland-0")]), Desktop::Wayland);
        assert_eq!(with(&[("DISPLAY", ":0"), ("XDG_SESSION_TYPE", "wayland")]), Desktop::Wayland);
        assert_eq!(with(&[("XDG_SESSION_TYPE", " Wayland ")]), Desktop::Wayland);
    }

    #[test]
    fn empty_variables_count_as_unset() {
        assert_eq!(with(&[("DISPLAY", ":0"), ("WAYLAND_DISPLAY", "")]), Desktop::X11);
        assert_eq!(with(&[("DISPLAY", " "), ("WAYLAND_DISPLAY", "")]), Desktop::Headless);
    }

    #[test]
    fn a_console_or_a_service_has_no_display() {
        assert_eq!(with(&[]), Desktop::Headless);
        assert_eq!(with(&[("XDG_SESSION_TYPE", "tty")]), Desktop::Headless);
    }
}
