//! Capabilities `transcribe`, `partials`, `language-detect`, `transcribe-file`:
//! local whisper, the same on every OS.
//!
//! Built only with the cargo feature `asr`, because whisper.cpp is compiled
//! from source; without it the stand-in answers every transcription with an
//! empty text and the capabilities stay out of the handshake.
//!
//! whisper.cpp is the commit pinned in `vendor/whisper-rs-sys/PIN`, the one the
//! app's `whisper-cli` is built from, so both helpers decode with the same
//! library. `vendor/whisper-rs-sys` stands in for the published crate of that
//! name (which carries whisper.cpp 1.8.3) through `[patch.crates-io]`.
//!
//! Building with `asr` needs:
//! - the whisper.cpp source in `vendor/whisper-rs-sys/whisper.cpp`.
//!   `bun run helper:build` fetches it (from `.build/whisper.cpp` when that
//!   checkout has the commit, from GitHub otherwise); for a plain `cargo`
//!   command run `bun native/helper/scripts/whisper-src.ts` once, or set
//!   `QUILL_WHISPER_CPP_DIR`;
//! - a C++ compiler and libclang for the bindings (both in Xcode's command
//!   line tools on macOS; LLVM with `LIBCLANG_PATH` set on Windows);
//! - cmake 3.x on PATH. `bun run helper:build` also looks in `.build/cmake`
//!   (the copy the Swift helper's whisper build downloads), but that folder is
//!   not in git: from a clean checkout install cmake first (`brew install
//!   cmake`, or the tarball from cmake.org with its `bin` on PATH).
//!
//! The Metal shaders are compiled into the binary (GGML_METAL_EMBED_LIBRARY),
//! so the helper is one file with nothing to find at run time.
//!
//! What lives where:
//! - `options.rs`: the decoding options and language rules, always compiled
//!   and unit tested without whisper;
//! - `whisper.rs`: the engine (model kept loaded, states, abort, logging).
//!
//! The session owns everything around a pass: when partials run (every 1.5 s
//! with at least 1.0 s of audio, one at a time), which language a pass gets,
//! the cloud engine (no local decoding at all), the no-model answers, the
//! audio kept for `retry`, and the text rules.

use std::sync::Arc;

use quill_core::caps::Transcriber;

#[cfg_attr(not(feature = "asr"), allow(dead_code))]
mod options;
#[cfg(feature = "asr")]
mod whisper;

pub fn create() -> Arc<dyn Transcriber> {
    #[cfg(feature = "asr")]
    {
        // whisper.cpp is compiled for an AVX2 baseline on x86-64
        // (vendor/whisper-rs-sys/build.rs). On a processor without it the
        // first pass dies with an illegal instruction, which no handler sees:
        // the helper would vanish with nothing in the log. Say so instead, and
        // report local transcription as unavailable.
        if let Some(missing) = missing_cpu_features() {
            quill_core::logln!("whisper: this CPU lacks {missing}, local transcription is off");
            return Arc::new(quill_core::unsupported::NoTranscriber);
        }
        whisper::create()
    }
    #[cfg(not(feature = "asr"))]
    {
        Arc::new(quill_core::unsupported::NoTranscriber)
    }
}

/// The x86-64 features whisper.cpp is built to assume, that this processor
/// does not have (`None` when it has them all, and on every other architecture).
#[cfg(feature = "asr")]
fn missing_cpu_features() -> Option<String> {
    #[cfg(target_arch = "x86_64")]
    {
        let missing: Vec<&str> = [
            ("avx", std::arch::is_x86_feature_detected!("avx")),
            ("avx2", std::arch::is_x86_feature_detected!("avx2")),
            ("fma", std::arch::is_x86_feature_detected!("fma")),
            ("f16c", std::arch::is_x86_feature_detected!("f16c")),
            ("bmi2", std::arch::is_x86_feature_detected!("bmi2")),
        ]
        .into_iter()
        .filter_map(|(name, present)| (!present).then_some(name))
        .collect();
        (!missing.is_empty()).then(|| missing.join(", "))
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        None
    }
}
