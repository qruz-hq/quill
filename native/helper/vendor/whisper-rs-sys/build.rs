//! Builds whisper.cpp (static, with cmake) and generates its bindings.
//!
//! The published whisper-rs-sys build script, reduced to the backends Quill
//! ships (CPU everywhere, Metal on macOS, Vulkan on Windows and Linux), with
//! one change: the whisper.cpp source comes from a checkout at the commit in
//! `PIN` instead of from inside the crate.
//!
//! Source, first that exists: `QUILL_WHISPER_CPP_DIR`, then `./whisper.cpp`
//! (where `bun run helper:build` puts it).
//!
//! Two things are pinned so the library runs on machines other than the one
//! that built it: the instruction set (see [`pin_cpu_baseline`]) and, on a
//! Mac, the oldest macOS it may run on (see [`pin_macos_target`]).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// What the build reads from a whisper.cpp checkout. Everything else (the
/// examples, models, samples, an old build folder) stays behind.
/// The oldest macOS the helper runs on, when `MACOSX_DEPLOYMENT_TARGET` does
/// not say. It is what rustc stamps on an arm64 Mac binary by default, and
/// native/helper/scripts/build.ts exports the same number.
const MACOS_TARGET: &str = "11.0";

const SOURCE_PARTS: &[&str] = &[
    "CMakeLists.txt",
    "LICENSE",
    "cmake",
    "include",
    "src",
    "ggml/CMakeLists.txt",
    "ggml/cmake",
    "ggml/include",
    "ggml/src",
    "bindings/CMakeLists.txt",
    "bindings/javascript/package-tmpl.json",
];

