//! What becomes of whisper's raw output, and which language it is told
//! (sections 2.3, 5.3).

/// Lines are trimmed, empty lines and lines that start with `[` (such as
/// `[BLANK_AUDIO]`) are dropped, the rest joined with single spaces.
pub fn clean_transcript(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('['))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// `lang` argument to the stored list: comma separated, trimmed, empties
/// dropped, and an empty list means `auto`.
pub fn parse_languages(arg: &str) -> Vec<String> {
    let list: Vec<String> = arg.split(',').map(str::trim).filter(|c| !c.is_empty()).map(str::to_string).collect();
    if list.is_empty() { vec!["auto".to_string()] } else { list }
}

/// The language for a partial or a `transcribe-file`: the first configured
/// entry as it stands, no detection pass.
pub fn first_language(languages: &[String]) -> String {
    languages.first().cloned().unwrap_or_else(|| "auto".to_string())
}

/// The language for a final pass. One code: that code. `auto` anywhere (or
/// nothing): whisper chooses. Several: `detect` runs, and its answer is used
/// only when it is one of the configured codes; otherwise the first code.
pub fn resolve_language(languages: &[String], detect: impl FnOnce() -> Option<String>) -> String {
    if languages.is_empty() || languages.iter().any(|l| l == "auto") {
        return "auto".to_string();
    }
    if languages.len() == 1 {
        return languages[0].clone();
    }
    match detect() {
        Some(code) if languages.contains(&code) => code,
        _ => languages[0].clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn langs(codes: &[&str]) -> Vec<String> {
        codes.iter().map(|c| c.to_string()).collect()
    }

    #[test]
    fn cleans_whisper_output() {
        assert_eq!(clean_transcript(" The quick brown fox\n jumps over.\n"), "The quick brown fox jumps over.");
        assert_eq!(clean_transcript("[BLANK_AUDIO]\n"), "");
        assert_eq!(clean_transcript("  [Music]\nHello.\n\n [BLANK_AUDIO]\r\n there \n"), "Hello. there");
        assert_eq!(clean_transcript(""), "");
    }

    #[test]
    fn parses_the_lang_argument() {
        assert_eq!(parse_languages("en"), langs(&["en"]));
        assert_eq!(parse_languages(" en , fr,,pt "), langs(&["en", "fr", "pt"]));
        assert_eq!(parse_languages(""), langs(&["auto"]));
        assert_eq!(parse_languages(" , "), langs(&["auto"]));
    }

    #[test]
    fn one_language_needs_no_detection() {
        assert_eq!(resolve_language(&langs(&["pt"]), || panic!("must not detect")), "pt");
        assert_eq!(resolve_language(&langs(&["en", "auto"]), || panic!("must not detect")), "auto");
        assert_eq!(resolve_language(&[], || panic!("must not detect")), "auto");
    }

    #[test]
    fn detection_is_snapped_to_the_configured_set() {
        let set = langs(&["en", "fr"]);
        assert_eq!(resolve_language(&set, || Some("fr".into())), "fr");
        assert_eq!(resolve_language(&set, || Some("de".into())), "en");
        assert_eq!(resolve_language(&set, || None), "en");
        assert_eq!(first_language(&set), "en");
        assert_eq!(first_language(&[]), "auto");
    }
}
