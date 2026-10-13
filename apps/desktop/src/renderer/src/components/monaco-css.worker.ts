// Monaco 0.52 ESM workers resolve foreign modules relative to this root.
globalThis._VSCODE_FILE_ROOT = new URL("./", import.meta.url).toString();

// 动态导入期间 RPC 请求已经可能到达，必须缓存并按顺序交给 Monaco。
const pending: MessageEvent[] = [];
globalThis.onmessage = (event) => { pending.push(event); };
// @ts-expect-error Monaco 0.52 ships this ESM worker without declarations.
void import("monaco-editor/esm/vs/language/css/css.worker").then(() => {
  for (const event of pending) globalThis.dispatchEvent(new MessageEvent("message", { data: event.data }));
  pending.length = 0;
});
