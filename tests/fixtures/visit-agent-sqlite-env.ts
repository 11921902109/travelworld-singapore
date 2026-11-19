// Runtime injection for tests only. This fixture contains no deployed secrets.
export const env = {
  get DB() { return (globalThis as unknown as { __travelVisitSqliteDb?: unknown }).__travelVisitSqliteDb; },
  DASHSCOPE_API_KEY: "test-only-placeholder",
  BAILIAN_API_BASE_URL: "https://test.maas.aliyuncs.com/api/v1/agentstudio",
  BAILIAN_AGENT_ID: "test-agent",
  BAILIAN_ENVIRONMENT_ID: "test-environment",
};
