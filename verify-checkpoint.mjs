import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  persistCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  restoreCheckpointFiles,
  newCheckpointId,
} from "./packages/core/dist/harness/checkpoint.js";

async function verify() {
  const testRoot = join(tmpdir(), `checkpoint-verify-${Date.now()}`);
  console.log(`测试目录: ${testRoot}`);
  
  try {
    await fs.mkdir(testRoot, { recursive: true });
    
    // 测试 1: 创建 checkpoint
    console.log("\n✓ 测试 1: 创建 checkpoint");
    const testFile = join(testRoot, "test.txt");
    await fs.writeFile(testFile, "initial content");
    
    const checkpoint1 = {
      checkpointId: newCheckpointId(),
      turnIndex: 1,
      chatHistory: [],
      files: [
        {
          path: "test.txt",
          content: "initial content",
          contentHash: "hash1"
        }
      ]
    };
    
    await persistCheckpoint(testRoot, "test-session", checkpoint1);
    console.log(`  已创建 checkpoint: ${checkpoint1.checkpointId}`);
    
    // 测试 2: 列出 checkpoints
    console.log("\n✓ 测试 2: 列出 checkpoints");
    const list = await listCheckpoints(testRoot, "test-session");
    console.log(`  找到 ${list.length} 个 checkpoint`);
    if (list.length !== 1) {
      throw new Error(`期望 1 个 checkpoint，实际 ${list.length} 个`);
    }
    
    // 测试 3: 加载 checkpoint
    console.log("\n✓ 测试 3: 加载 checkpoint");
    const loaded = await loadCheckpoint(testRoot, "test-session", checkpoint1.checkpointId);
    if (!loaded) {
      throw new Error("无法加载 checkpoint");
    }
    console.log(`  已加载 checkpoint，包含 ${loaded.files.length} 个文件`);
    
    // 测试 4: 修改文件后恢复
    console.log("\n✓ 测试 4: 修改文件后恢复");
    await fs.writeFile(testFile, "modified content");
    const restored = await restoreCheckpointFiles(testRoot, "test-session", checkpoint1.checkpointId);
    console.log(`  已恢复 ${restored.length} 个文件`);
    
    const restoredContent = await fs.readFile(testFile, "utf-8");
    if (restoredContent !== "initial content") {
      throw new Error(`恢复失败，内容为: ${restoredContent}`);
    }
    console.log(`  文件内容已恢复为: ${restoredContent}`);
    
    // 测试 5: 创建第二个 checkpoint（增量存储）
    console.log("\n✓ 测试 5: 创建第二个 checkpoint（增量存储）");
    const checkpoint2 = {
      checkpointId: newCheckpointId(),
      turnIndex: 2,
      chatHistory: [],
      files: [
        {
          path: "test.txt",
          content: "updated content",
          contentHash: "hash2"
        }
      ]
    };
    
    await persistCheckpoint(testRoot, "test-session", checkpoint2);
    console.log(`  已创建第二个 checkpoint: ${checkpoint2.checkpointId}`);
    
    const list2 = await listCheckpoints(testRoot, "test-session");
    console.log(`  现在有 ${list2.length} 个 checkpoint`);
    if (list2.length !== 2) {
      throw new Error(`期望 2 个 checkpoint，实际 ${list2.length} 个`);
    }
    
    console.log("\n🎉 所有测试通过！新的 Git checkpoint 实现工作正常。");
    
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    throw error;
  } finally {
    // 清理
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
      console.log(`\n清理测试目录: ${testRoot}`);
    } catch (err) {
      console.warn(`清理失败: ${err.message}`);
    }
  }
}

verify().catch(err => {
  console.error(err);
  process.exit(1);
});