fn main() {
    let target = env::var("TARGET").unwrap();
    let apple = target.contains("apple");
    let windows = target.contains("windows");
    let metal = feature("metal");
    let vulkan = feature("vulkan");
    for unsupported in ["coreml", "cuda", "hipblas", "intel-sycl", "openblas", "openmp"] {
        if feature(unsupported) {
            panic!("Quill's whisper.cpp build has no `{unsupported}` backend (native/helper/vendor/whisper-rs-sys)");
        }
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-changed=PIN");
    println!("cargo:rerun-if-env-changed=QUILL_WHISPER_CPP_DIR");
    println!("cargo:rerun-if-env-changed=DOCS_RS");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let pin = fs::read_to_string(manifest.join("PIN")).expect("PIN is missing").trim().to_string();
    let checkout = locate_source(&manifest);
    check_pin(&checkout, &pin);

    // A copy, because configuring whisper.cpp writes into its own source tree.
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let root = out.join(format!("whisper.cpp-{}", &pin[..12]));
    if !root.join("CMakeLists.txt").exists() {
        let _ = fs::remove_dir_all(&root);
        for part in SOURCE_PARTS {
            copy(&checkout.join(part), &root.join(part));
        }
    }

    generate_bindings(&manifest, &root, &out, metal, vulkan);
    if env::var("DOCS_RS").is_ok() {
        return;
    }

    if let Some(stdlib) = cpp_stdlib(&target) {
        println!("cargo:rustc-link-lib=dylib={stdlib}");
    }
    if apple {
        println!("cargo:rustc-link-lib=framework=Accelerate");
        if metal {
            println!("cargo:rustc-link-lib=framework=Foundation");
            println!("cargo:rustc-link-lib=framework=Metal");
            println!("cargo:rustc-link-lib=framework=MetalKit");
        }
    }

    let macos_target = apple.then(pin_macos_target);
    let mut config = cmake::Config::new(&root);
    if let Some(version) = &macos_target {
        config.define("CMAKE_OSX_DEPLOYMENT_TARGET", version);
    }
    pin_cpu_baseline(&mut config, &target);
    config
        .profile("Release")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("WHISPER_ALL_WARNINGS", "OFF")
        .define("WHISPER_ALL_WARNINGS_3RD_PARTY", "OFF")
        .define("WHISPER_BUILD_TESTS", "OFF")
        .define("WHISPER_BUILD_EXAMPLES", "OFF")
        .define("WHISPER_BUILD_SERVER", "OFF")
        .define("GGML_OPENMP", "OFF")
        .very_verbose(true)
        .pic(true);
    if windows {
        config.cxxflag("/utf-8");
        println!("cargo:rustc-link-lib=advapi32");
    }
    if metal {
        config.define("GGML_METAL", "ON");
        config.define("GGML_METAL_NDEBUG", "ON");
        config.define("GGML_METAL_EMBED_LIBRARY", "ON");
    } else {
        // On by default on a Mac, so it has to be turned off by name.
        config.define("GGML_METAL", "OFF");
    }
    if vulkan {
        config.define("GGML_VULKAN", "ON");
        println!("cargo:rerun-if-env-changed=VULKAN_SDK");
        if windows || apple {
            let sdk = env::var("VULKAN_SDK")
                .unwrap_or_else(|_| panic!("the vulkan feature needs the Vulkan SDK: set VULKAN_SDK"));
            let lib = PathBuf::from(sdk).join(if windows { "Lib" } else { "lib" });
            println!("cargo:rustc-link-search={}", lib.display());
        }
        println!("cargo:rustc-link-lib={}", if windows { "vulkan-1" } else { "vulkan" });
    }
    // whisper.cpp is unusable unoptimised, so a debug build of the helper
    // still gets an optimised library (with symbols when asked for).
    let build_type = if feature("force-debug") { "RelWithDebInfo" } else { "Release" };
    config.define("CMAKE_BUILD_TYPE", build_type);
    if feature("force-debug") {
        config.cxxflag("-DWHISPER_DEBUG");
    }
    // On MSVC the cmake crate replaces CMAKE_<LANG>_FLAGS_<CONFIG> with cc's
    // flags minus every /O switch, which also drops CMake's /DNDEBUG: the
    // library came out unoptimised (every core flat out for seconds per pass)
    // with ggml's debug asserts on, and its `!isnan(x)` check in GELU aborted
    // the helper mid-pass. Setting the variables ourselves stops the override.
    // /MD matches Rust's default CRT on MSVC.
    if target.contains("msvc") {
        let flags = if build_type == "Release" { "/MD /O2 /Ob2 /DNDEBUG" } else { "/MD /Zi /O2 /Ob1 /DNDEBUG" };
        let upper = build_type.to_uppercase();
        config.define(format!("CMAKE_C_FLAGS_{upper}"), flags);
        config.define(format!("CMAKE_CXX_FLAGS_{upper}"), flags);
    }
    // Any WHISPER_, GGML_ or CMAKE_ variable in the environment goes to cmake.
    for (key, value) in env::vars() {
        if key.starts_with("WHISPER_") || key.starts_with("GGML_") || key.starts_with("CMAKE_") {
            config.define(&key, &value);
        }
    }

    let destination = config.build();
    link_search(&out.join("build"));
    println!("cargo:rustc-link-search=native={}", destination.display());
    for lib in ["whisper", "ggml", "ggml-base", "ggml-cpu"] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    if apple {
        println!("cargo:rustc-link-lib=static=ggml-blas");
        link_clang_runtime();
    }
    if vulkan {
        println!("cargo:rustc-link-lib=static=ggml-vulkan");
    }
    if metal {
        println!("cargo:rustc-link-lib=static=ggml-metal");
    }
    println!("cargo:WHISPER_CPP_VERSION={}", version(&root));
    println!("cargo:WHISPER_CPP_COMMIT={pin}");
}

/// Makes the C, C++ and Objective-C objects target the same macOS as the Rust
/// code they are linked into. Left alone, the compilers target the macOS of
/// the build machine: the binary still says it runs on 11.0, but every
/// `@available` check in ggml's Metal backend is folded to true and classes
/// from the newest SDK are bound without a fallback, so on an older macOS the
/// helper does not even start.
///
/// The variable is set for this process as well as handed to cmake, because
/// the cmake crate asks the cc crate for compiler flags and cc takes its
/// `-mmacosx-version-min` from the same variable.
fn pin_macos_target() -> String {
    let version = env::var("MACOSX_DEPLOYMENT_TARGET")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| MACOS_TARGET.to_string());
    env::set_var("MACOSX_DEPLOYMENT_TARGET", &version);
    version
}

