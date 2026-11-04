import { promises as fs } from "node:fs";
import { isPlanPath } from "../../plans.ts";
import { snapshotFileBeforeWrite } from "../checkpoint.ts";
import { applyUnifiedDiff } from "./unified-diff.ts";
import { resolvePatchTarget } from "./patch-target.ts";
import { applySearchReplace } from "./search-replace.ts";
import { rewriteByLocator, type PatchEditOutcome } from "./exact-edit.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { assertPlanMutationAllowed, fail } from "./shared.ts";
import { okMutation, resolveEditPath } from "./fs-shared.ts";

/**
 * 定位失败时的"邻近片段"提示：取探针首行在正文中首次出现的位置，连同
 * 上下数行一起返回，方便模型对照自己手里的文本与文件现状。
 */
function nearbyExcerpt(content: string, query: string): string {
  const needle = query.trim().split("\n")[0]?.trim();
  if (!needle) return "";
  const lines = content.split("\n");
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      best = i;
      break;
    }
  }
  if (best < 0) return "";
  const start = Math.max(0, best - 2);
  const end = Math.min(lines.length, best + 3);
  return lines.slice(start, end).join("\n");
}

/**
 * 旧式补丁体兜底：依次尝试 SEARCH/REPLACE 标记块与 unified diff，两者都
 * 走不通时给出合并诊断。新的片段改写路径（old_string/new_string）已覆盖
 * 绝大多数场景，这里仅为兼容仍在发送旧格式的既有提示与会话而保留。
 */
function applyLegacyPatch(
  original: string,
  patch: string,
): { success: boolean; content?: string; error?: string; replacements?: number } {
  if (!patch.trim()) {
    return {
      success: false,
      error:
        'apply_patch needs either old_string/new_string (recommended) or a patch body. ' +
        "Provide old_string with the exact text to replace and new_string with the replacement.",
      replacements: 0,
    };
  }

  // Line-level marker detection (stricter than substring includes to avoid
  // false positives when markers appear inside code/comments).
  const looksLikeSearchReplace = /^<{3,}\s*SEARCH/mi.test(patch);
  const looksLikeUnifiedDiff = /(?:^|\n)diff\s|^---\s[ab]/m.test(patch) ||
    (patch.includes("---") && patch.includes("+++") && patch.includes("@@"));

  let result: { success: boolean; content?: string; error?: string; replacements?: number } | undefined;

  if (looksLikeSearchReplace) {
    result = applySearchReplace(original, patch);
    // If parsing found 0 blocks despite detected markers, the markers may have
    // been inside code content — fall through to try unified diff.
    if (!result.success && result.replacements === 0 &&
        result.error?.includes("No SEARCH/REPLACE blocks")) {
      result = undefined;
    }
  }

  if (!result && looksLikeUnifiedDiff) {
    result = applyUnifiedDiff(original, patch);
  }

  if (!result) {
    const srResult = applySearchReplace(original, patch);
    if (srResult.success) return srResult;
    const udResult = applyUnifiedDiff(original, patch);
    if (udResult.success) return udResult;
    return {
      success: false,
      error:
        "Could not apply patch in any supported format.\n\n" +
        "Attempted SEARCH/REPLACE: " + (srResult.error ?? "no blocks found") + "\n\n" +
        "Attempted Unified Diff: " + (udResult.error ?? "parse failed") + "\n\n" +
        "Preferred format (old_string / new_string):\n" +
        '{"file_path": "...", "old_string": "exact text from the file", "new_string": "replacement"}\n\n' +
        "Or legacy SEARCH/REPLACE:\n" +
        "<<<<<<< SEARCH\n" +
        "exact text from file\n" +
        "=======\n" +
        "replacement text\n" +
        ">>>>>>> REPLACE\n\n" +
        "For new files or complete rewrites, use write_file instead.",
      replacements: 0,
    };
  }

  return result;
}

/** 把旧式补丁体的返回形状（success/content/error）适配为片段改写结构
 *  （ok/text/message），使后续处理只需面对一种形状。 */
function adaptLegacyResult(legacy: {
  success: boolean;
  content?: string;
  error?: string;
  replacements?: number;
}): PatchEditOutcome {
  return {
    ok: legacy.success,
    text: legacy.content,
    message: legacy.error,
    replaced: legacy.replacements,
  };
}

