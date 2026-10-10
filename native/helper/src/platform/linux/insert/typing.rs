//! How a text is typed key by key when it cannot be pasted: one keysym per
//! character. No X types, so it can be tested as is.
//!
//! X11 has a keysym for every Unicode character: Latin-1 keeps its code
//! point, everything else is the code point plus `0x0100_0000`.

use super::super::keymap::{XK_RETURN, XK_TAB};

/// The keysym that types `c`, or `None` for a control character that no key
/// types.
pub fn keysym_for(c: char) -> Option<u32> {
    match c {
        '\n' | '\r' => Some(XK_RETURN),
        '\t' => Some(XK_TAB),
        ' '..='~' | '\u{a0}'..='\u{ff}' => Some(c as u32),
        c if c.is_control() => None,
        c => Some(0x0100_0000 | c as u32),
    }
}

/// `text` as key presses, in order. `\r\n` is one Return.
pub fn plan(text: &str) -> Vec<u32> {
    let mut keys = Vec::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' && chars.peek() == Some(&'\n') {
            chars.next();
        }
        keys.extend(keysym_for(c));
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_and_latin_1_keep_their_code_points() {
        assert_eq!(keysym_for('a'), Some(0x61));
        assert_eq!(keysym_for('Z'), Some(0x5a));
        assert_eq!(keysym_for(' '), Some(0x20));
        assert_eq!(keysym_for('~'), Some(0x7e));
        assert_eq!(keysym_for('\u{e9}'), Some(0xe9));
        assert_eq!(keysym_for('\u{a0}'), Some(0xa0));
    }

    #[test]
    fn everything_else_is_a_unicode_keysym() {
        assert_eq!(keysym_for('\u{20ac}'), Some(0x0100_20ac));
        assert_eq!(keysym_for('\u{44f}'), Some(0x0100_044f));
        assert_eq!(keysym_for('\u{1f600}'), Some(0x0101_f600));
        assert_eq!(keysym_for('\u{2026}'), Some(0x0100_2026));
    }

    #[test]
    fn control_characters_have_no_key() {
        assert_eq!(keysym_for('\u{0}'), None);
        assert_eq!(keysym_for('\u{1b}'), None);
        assert_eq!(keysym_for('\u{7f}'), None);
        assert_eq!(keysym_for('\u{85}'), None);
    }

    #[test]
    fn line_breaks_and_tabs_are_their_keys() {
        assert_eq!(plan("a\nb"), vec![0x61, XK_RETURN, 0x62]);
        assert_eq!(plan("a\r\nb\r"), vec![0x61, XK_RETURN, 0x62, XK_RETURN]);
        assert_eq!(plan("\n\n"), vec![XK_RETURN, XK_RETURN]);
        assert_eq!(plan("a\tb"), vec![0x61, XK_TAB, 0x62]);
    }

    #[test]
    fn a_sentence_is_one_key_per_character() {
        let text = "Ol\u{e1}, tudo bem? \u{1f44b}";
        let keys = plan(text);
        assert_eq!(keys.len(), text.chars().count());
        assert_eq!(keys.last(), Some(&0x0101_f44b));
        assert_eq!(plan(""), Vec::<u32>::new());
        assert_eq!(plan("a\u{0}b"), vec![0x61, 0x62]);
    }
}
