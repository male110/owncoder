import { describe, expect, it } from "vitest";
import { describeRetryReason, remainingSeconds } from "./LlmRetryNotice";
import type { I18n } from "../../i18n";

// 词条解析由 shared/i18n 负责，这里只需透传参数，聚焦倒计时与归因逻辑。
const t = ((id: string, params?: Record<string, unknown>) =>
  params ? `${id}:${JSON.stringify(params)}` : id) as I18n["t"];

describe("remainingSeconds", () => {
  it("向上取整，避免刚收到重试事件就显示 0 秒", () => {
    expect(remainingSeconds(10_000, 7_000)).toBe(3);
    expect(remainingSeconds(10_000, 7_001)).toBe(3);
    expect(remainingSeconds(10_000, 9_500)).toBe(1);
  });

  it("到点后归零且不出现负数", () => {
    expect(remainingSeconds(10_000, 10_000)).toBe(0);
    expect(remainingSeconds(10_000, 12_345)).toBe(0);
  });
});

describe("describeRetryReason", () => {
  it("把底层原因映射为可读文案并携带状态码", () => {
    expect(describeRetryReason("timeout", t)).toBe("模型长时间无响应");
    expect(describeRetryReason("network", t)).toBe("网络连接失败");
    expect(describeRetryReason("http_503", t)).toBe('服务返回 {{status}}:{"status":"503"}');
  });

  it("未知原因原样展示，超长报错截断避免撑破布局", () => {
    expect(describeRetryReason("LLM 返回空响应（无文本内容且无工具调用）", t)).toBe(
      "LLM 返回空响应（无文本内容且无工具调用）",
    );
    const long = "x".repeat(120);
    const label = describeRetryReason(long, t);
    expect(label).toBe(`${"x".repeat(80)}…`);
    expect(label).toHaveLength(81);
  });
});