export async function toolPatch(
  ctx: ToolContext,
  path: string,
  patch: string,
  oldString = "",
  newString = "",
  replaceAll = false,
): Promise<ToolResult> {
  const target = resolvePatchTarget(path, patch, oldString);
  if ("error" in target) return fail(target.error);
  path = target.path;
  const { abs, rel, external } = resolveEditPath(ctx, path);
  const planBlock = assertPlanMutationAllowed(ctx, rel);
  if (planBlock) return planBlock;
  let original = "";
  let fileExists = false;
  try {
    original = await fs.readFile(abs, "utf8");
    fileExists = true;
    // 模型若漏读了文件，这次成功读取即可顺带满足"先读后写"约束，不必
    // 再浪费一轮对话。
    if (!ctx.readSet.has(rel)) {
      ctx.readSet.add(rel);
      ctx.onEvent?.({ type: "tool_primed_read", path: rel, tool: "apply_patch" });
      console.log(`[primed-read] read-before-write satisfied for apply_patch on ${rel}`);
    }
  } catch (e: any) {
    // 文件不存在时补丁体无从施加；若模型此前也没读过，直接给出引导。
    if (!ctx.readSet.has(rel)) {
      return fail(
        `There is no file at "${rel}". Create it with write_file instead of apply_patch.`
      );
    }
    fileExists = false;
  }

  if (!fileExists) {
    return fail(
      `There is no file at "${rel}". Create it with write_file instead of apply_patch.`
    );
  }

  // 片段改写为主路径：模型直接给出 old_string / new_string（可选
  // replace_all），无需记忆任何标记语法，也不存在行号错位。契约是
  // "逐字命中且位置唯一"。
  let editResult: (PatchEditOutcome & { text?: string }) | undefined;

  if (oldString.trim()) {
    editResult = rewriteByLocator(original, oldString, newString, replaceAll, nearbyExcerpt(original, oldString));

    // 读取过期自愈：逐字与各宽松定位器全部落空，说明文件可能在刚才的
    // 读取之后被用户、格式化工具或其它进程改写过。放弃前先重读一次
    // 磁盘并按最新内容重试，全程对模型透明、不额外消耗轮次。仅
    // "missing_target" 值得重试："multiple_targets" 缺的是更多上下文，
    // 重读补不出来；"bad_request"/"nothing_to_do" 则是模型自身的问题。
    if (editResult && !editResult.ok && editResult.fault === "missing_target") {
      let fresh = "";
      try {
        fresh = await fs.readFile(abs, "utf8");
      } catch {
        fresh = "";
      }
      if (fresh !== "" && fresh !== original) {
        original = fresh;
        ctx.onEvent?.({ type: "tool_refresh_retry", path: rel, tool: "apply_patch" });
        console.log(`[refresh-retry] file changed on disk; retried apply_patch on ${rel}`);
        editResult = rewriteByLocator(
          fresh,
          oldString,
          newString,
          replaceAll,
          nearbyExcerpt(fresh, oldString),
        );
      }
    }
  }

  // 旧式补丁体兜底（SEARCH/REPLACE 块、unified diff），仅为兼容旧格式；
  // 新代码应优先使用 old_string/new_string。
  if (!editResult) {
    editResult = adaptLegacyResult(applyLegacyPatch(original, patch));
  }

  if (!editResult || !editResult.ok || editResult.text === undefined) {
    return fail(editResult?.message ?? "patch failed");
  }

  // 写前快照，随后落盘
  if (!external && ctx.fileSnapshots) {
    await snapshotFileBeforeWrite(ctx.workspaceRoot, rel, ctx.fileSnapshots);
  }
  await fs.writeFile(abs, editResult.text, "utf8");
  if (!external) {
    ctx.touchedPaths?.push(rel);
    if (isPlanPath(rel)) ctx.lastPlanPath = rel;
    ctx.index.invalidate(rel);
    void ctx.index.ragUpdate?.(ctx.workspaceRoot, [], [rel], []);
  }

  // 记入会话记忆
  if (ctx.memory) {
    ctx.memory.addEdit(rel, "apply_patch", original.slice(0, 100), editResult.text.slice(0, 100));
    ctx.memory.updateHotspot(rel, true, false);
  }

  const changes = 'replaced' in editResult ? editResult.replaced : 'applied';
  const successMsg = `Patched ${rel} (${changes} changes)${external ? " - outside workspace, not tracked for session undo" : ""}`;

  return okMutation(successMsg, rel);
}