/// ggml's default (`GGML_NATIVE=ON`) compiles for the CPU of the machine doing
/// the build: `-march=native`, or on MSVC whatever a probe finds. A release
/// built on a CI runner with AVX-512 then dies with an illegal instruction on
/// every CPU without it, and which CPUs those are changes with the runner.
/// So the instruction set is named here instead.
///
/// x86-64: AVX2 with FMA, F16C and BMI2 (Intel Haswell, 2013, and AMD
/// Excavator or Zen and later). No AVX-512, no AVX-VNNI. A CPU older than that
/// cannot run local transcription.
/// ARM: the compiler's own baseline for the target (Apple silicon on a Mac,
/// ARMv8-A elsewhere).
///
/// A `GGML_` variable in the environment still wins (the loop further down),
/// for example `GGML_NATIVE=ON` for a build that never leaves this machine.
fn pin_cpu_baseline(config: &mut cmake::Config, target: &str) {
    config.define("GGML_NATIVE", "OFF");
    if !target.starts_with("x86_64") {
        return;
    }
    for on in ["GGML_SSE42", "GGML_AVX", "GGML_AVX2", "GGML_BMI2"] {
        config.define(on, "ON");
    }
    // MSVC has no switches for these two: `/arch:AVX2` covers them, and ggml
    // only declares the options for other compilers.
    if !target.contains("msvc") {
        config.define("GGML_FMA", "ON");
        config.define("GGML_F16C", "ON");
    }
    for off in ["GGML_AVX_VNNI", "GGML_AVX512", "GGML_AVX512_VBMI", "GGML_AVX512_VNNI", "GGML_AVX512_BF16"] {
        config.define(off, "OFF");
    }
}

/// With the macOS target pinned below the build machine's, the `@available`
/// checks in ggml's Metal backend are real checks at run time, and they call
/// `__isPlatformVersionAtLeast` from clang's runtime library. clang links that
/// library by itself; rustc links without it, so it is named here.
fn link_clang_runtime() {
    println!("cargo:rerun-if-env-changed=CC");
    let clang = env::var("CC").ok().filter(|cc| !cc.trim().is_empty()).unwrap_or_else(|| "clang".to_string());
    let found = std::process::Command::new(&clang)
        .arg("--print-file-name=libclang_rt.osx.a")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
        // A compiler that does not have the file echoes the bare name back.
        .filter(|path| path.is_absolute() && path.is_file());
    let Some(dir) = found.as_deref().and_then(Path::parent) else {
        panic!(
            "`{clang} --print-file-name=libclang_rt.osx.a` did not find clang's runtime library. \
             whisper.cpp's Metal backend needs it for its macOS version checks: install the Xcode \
             command line tools, or set CC to the clang that built whisper.cpp."
        );
    };
    println!("cargo:rustc-link-search=native={}", dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}

fn feature(name: &str) -> bool {
    env::var(format!("CARGO_FEATURE_{}", name.to_uppercase().replace('-', "_"))).is_ok()
}

fn locate_source(manifest: &Path) -> PathBuf {
    let named = env::var_os("QUILL_WHISPER_CPP_DIR").map(PathBuf::from);
    let local = manifest.join("whisper.cpp");
    let candidates: Vec<PathBuf> = named.into_iter().chain([local.clone()]).collect();
    for dir in &candidates {
        if dir.join("CMakeLists.txt").is_file() && dir.join("include/whisper.h").is_file() {
            println!("cargo:rerun-if-changed={}", dir.join("CMakeLists.txt").display());
            println!("cargo:rerun-if-changed={}", dir.join("include/whisper.h").display());
            return dir.clone();
        }
    }
    panic!(
        "whisper.cpp source not found. Run `bun run helper:build` (it fetches the pinned commit into {}), \
         or point QUILL_WHISPER_CPP_DIR at a checkout of the commit in {}.",
        local.display(),
        manifest.join("PIN").display()
    );
}

/// A git checkout has to be at the pinned commit. A plain folder (an unpacked
/// archive) cannot be checked and is taken as it is.
fn check_pin(checkout: &Path, pin: &str) {
    let head_file = checkout.join(".git/HEAD");
    let Ok(head) = fs::read_to_string(&head_file) else { return };
    println!("cargo:rerun-if-changed={}", head_file.display());
    let head = head.trim();
    let commit = match head.strip_prefix("ref: ") {
        Some(reference) => fs::read_to_string(checkout.join(".git").join(reference))
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        None => head.to_string(),
    };
    // A packed ref leaves `commit` empty: nothing to compare, so let it pass.
    if !commit.is_empty() && commit != pin {
        panic!(
            "{} is at {commit}, but Quill pins whisper.cpp {pin} (native/helper/vendor/whisper-rs-sys/PIN). \
             Check out that commit, or change PIN and test the transcripts again.",
            checkout.display()
        );
    }
}

fn copy(from: &Path, to: &Path) {
    let meta = fs::metadata(from).unwrap_or_else(|e| panic!("whisper.cpp source: {}: {e}", from.display()));
    if meta.is_dir() {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            copy(&entry.path(), &to.join(entry.file_name()));
        }
    } else {
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::copy(from, to).unwrap_or_else(|e| panic!("copy {}: {e}", from.display()));
    }
}

