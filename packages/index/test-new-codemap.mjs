/**
 * 测试新的Codemap实现(不再有native fallback)
 */

import { createCodemapClient } from "./dist/index.js";
import { resolve } from "path";

const workspacePath = process.argv[2] || resolve("./src");

console.log("========================================");
console.log("新Codemap系统测试");
console.log("========================================");
console.log(`工作区: ${workspacePath}\n`);

async function main() {
  try {
    console.log("[1/4] 创建Codemap客户端...");
    const client = await createCodemapClient();
    console.log("✓ 客户端创建成功(纯TypeScript实现)\n");
    
    console.log("[2/4] 构建索引...");
    const buildStart = Date.now();
    const buildStatus = await client.build(workspacePath);
    const buildTime = Date.now() - buildStart;
    
    console.log(`✓ 索引构建完成 (${buildTime}ms)`);
    console.log(`  文件: ${buildStatus.fileCount}`);
    console.log(`  符号: ${buildStatus.nodeCount}`);
    console.log(`  引用: ${buildStatus.edgeCount}`);
    console.log(`  数据库: ${buildStatus.databasePath}\n`);
    
    console.log("[3/4] 测试搜索...");
    const queries = ["UnifiedIndex", "search", "buildIndex"];
    for (const query of queries) {
      const results = await client.search(query, 3);
      console.log(`  "${query}": ${results.length} 个结果`);
      if (results.length > 0) {
        const top = results[0].node;
        console.log(`    → ${top.name} (${top.kind}) at ${top.path}:${top.startLine}`);
      }
    }
    console.log();
    
    console.log("[4/4] 测试影响分析...");
    const searchResult = await client.search("buildIndex", 1);
    if (searchResult.length > 0) {
      const impact = await client.impact(searchResult[0].node.name, 2);
      console.log(`  符号: ${impact.focal.name}`);
      console.log(`  风险: ${impact.riskLevel} (分数: ${impact.riskScore})`);
      console.log(`  调用者: ${impact.callers.length}`);
      console.log(`  被调用: ${impact.callees.length}\n`);
    }
    
    console.log("========================================");
    console.log("✓ 所有测试通过!");
    console.log("========================================");
    console.log("\n🎉 新的Codemap系统(纯TypeScript)工作正常!");
    console.log("   不再依赖Rust native模块");
    
  } catch (error) {
    console.error("\n✗ 测试失败:", error);
    process.exit(1);
  }
}

main();
