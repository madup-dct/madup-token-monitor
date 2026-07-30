use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

struct OrcaHomeCandidate<'a> {
    path: &'a Path,
    has_auth: bool,
}

static CODEX_HOME: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn codex_home() -> &'static Path {
    CODEX_HOME.get_or_init(resolve_current_codex_home).as_path()
}

/// 계정 한도용 `codex_home()`(OnceLock) 과 달리 **캐시 없이 매번 fresh 해석**한다.
/// watcher 의 주기 재스캔이 기동 뒤 생긴 계정 홈(orca 등)을 흡수하려면 매 주기 재해석이
/// 필요하므로 pub(crate) 로 노출한다. 계정 식별/한도 경로는 여전히 OnceLock 을 써서
/// mid-run 계정 identity flip 을 막는다.
pub(crate) fn resolve_current_codex_home() -> PathBuf {
    let explicit = std::env::var_os("CODEX_HOME").map(PathBuf::from);
    let default = dirs::home_dir()
        .map(|home| home.join(".codex"))
        .unwrap_or_else(|| PathBuf::from(".codex"));
    let orca = dirs::config_dir()
        .map(|config| config.join("orca/codex-runtime-home/home"))
        .unwrap_or_else(|| default.clone());
    resolve_codex_home(
        explicit.as_deref(),
        &default,
        OrcaHomeCandidate {
            path: &orca,
            has_auth: has_regular_auth_file(&orca),
        },
    )
}

fn has_regular_auth_file(home: &Path) -> bool {
    fs::symlink_metadata(home.join("auth.json"))
        .ok()
        .is_some_and(|metadata| metadata.file_type().is_file())
}

fn resolve_codex_home(
    explicit: Option<&Path>,
    default: &Path,
    orca: OrcaHomeCandidate<'_>,
) -> PathBuf {
    if let Some(path) = explicit {
        return path.to_path_buf();
    }
    if orca.has_auth {
        orca.path.to_path_buf()
    } else {
        default.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_codex_home, OrcaHomeCandidate};
    use std::path::Path;

    #[test]
    fn resolves_explicit_home_before_discovered_homes() {
        // Given
        let explicit = Path::new("explicit");
        let default = Path::new("default");
        let orca = OrcaHomeCandidate {
            path: Path::new("orca"),
            has_auth: true,
        };

        // When
        let selected = resolve_codex_home(Some(explicit), default, orca);

        // Then
        assert_eq!(selected, explicit);
    }

    #[test]
    fn resolves_orca_home_when_both_homes_have_auth() {
        // Given
        let default = Path::new("default");
        let orca = OrcaHomeCandidate {
            path: Path::new("orca"),
            has_auth: true,
        };

        // When
        let selected = resolve_codex_home(None, default, orca);

        // Then
        assert_eq!(selected, Path::new("orca"));
    }

    #[test]
    fn resolves_default_home_when_orca_has_no_auth() {
        // Given
        let default = Path::new("default");
        let orca = OrcaHomeCandidate {
            path: Path::new("orca"),
            has_auth: false,
        };

        // When
        let selected = resolve_codex_home(None, default, orca);

        // Then
        assert_eq!(selected, Path::new("default"));
    }
}
