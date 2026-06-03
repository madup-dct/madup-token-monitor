import { describe, it, expect } from "vitest";
import { projectLabel, projectPath, prettyToolName } from "./labels";

describe("projectLabel", () => {
  it("마지막 2 세그먼트 (폴더 식별)", () => {
    expect(projectLabel("-Users-madup-dev-dct_repo-madup_token_monitoring")).toBe(
      "dct_repo/madup_token_monitoring",
    );
  });
  it("단일 세그먼트", () => {
    expect(projectLabel("-app")).toBe("app");
  });
  it("빈 값 → 기타", () => {
    expect(projectLabel("")).toBe("기타");
  });
});

describe("projectPath", () => {
  it("전체 경로 복원", () => {
    expect(projectPath("-Users-madup-dev-app")).toBe("/Users/madup/dev/app");
  });
  it("빈 값 → 빈 문자열", () => {
    expect(projectPath("")).toBe("");
  });
});

describe("prettyToolName", () => {
  it("MCP 도구는 tool · server 형식", () => {
    expect(prettyToolName("mcp__atlassian__jira_search")).toBe("jira_search · atlassian");
  });
  it("서버만 있는 MCP", () => {
    expect(prettyToolName("mcp__memory")).toBe("memory");
  });
  it("네이티브 도구는 그대로", () => {
    expect(prettyToolName("Read")).toBe("Read");
    expect(prettyToolName("Bash")).toBe("Bash");
  });
  it("빈 값 → 기타", () => {
    expect(prettyToolName("")).toBe("기타");
  });
});
