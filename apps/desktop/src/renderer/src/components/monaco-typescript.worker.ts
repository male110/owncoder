// The TypeScript worker imports the editor worker and uses the same resource root.
globalThis._VSCODE_FILE_ROOT = new URL("./", import.meta.url).toString();

// 导入语言服务期间也要保存初始化消息和后续 RPC。
const pending: MessageEvent[] = [];
globalThis.onmessage = (event) => { pending.push(event); };
// @ts-expect-error Monaco 0.52 ships this ESM worker without declarations.
void import("monaco-editor/esm/vs/language/typescript/ts.worker").then(() => {
  for (const event of pending) globalThis.dispatchEvent(event);
  pending.length = 0;
});
