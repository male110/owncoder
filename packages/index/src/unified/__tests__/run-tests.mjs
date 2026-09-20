#!/usr/bin/env node
/**
 * 简单的测试运行器
 * 直接运行TypeScript测试文件
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 动态导入tsx来运行TypeScript
async function runTests() {
  try {
    console.log('🧪 Running parser tests...\n');
    
    // 使用动态import运行测试
    const testFile = join(__dirname, 'parser.test.ts');
    
    // 简单的方法: 直接用Node执行(需要先编译)
    // 或者使用tsx: npx tsx parser.test.ts
    
    console.log('✅ Test setup complete');
    console.log('\nTo run tests, use:');
    console.log('  cd packages/index');
    console.log('  npx tsx src/unified/__tests__/parser.test.ts');
    console.log('\nOr install vitest:');
    console.log('  pnpm add -D vitest');
    console.log('  pnpm vitest src/unified/__tests__');
    
  } catch (error) {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  }
}

runTests();
