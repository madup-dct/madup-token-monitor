// 표시용 라벨 디코딩 — Claude Code 가 인코딩한 프로젝트 경로/도구명을 사람이 읽기 좋게.
// 순수 함수 (테스트: labels.test.ts).

/// Claude Code 프로젝트 디렉토리명(`/`→`-` 인코딩, 예 "-Users-me-dev-dct_repo-app")을
/// 짧은 폴더 라벨로. 마지막 1~2 세그먼트만 노출 ("dct_repo/app").
/// 주의(lossy): 인코딩이 `/`→`-` 라 원래 폴더명의 하이픈과 경로 구분자를 구분할 수 없다 →
/// 하이픈 포함 폴더("my-project")는 과분할("my/project")된다. projectPath() 도 동일하게 부정확.
/// 원래 경로의 완전 복원은 불가능 (식별 보조용 best-effort).
export function projectLabel(encoded: string): string {
  if (!encoded) return "기타";
  const parts = encoded.replace(/^-+/, "").split("-").filter(Boolean);
  if (parts.length === 0) return encoded;
  if (parts.length === 1) return parts[0]!;
  return parts.slice(-2).join("/");
}

/// 디코딩 경로 (tooltip 용). 인코딩 `-` 를 `/` 로 복원 — projectLabel 과 같은 lossy 한계
/// (하이픈 포함 폴더는 부정확). 식별 보조용.
export function projectPath(encoded: string): string {
  if (!encoded) return "";
  return "/" + encoded.replace(/^-+/, "").split("-").filter(Boolean).join("/");
}

/// 도구명 표시 정규화.
///   mcp__atlassian__jira_search → "jira_search · atlassian"
///   Read / Bash 등 네이티브 → 그대로
export function prettyToolName(raw: string): string {
  if (!raw) return "기타";
  if (raw.startsWith("mcp__")) {
    const [server, ...toolParts] = raw.slice(5).split("__");
    if (!server) return raw;
    const tool = toolParts.join("__");
    return tool ? `${tool} · ${server}` : server;
  }
  return raw;
}
