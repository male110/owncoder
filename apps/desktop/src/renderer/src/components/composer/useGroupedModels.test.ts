import { describe, expect, it } from "vitest";
import type { AvailableModel, Provider } from "@owncoder/settings";
import { groupModels } from "./useGroupedModels";

function model(id: string, name: string, providerId: string): AvailableModel {
  return { id, name, providerId };
}

function provider(id: string, name = id): Provider {
  return { id, name, baseUrl: "https://example.test" };
}

describe("groupModels", () => {
  it("按平台分组，平台顺序跟随 providers 配置", () => {
    const groups = groupModels(
      [model("b2", "B2", "b"), model("a1", "A1", "a"), model("a2", "A2", "a")],
      [provider("a"), provider("b")],
    );
    expect(groups.map((g) => g.providerId)).toEqual(["a", "b"]);
    expect(groups[0]!.models.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(groups[1]!.models.map((m) => m.id)).toEqual(["b2"]);
  });

  it("未在 providers 中配置的平台按名称排在末尾", () => {
    const groups = groupModels(
      [model("z1", "Z1", "unknown-z"), model("m1", "M1", "unknown-m"), model("a1", "A1", "known")],
      [provider("known")],
    );
    expect(groups.map((g) => g.providerId)).toEqual(["known", "unknown-m", "unknown-z"]);
  });

  it("组内模型按名称排序，同名再按 id 排序", () => {
    const groups = groupModels(
      [model("id-2", "Same", "p"), model("id-1", "Same", "p"), model("id-3", "Alpha", "p")],
      [provider("p")],
    );
    expect(groups[0]!.models.map((m) => m.id)).toEqual(["id-3", "id-1", "id-2"]);
  });

  it("平台展示名取 provider 配置，缺失时回退为平台 id", () => {
    const groups = groupModels([model("a1", "A1", "p")], [{ ...provider("p"), name: "平台 P" }]);
    expect(groups[0]!.providerName).toBe("平台 P");

    const fallback = groupModels([model("a1", "A1", "p")], []);
    expect(fallback[0]!.providerName).toBe("p");
  });

  it("空输入返回空数组", () => {
    expect(groupModels([], [])).toEqual([]);
  });
});
