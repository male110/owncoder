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
  it("自定义 displayName 优先，其次协议 display_name，最后回退 name；永不回落到 id", () => {
    expect(modelDisplayName({ name: "deepseek-chat", displayName: "DeepSeek V4 Flash" })).toBe(
      "DeepSeek V4 Flash",
    );
    expect(modelDisplayName({ name: "deepseek-chat", display_name: "DeepSeek Chat" })).toBe(
      "DeepSeek Chat",
    );
    expect(modelDisplayName({ name: "deepseek-chat", displayName: "   " })).toBe("deepseek-chat");
    expect(modelDisplayName(undefined)).toBe("");
    // name 缺失时返回空串，绝不回落到 id（id 是请求标识，不是展示名）。
    expect(modelDisplayName({ name: "", displayName: "  " })).toBe("");
    expect(modelDisplayName({ name: "", display_name: "" })).toBe("");
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

  it("无字母 name 返回空串（归入空键组），不回落到 id", () => {
    // name 无字母片段（如纯数字 "1234"）时没有可识别的系列词，返回空串；
    // 绝不回落到 id——id 不是展示名来源。
    expect(modelSeriesKey({ id: "1234", name: "1234" })).toBe("");
    expect(modelSeriesKey({ id: "9.8", name: "9.8" })).toBe("");
    // 含字母片段时仍优先取该片段（"v2"）。
    expect(modelSeriesKey({ id: "1.5-v2", name: "1.5-v2" })).toBe("v2");
    expect(modelSeriesKey({ id: "k1", name: "k1" })).toBe("k1");
  });

  it("剥离供应商/命名空间前缀后按真实系列词分组", () => {
    // 斜杠/冒号分隔的命名空间前缀（如 atria/）是供应商名，不应作为系列键。
    expect(modelSeriesKey({ id: "atria/kimi-k2.7-code", name: "atria/kimi-k2.7-code" })).toBe("kimi");
    expect(modelSeriesKey({ id: "atria/qwen3-coder-flash", name: "atria/qwen3-coder-flash" })).toBe("qwen");
    expect(modelSeriesKey({ id: "atria/atria-dawn", name: "atria/atria-dawn" })).toBe("atria");
    // 裸 id 不剥离前缀。
    expect(modelSeriesKey({ id: "atria-dawn", name: "atria-dawn" })).toBe("atria");
    expect(modelSeriesKey({ id: "kimi-k2.7-code", name: "kimi-k2.7-code" })).toBe("kimi");
    expect(modelSeriesKey({ id: "qwen3-coder-flash", name: "qwen3-coder-flash" })).toBe("qwen");
  });

  it("id 带前导/尾随空格时仍取到正确系列键（用户真实数据形态）", () => {
    // 服务端返回或手动输入带入的空格不 trim 会让首段字母匹配失败，误落到后续段。
    expect(modelSeriesKey({ id: " kimi-k2.7-code", name: " kimi-k2.7-code" })).toBe("kimi");
    expect(modelSeriesKey({ id: "kimi-k2.7-code ", name: "kimi-k2.7-code " })).toBe("kimi");
    expect(modelSeriesKey({ id: " Kimi 3", name: " Kimi 3" })).toBe("kimi");
    expect(modelSeriesKey({ id: "Kimi 3 ", name: "Kimi 3 " })).toBe("kimi");
    // 命名空间前缀与系列段之间的空格同样被剥离。
    expect(modelSeriesKey({ id: "atria/ kimi-k2.7-code", name: "atria/ kimi-k2.7-code" })).toBe("kimi");
    expect(modelSeriesKey({ id: " atria/kimi-k2.7-code", name: " atria/kimi-k2.7-code" })).toBe("kimi");
  });

  it("系列名首字母大写", () => {
    expect(modelSeriesLabel("deepseek")).toBe("Deepseek");
    expect(modelSeriesLabel("")).toBe("");
  });
});

