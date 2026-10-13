import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { WebContents } from "electron";
import { registerExternalLinks } from "../../../main/external-links";
import { Markdown } from "./Markdown";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn().mockResolvedValue(undefined) }));
vi.mock("electron", () => ({ shell: { openExternal } }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  memo: (component: unknown) => component,
  useMemo: (factory: () => unknown) => factory(),
}));

type Element = ReactElement<{ children?: unknown; onClick?: (event: unknown) => void }>;
function findLink(node: unknown): Element | undefined {
  if (Array.isArray(node)) return node.map(findLink).find(Boolean);
  if (!node || typeof node !== "object" || !("type" in node)) return undefined;
  const element = node as Element;
  if (element.type === "a") return element;
  return findLink(element.props.children);
}
function linkFor(href: string, onOpenFile = vi.fn()) {
  const element = Markdown({ content: `[链接](${href})`, onOpenFile, workspaceRoot: "C:/project" });
  const render = element.type as (props: typeof element.props) => Element;
  return { link: findLink(render(element.props))!, onOpenFile };
}

afterEach(() => vi.clearAllMocks());

describe("超链接点击", () => {
  it.each(["src/main.ts", "C:/project/src/main.ts", "file:///C:/project/src/main.ts"])(
    "保留本地文件打开行为：%s", (href) => {
      const { link, onOpenFile } = linkFor(href);
      const preventDefault = vi.fn();
      link.props.onClick!({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(onOpenFile).toHaveBeenCalledWith("src/main.ts");
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it("拆分 Windows 本地文件链接末尾的行号", () => {
    const href = "E:/owncoder/packages/settings/src/builtin-prompts.ts:81";
    const onOpenFile = vi.fn();
    const element = Markdown({ content: `<a href="${href}" target="_blank" rel="noreferrer">builtin-prompts.ts</a>`, onOpenFile, workspaceRoot: "E:/owncoder" });
    const render = element.type as (props: typeof element.props) => Element;
    const link = findLink(render(element.props))!;
    const preventDefault = vi.fn();
    link.props.onClick!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenCalledWith("packages/settings/src/builtin-prompts.ts", 81);
  });

  it("不将文件名本身包含冒号数字的情况误判为行号", () => {
    const href = "C:/logs/log:2024.txt";
    const { link, onOpenFile } = linkFor(href);
    const preventDefault = vi.fn();
    link.props.onClick!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenCalledWith("C:/logs/log:2024.txt");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("接受极大但合理的行号", () => {
    const href = "src/large-file.ts:999999";
    const { link, onOpenFile } = linkFor(href);
    const preventDefault = vi.fn();
    link.props.onClick!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenCalledWith("src/large-file.ts", 999999);
  });

  it("拒绝非法行号 :0", () => {
    const href = "src/file.ts:0";
    const { link, onOpenFile } = linkFor(href);
    const preventDefault = vi.fn();
    link.props.onClick!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenCalledWith("src/file.ts:0");
  });

  it("拒绝超出范围的行号", () => {
    const href = "src/file.ts:1000001";
    const { link, onOpenFile } = linkFor(href);
    const preventDefault = vi.fn();
    link.props.onClick!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenCalledWith("src/file.ts:1000001");
  });

  it.each(["http://example.com/", "https://example.com/path?q=1#part", "https://example.com:81/path"])(
    "网址交给默认浏览器：%s", (url) => {
      const { link, onOpenFile } = linkFor(url);
      const preventDefault = vi.fn();
      link.props.onClick!({ preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(onOpenFile).not.toHaveBeenCalled();
      const setWindowOpenHandler = vi.fn();
      registerExternalLinks({ setWindowOpenHandler });
      const handler = setWindowOpenHandler.mock.calls[0]![0] as Parameters<WebContents["setWindowOpenHandler"]>[0];
      expect(handler({ url } as Parameters<typeof handler>[0])).toEqual({ action: "deny" });
      expect(openExternal).toHaveBeenCalledWith(url);
    },
  );

  it.each(["javascript:alert(1)", "file:///C:/project/src/main.ts", "mailto:test@example.com", "not a url"])(
    "不将非网页目标交给系统：%s", (url) => {
      const setWindowOpenHandler = vi.fn();
      registerExternalLinks({ setWindowOpenHandler });
      const handler = setWindowOpenHandler.mock.calls[0]![0];
      expect(handler({ url })).toEqual({ action: "deny" });
      expect(openExternal).not.toHaveBeenCalled();
    },
  );
});
