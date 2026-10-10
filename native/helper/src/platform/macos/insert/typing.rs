//! How a text is typed key by key when it cannot be pasted: split into what
//! one keyboard event can carry. No OS types, so it can be tested as is.

/// One keyboard event carries at most this many UTF-16 units
/// (CGEventKeyboardSetUnicodeString drops the rest).
pub const MAX_UNITS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// One key press whose text is these UTF-16 units.
    Text(Vec<u16>),
    /// The Return key: a line break typed as text is ignored by many apps.
    Return,
}

/// `text` as key presses, in order. Characters are never split: a surrogate
/// pair stays in one event. `\r\n` and `\r` count as one line break.
pub fn plan(text: &str) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut chunk: Vec<u16> = Vec::with_capacity(MAX_UNITS);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            if !chunk.is_empty() {
                steps.push(Step::Text(std::mem::take(&mut chunk)));
            }
            steps.push(Step::Return);
            continue;
        }
        if chunk.len() + c.len_utf16() > MAX_UNITS {
            steps.push(Step::Text(std::mem::take(&mut chunk)));
        }
        let mut units = [0u16; 2];
        chunk.extend_from_slice(c.encode_utf16(&mut units));
    }
    if !chunk.is_empty() {
        steps.push(Step::Text(chunk));
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Step {
        Step::Text(s.encode_utf16().collect())
    }

    fn typed(steps: &[Step]) -> String {
        steps
            .iter()
            .map(|step| match step {
                Step::Text(units) => String::from_utf16(units).expect("a chunk is whole characters"),
                Step::Return => "\n".to_string(),
            })
            .collect()
    }

    #[test]
    fn short_text_is_one_key_press() {
        assert_eq!(plan("hello world"), vec![text("hello world")]);
        assert_eq!(plan(""), vec![]);
    }

    #[test]
    fn long_text_is_cut_at_twenty_units() {
        let steps = plan("abcdefghijklmnopqrstuvwxyz");
        assert_eq!(steps, vec![text("abcdefghijklmnopqrst"), text("uvwxyz")]);
    }

    #[test]
    fn a_surrogate_pair_is_never_split() {
        // 19 letters, then an emoji that needs two units: it moves to the next press.
        let input = format!("{}\u{1F600}!", "a".repeat(19));
        let steps = plan(&input);
        assert_eq!(steps, vec![text(&"a".repeat(19)), text("\u{1F600}!")]);
        assert_eq!(typed(&steps), input);
    }

    #[test]
    fn line_breaks_become_the_return_key() {
        assert_eq!(plan("one\ntwo"), vec![text("one"), Step::Return, text("two")]);
        assert_eq!(plan("one\r\ntwo\r"), vec![text("one"), Step::Return, text("two"), Step::Return]);
        assert_eq!(plan("\n\n"), vec![Step::Return, Step::Return]);
    }

    #[test]
    fn everything_typed_adds_up_to_the_text() {
        let input = "Ol\u{e1}, tudo bem? \u{1F44B}\u{1F3FD} Uma frase longa o bastante para v\u{e1}rias teclas.\nSegunda linha.";
        let steps = plan(input);
        assert_eq!(typed(&steps), input);
        for step in &steps {
            if let Step::Text(units) = step {
                assert!(!units.is_empty() && units.len() <= MAX_UNITS);
            }
        }
    }
}