describe("groupModelsBySeries", () => {
  it("按系列分组，组内按展示名排序，组间按分组名称升序", () => {
    const groups = groupModelsBySeries([
      { id: "deepseek-chat", name: "deepseek-chat", displayName: "DeepSeek V4 Flash" },
      { id: "deepseek-reasoner", name: "deepseek-reasoner", displayName: "DeepSeek V4 Pro" },
      { id: "glm-4", name: "glm-4" },
    ]);
    expect(groups.map((g) => [g.key, g.label, g.models.map((m) => m.id)])).toEqual([
      ["deepseek", "DeepSeek", ["deepseek-chat", "deepseek-reasoner"]],
      ["glm", "glm", ["glm-4"]],
    ]);
  });

  it("组间按分组名称（标签）升序，不再按组内数量降序", () => {
    // qwen 组模型最多，但按标签升序仍排在 Kimi 之后；glm 字母靠前排在最前。
    const groups = groupModelsBySeries([
      { id: "kimi-k2.7-code", name: "kimi-k2.7-code", displayName: "Kimi K2.7 Code" },
      { id: "qwen3-coder-flash", name: "qwen3-coder-flash", displayName: "Qwen3 Coder Flash" },
      { id: "qwen3-coder-lite", name: "qwen3-coder-lite", displayName: "Qwen3 Coder Lite" },
      { id: "glm-4", name: "glm-4", displayName: "GLM-4" },
    ]);
    expect(groups.map((g) => [g.key, g.label, g.models.length])).toEqual([
      ["glm", "GLM", 1],
      ["kimi", "Kimi", 1],
      ["qwen", "Qwen", 2],
    ]);
  });

  it("空标签组（无可识别系列词的条目）排在最后，即使数量最多", () => {
    const groups = groupModelsBySeries([
      { id: "1234", name: "1234" },
      { id: "5678", name: "5678" },
      { id: "kimi-k2", name: "kimi-k2" },
    ]);
    expect(groups.map((g) => [g.key, g.label, g.models.length])).toEqual([
      ["kimi", "kimi", 1],
      ["", "", 2],
    ]);
  });

  it("组标签保留 display_name/name 的原始大小写，不强制大写", () => {
    // 有 display_name 时跟 display_name 的大小写（"DeepSeek" 而非 "DEEPSEEK"/"Deepseek"）。
    const withDisplay = groupModelsBySeries([
      { id: "deepseek-chat", name: "deepseek-chat", display_name: "DeepSeek Chat" },
    ]);
    expect(withDisplay[0]?.label).toBe("DeepSeek");
    // 无 display_name 时跟 name 的大小写。
    const withName = groupModelsBySeries([{ id: "Kimi-K2", name: "Kimi-K2" }]);
    expect(withName[0]?.label).toBe("Kimi");
    // 展示名无空白时按首个连续字母段提取。
    const noSpace = groupModelsBySeries([
      { id: "glm-4", name: "glm-4", displayName: "GLM-4.6" },
    ]);
    expect(noSpace[0]?.label).toBe("GLM");
  });

  it("无字母 name 的条目归入空键组，分组标题为空串（不回落到 id）", () => {
    const groups = groupModelsBySeries([{ id: "1234", name: "1234" }]);
    expect(groups.map((g) => [g.key, g.label])).toEqual([["", ""]]);
  });

  it("带供应商前缀的 id 按真实系列分组，组名与展示名/name 大小写一致", () => {
    // 无 display_name 时展示名回落到 name；name 带 atria/ 前缀不应把 kimi/qwen 混入 atria 组。
    const groups = groupModelsBySeries([
      { id: "atria/atria-dawn", name: "atria/atria-dawn" },
      { id: "atria/kimi-k2.7-code", name: "atria/kimi-k2.7-code" },
      { id: "atria/qwen3-coder-flash", name: "atria/qwen3-coder-flash" },
    ]);
    expect(groups.map((g) => [g.key, g.label, g.models.map((m) => m.id)])).toEqual([
      ["atria", "atria", ["atria/atria-dawn"]],
      ["kimi", "Kimi", ["atria/kimi-k2.7-code"]],
      ["qwen", "Qwen", ["atria/qwen3-coder-flash"]],
    ]);
  });

  it("空输入返回空数组", () => {
    expect(groupModelsBySeries([])).toEqual([]);
  });

  it("分组键大小写不敏感：kimi-k2.7-code 与 Kimi 3 归入同一 Kimi 组", () => {
    // 键判定不区分大小写：id 先整体小写再取系列词，kimi/KIMI/Kimi 均得 "kimi"。
    expect(modelSeriesKey({ id: "kimi-k2.7-code", name: "kimi-k2.7-code" })).toBe("kimi");
    expect(modelSeriesKey({ id: "Kimi 3", name: "Kimi 3" })).toBe("kimi");
    expect(modelSeriesKey({ id: "KIMI-K2", name: "KIMI-K2" })).toBe("kimi");
    // 空格分隔的展示名/ id 也按首个连续字母段提取系列词。
    expect(modelSeriesKey({ id: "Kimi 3 Turbo", name: "Kimi 3 Turbo" })).toBe("kimi");

    const groups = groupModelsBySeries([
      { id: "kimi-k2.7-code", name: "kimi-k2.7-code", displayName: "Kimi K2.7 Code" },
      { id: "Kimi 3", name: "Kimi 3", displayName: "Kimi 3" },
      { id: "KIMI-K2", name: "KIMI-K2", displayName: "KIMI K2" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("kimi");
    // 组标签保留代表模型（组内展示名排序首个）展示名的原始大小写。
    expect(groups[0]?.label).toBe("Kimi");
    expect(groups[0]?.models.map((m) => m.id)).toEqual(["Kimi 3", "KIMI-K2", "kimi-k2.7-code"]);
  });

  it("分组键大小写不敏感：GLM-4 与 glm-4.6 合并为同一组", () => {
    expect(modelSeriesKey({ id: "GLM-4", name: "GLM-4" })).toBe("glm");
    expect(modelSeriesKey({ id: "glm-4.6", name: "glm-4.6" })).toBe("glm");
    const groups = groupModelsBySeries([
      { id: "GLM-4", name: "GLM-4", displayName: "GLM-4" },
      { id: "glm-4.6", name: "glm-4.6", displayName: "glm-4.6" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("glm");
    expect(groups[0]?.label).toBe("GLM");
    expect(groups[0]?.models.map((m) => m.id)).toEqual(["GLM-4", "glm-4.6"]);
  });

  it("旧格式迁移条目（id 为 model_<providerId>_<raw>、无 displayName）按 name 分组，不落 Model 组", () => {
    // v1 迁移条目：id 以 model 开头但 name 是裸 raw；分组键来源为展示名回落结果
    // （display_name/displayName → name → id），无 displayName 时取 name。
    expect(modelSeriesKey({ id: "model_provider_mvjkvgge_atria-dawn", name: "atria-dawn" })).toBe(
      "atria",
    );
    expect(
      modelSeriesKey({ id: "model_provider_mvjkvgge_kimi-k2.7-code", name: "kimi-k2.7-code" }),
    ).toBe("kimi");
    expect(
      modelSeriesKey({ id: "model_provider_mvjkvgge_qwen3-coder-flash", name: "qwen3-coder-flash" }),
    ).toBe("qwen");

    const groups = groupModelsBySeries([
      { id: "model_provider_mvjkvgge_atria-dawn", name: "atria-dawn" },
      { id: "model_provider_mvjkvgge_kimi-k2.7-code", name: "kimi-k2.7-code" },
      { id: "model_provider_mvjkvgge_qwen3-coder-flash", name: "qwen3-coder-flash" },
    ]);
    // 三个条目分属 Atria / Kimi / Qwen 三组，而非统一落入 "Model" 组。
    expect(groups.map((g) => [g.key, g.label, g.models.map((m) => m.id)])).toEqual([
      ["atria", "atria", ["model_provider_mvjkvgge_atria-dawn"]],
      ["kimi", "kimi", ["model_provider_mvjkvgge_kimi-k2.7-code"]],
      ["qwen", "qwen", ["model_provider_mvjkvgge_qwen3-coder-flash"]],
    ]);
  });

  it("带前导空格的 id 与干净 id 归入同一组（用户实际观察到的分裂形态）", () => {
    // 真实数据 id 可能带前导空格（服务端/手动输入），不 trim 会误落到 code 段或带空格键，
    // 使 kimi-k2.7-code 与 Kimi 3 显示为不同分组。
    const groups = groupModelsBySeries([
      { id: " kimi-k2.7-code", name: " kimi-k2.7-code", display_name: "Kimi K2.7 Code" },
      { id: "Kimi 3", name: "Kimi 3", display_name: "Kimi 3" },
      { id: "atria/ kimi-k2.7-code", name: "atria/ kimi-k2.7-code" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("kimi");
    expect(groups[0]?.label).toBe("Kimi");
    // 组内按展示名 localeCompare 排序：atria/...（name 回落）< "Kimi 3" < "Kimi K2.7 Code"。
    expect(groups[0]?.models.map((m) => m.id)).toEqual([
      "atria/ kimi-k2.7-code",
      "Kimi 3",
      " kimi-k2.7-code",
    ]);
  });

  it("分组键来源优先级：有 displayName 按 displayName，其次 name，两者皆无不按 id", () => {
    // 有 displayName 时按 displayName 分组（即使 id/name 指向别的系列）。
    expect(modelSeriesKey({ id: "glm-4", name: "glm-4", displayName: "DeepSeek V4 Flash" })).toBe(
      "deepseek",
    );
    // 无 displayName 时按 name 分组。
    expect(modelSeriesKey({ id: "glm-4", name: "kimi-k2.7-code" })).toBe("kimi");
    // displayName 与 name 皆无时返回空串（归入空键组），绝不回落到 id。
    expect(modelSeriesKey({ id: "deepseek-chat", name: "" })).toBe("");
    expect(modelSeriesKey({ id: "deepseek-chat", name: "   " })).toBe("");

    const groups = groupModelsBySeries([
      { id: "glm-4", name: "glm-4", displayName: "DeepSeek V4 Flash" },
      { id: "glm-4.6", name: "kimi-k2.7-code" },
      { id: "deepseek-chat", name: "" },
    ]);
    // 第一条按 displayName 落 deepseek 组；第二条按 name 落 kimi 组
    // （name 无空白，系列词提取为小写 "kimi"）；
    // 第三条无 displayName/name，不按 id 落 deepseek 组，而是归入空键组。
    // 组间排序：按分组名称升序，空标签组（""）排最后（deepseek < kimi < 空）。
    expect(groups.map((g) => [g.key, g.label, g.models.map((m) => m.id)])).toEqual([
      ["deepseek", "DeepSeek", ["glm-4"]],
      ["kimi", "kimi", ["glm-4.6"]],
      ["", "", ["deepseek-chat"]],
    ]);
  });
});