/// Bindings always come from the headers being built. There is no stored copy
/// to fall back on: one made for another commit or another OS would compile
/// and then pass structs of the wrong shape.
fn generate_bindings(manifest: &Path, root: &Path, out: &Path, metal: bool, vulkan: bool) {
    let mut builder = bindgen::Builder::default()
        .rust_edition(bindgen::RustEdition::Edition2021)
        .rust_target(bindgen::RustTarget::stable(85, 0).map_err(|e| e.to_string()).unwrap())
        .header(manifest.join("wrapper.h").display().to_string());
    if metal {
        builder = builder.header(root.join("ggml/include/ggml-metal.h").display().to_string());
    }
    if vulkan {
        builder = builder
            .header(root.join("ggml/include/ggml-vulkan.h").display().to_string())
            .clang_arg("-DGGML_USE_VULKAN=1");
    }
    let bindings = builder
        .clang_arg(format!("-I{}", root.display()))
        .clang_arg(format!("-I{}", root.join("include").display()))
        .clang_arg(format!("-I{}", root.join("ggml/include").display()))
        .generate()
        .unwrap_or_else(|e| panic!("bindgen could not read whisper.h (it needs libclang; set LIBCLANG_PATH): {e}"));
    bindings.write_to_file(out.join("bindings.rs")).expect("could not write bindings.rs");
}

fn cpp_stdlib(target: &str) -> Option<&'static str> {
    if target.contains("msvc") {
        None
    } else if target.contains("apple") || target.contains("freebsd") || target.contains("openbsd") {
        Some("c++")
    } else if target.contains("android") {
        Some("c++_shared")
    } else {
        Some("stdc++")
    }
}

fn link_search(dir: &Path) {
    if !dir.is_dir() {
        return;
    }
    println!("cargo:rustc-link-search={}", dir.display());
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        link_search(&entry.path());
    }
}

/// `set(WHISPER_VERSION_MAJOR 1)` and friends in the top CMakeLists.txt.
fn version(root: &Path) -> String {
    let text = fs::read_to_string(root.join("CMakeLists.txt")).unwrap_or_default();
    let part = |name: &str| {
        text.lines()
            .find_map(|line| line.trim().strip_prefix(&format!("set(WHISPER_VERSION_{name} ")))
            .map(|rest| rest.trim_end_matches(')').trim().to_string())
            .unwrap_or_else(|| "0".to_string())
    };
    format!("{}.{}.{}", part("MAJOR"), part("MINOR"), part("PATCH"))
}
