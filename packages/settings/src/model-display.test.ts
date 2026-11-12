import { describe, expect, it } from "vitest";
import {
  groupModelsBySeries,
  listedModelToEntry,
  modelCategory,
  modelDisplayName,
  modelSeriesKey,
  modelSeriesLabel,
} from "./index.js";

describe("modelDisplayName", () => {
  it("自定义 displayName 优先，其次协议 display_name，最后回退 name", () => {
    expect(modelDisplayName({ name: "deepseek-chat", displayName: "DeepSeek V4 Flash" })).toBe(
      "DeepSeek V4 Flash",
    );
    expect(modelDisplayName({ name: "deepseek-chat", display_name: "DeepSeek Chat" })).toBe(
      "DeepSeek Chat",
    );
    expect(modelDisplayName({ name: "deepseek-chat", displayName: "   " })).toBe("deepseek-chat");
    expect(modelDisplayName(undefined)).toBe("");
  });
});

describe("listedModelToEntry", () => {
  it("name 固定为请求用的模型 id，展示名写入 displayName", () => {
    expect(listedModelToEntry({ id: "deepseek-chat", name: "DeepSeek Chat" })).toEqual({
      id: "deepseek-chat",
      name: "deepseek-chat",
      displayName: "DeepSeek Chat",
    });
    // 协议未给展示名（name 即 id）时不产生 displayName 字段。
    expect(listedModelToEntry({ id: "llama3", name: "llama3" })).toEqual({
      id: "llama3",
      name: "llama3",
    });
  });
});

describe("modelCategory", () => {
  it("按 id / 请求名关键词推断能力分类", () => {
    expect(modelCategory({ id: "deepseek-chat", name: "deepseek-chat" })).toBe("text");
    expect(modelCategory({ id: "dall-e-3", name: "dall-e-3" })).toBe("image");
    expect(modelCategory({ id: "sora-2", name: "sora-2" })).toBe("video");
    expect(modelCategory({ id: "gpt-4o-mini-tts", name: "gpt-4o-mini-tts" })).toBe("audio");
    expect(modelCategory({ id: "text-embedding-3-large", name: "text-embedding-3-large" })).toBe(
      "embedding",
    );
    // 纯数字/版本号 id 无法判断能力 → other。
    expect(modelCategory({ id: "1234", name: "1234" })).toBe("other");
  });

  it("展示名不参与判定：描述性展示名不会把纯文本模型误归到视频/图片页签", () => {
    expect(
      modelCategory({
        id: "gemini-2.5-flash",
        name: "gemini-2.5-flash",
        display_name: "Gemini 2.5 Flash (text, image & video input)",
      }),
    ).toBe("text");
    expect(modelCategory({ id: "m-1", name: "m-1", displayName: "Image Gen" })).toBe("text");
  });

  it("embedding 早于 image/audio 匹配", () => {
    expect(modelCategory({ id: "text-image-embedding-3", name: "text-image-embedding-3" })).toBe(
      "embedding",
    );
  });
});

describe("modelSeriesKey", () => {
  it("取 id 的字母前缀作为系列键", () => {
    expect(modelSeriesKey({ id: "deepseek-chat", name: "deepseek-chat" })).toBe("deepseek");
    expect(modelSeriesKey({ id: "DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro" })).toBe("deepseek");
    // 前缀过短（<3）时回退到第一段含字母的片段。
    expect(modelSeriesKey({ id: "gpt-4o", name: "gpt-4o" })).toBe("gpt");
  });

  it("无字母 id 回退到 id 本身，不返回空串", () => {
    expect(modelSeriesKey({ id: "1234", name: "1234" })).toBe("1234");
    expect(modelSeriesKey({ id: "9.8", name: "9.8" })).toBe("9.8");
    // 含字母片段时仍优先取该片段（"v2"），而非整串。
    expect(modelSeriesKey({ id: "1.5-v2", name: "1.5-v2" })).toBe("v2");
    expect(modelSeriesKey({ id: "k1", name: "k1" })).toBe("k1");
  });

  it("系列名首字母大写", () => {
    expect(modelSeriesLabel("deepseek")).toBe("Deepseek");
    expect(modelSeriesLabel("")).toBe("");
  });
});

describe("groupModelsBySeries", () => {
  it("按系列分组，组内按展示名排序，组间按数量降序", () => {
    const groups = groupModelsBySeries([
      { id: "deepseek-chat", name: "deepseek-chat", displayName: "DeepSeek V4 Flash" },
      { id: "deepseek-reasoner", name: "deepseek-reasoner", displayName: "DeepSeek V4 Pro" },
      { id: "glm-4", name: "glm-4" },
    ]);
    expect(groups.map((g) => [g.key, g.label, g.models.map((m) => m.id)])).toEqual([
      ["deepseek", "Deepseek", ["deepseek-chat", "deepseek-reasoner"]],
      ["glm", "Glm", ["glm-4"]],
    ]);
  });

  it("无字母 id 自成一组且分组标题非空", () => {
    const groups = groupModelsBySeries([{ id: "1234", name: "1234" }]);
    expect(groups.map((g) => [g.key, g.label])).toEqual([["1234", "1234"]]);
  });

  it("空输入返回空数组", () => {
    expect(groupModelsBySeries([])).toEqual([]);
  });
});
