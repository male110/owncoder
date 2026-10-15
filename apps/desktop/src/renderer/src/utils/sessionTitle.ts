/**
 * 会话标题的默认占位值。会话在被用户首条消息命名前持有这些占位标题。
 * 标题一旦被设置为非默认值便固定下来，只有当前仍是默认占位时才允许自动改写。
 */
const DEFAULT_SESSION_TITLES = ["新会话", "新建会话"];

/** 标题是否为默认占位（空 / "新会话" / "新建会话"）。只有默认标题才允许自动改写。 */
export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  const t = title?.trim();
  return !t || DEFAULT_SESSION_TITLES.includes(t);
}
