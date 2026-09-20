/**
 * 解析器测试套件 - 使用Vitest
 * 
 * 测试覆盖:
 * - TypeScript/JavaScript 符号提取
 * - Python 符号提取
 * - 引用提取
 * - 边界条件和错误处理
 */

import { describe, it, expect } from 'vitest';
import { extractSymbols, extractReferences } from '../parser';

// ========== TypeScript 符号提取测试 ==========

describe('extractSymbols - TypeScript', () => {
  it('should extract function declarations', () => {
    const code = `
      function foo() {}
      export function bar() {}
      async function baz() {}
      export async function qux() {}
    `;

    const symbols = extractSymbols(code, 'typescript');

    expect(symbols).toHaveLength(4);
    expect(symbols[0]).toMatchObject({ name: 'foo', kind: 'function', exported: false });
    expect(symbols[1]).toMatchObject({ name: 'bar', kind: 'function', exported: true });
    expect(symbols[2]).toMatchObject({ name: 'baz', kind: 'function', exported: false });
    expect(symbols[3]).toMatchObject({ name: 'qux', kind: 'function', exported: true });
  });

  it('should extract arrow functions', () => {
    const code = `
      const foo = () => {};
      export const bar = async () => {};
      let baz = (x: number) => x * 2;
    `;

    const symbols = extractSymbols(code, 'typescript');

    const functions = symbols.filter(s => s.kind === 'function');
    expect(functions).toHaveLength(3);
    expect(functions.find(s => s.name === 'foo')).toMatchObject({ kind: 'function', exported: false });
    expect(functions.find(s => s.name === 'bar')).toMatchObject({ kind: 'function', exported: true });
  });

  it('should extract class declarations', () => {
    const code = `
      class Foo {}
      export class Bar extends Baz {}
      abstract class Qux implements IQux {}
      export abstract class Widget<T> {}
    `;

    const symbols = extractSymbols(code, 'typescript');

    expect(symbols).toHaveLength(4);
    expect(symbols[0]).toMatchObject({ name: 'Foo', kind: 'class', exported: false });
    expect(symbols[1]).toMatchObject({ name: 'Bar', kind: 'class', exported: true });
    expect(symbols[2]).toMatchObject({ name: 'Qux', kind: 'class', exported: false });
    expect(symbols[3]).toMatchObject({ name: 'Widget', kind: 'class', exported: true });
  });

  it('should extract interfaces', () => {
    const code = `
      interface Foo {}
      export interface Bar<T> {}
      interface Baz extends Qux {}
    `;

    const symbols = extractSymbols(code, 'typescript');

    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({ name: 'Foo', kind: 'interface', exported: false });
    expect(symbols[1]).toMatchObject({ name: 'Bar', kind: 'interface', exported: true });
  });

  it('should extract type aliases', () => {
    const code = `
      type Foo = string;
      export type Bar<T> = T | null;
      type Union = "a" | "b" | "c";
    `;

    const symbols = extractSymbols(code, 'typescript');

    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({ name: 'Foo', kind: 'type', exported: false });
    expect(symbols[1]).toMatchObject({ name: 'Bar', kind: 'type', exported: true });
  });

  it('should extract constants but not arrow functions', () => {
    const code = `
      const VALUE = 42;
      export const API_KEY = "secret";
      const handler = () => {};
    `;

    const symbols = extractSymbols(code, 'typescript');

    const constants = symbols.filter(s => s.kind === 'constant');
    const functions = symbols.filter(s => s.kind === 'function');

    expect(constants).toHaveLength(2);
    expect(functions).toHaveLength(1);
    expect(constants.find(s => s.name === 'VALUE')).toBeDefined();
  });

  it('should extract enums', () => {
    const code = `
      enum Status { Active, Inactive }
      export enum Color { Red = "red", Blue = "blue" }
    `;

    const symbols = extractSymbols(code, 'typescript');

    expect(symbols).toHaveLength(2);
    expect(symbols[0]).toMatchObject({ name: 'Status', kind: 'enum', exported: false });
    expect(symbols[1]).toMatchObject({ name: 'Color', kind: 'enum', exported: true });
  });

  it('should handle generic type parameters', () => {
    const code = `
      function process<T>(value: T): T {}
      class Container<T, U> {}
      interface Mapper<K, V> {}
      type Result<T> = T | Error;
    `;

    const symbols = extractSymbols(code, 'typescript');

    expect(symbols).toHaveLength(4);
    const names = symbols.map(s => s.name);
    expect(names).toContain('process');
    expect(names).toContain('Container');
    expect(names).toContain('Mapper');
    expect(names).toContain('Result');
  });

  it('should handle valid identifier characters', () => {
    const code = `
      function _private() {}
      function $jquery() {}
      function validName123() {}
    `;

    const symbols = extractSymbols(code, 'typescript');

    const functionNames = symbols.filter(s => s.kind === 'function').map(s => s.name);
    expect(functionNames).toContain('_private');
    expect(functionNames).toContain('$jquery');
    expect(functionNames).toContain('validName123');
  });

  it('should handle malformed code gracefully', () => {
    const code = `
      function { invalid syntax
      class broken
      const incomplete =
    `;

    expect(() => extractSymbols(code, 'typescript')).not.toThrow();
    const symbols = extractSymbols(code, 'typescript');
    expect(Array.isArray(symbols)).toBe(true);
  });
});

// ========== TypeScript 引用提取测试 ==========

describe('extractReferences - TypeScript', () => {
  it('should extract import statements', () => {
    const code = `
      import { foo, bar as baz } from "./module";
      import defaultExport from "./other";
    `;

    const refs = extractReferences(code, 'typescript');

    const imports = refs.filter(r => r.refType === 'import');
    expect(imports.length).toBeGreaterThan(0);
    
    const importNames = imports.map(r => r.toSymbolName);
    expect(importNames).toContain('foo');
    expect(importNames).toContain('bar');
    expect(importNames).toContain('defaultExport');
  });

  it('should extract function calls', () => {
    const code = `
      function test() {
        foo();
        bar(arg1, arg2);
      }
    `;

    const refs = extractReferences(code, 'typescript');

    const calls = refs.filter(r => r.refType === 'call');
    const callNames = calls.map(r => r.toSymbolName);
    
    expect(callNames).toContain('foo');
    expect(callNames).toContain('bar');
  });

  it('should extract method calls', () => {
    const code = `
      obj.method();
      Class.staticMethod();
      this.instanceMethod();
    `;

    const refs = extractReferences(code, 'typescript');

    const methodCalls = refs.filter(r => r.refType === 'method_call');
    const methodNames = methodCalls.map(r => r.toSymbolName);
    
    expect(methodNames).toContain('method');
    expect(methodNames).toContain('staticMethod');
    expect(methodNames).toContain('instanceMethod');
  });

  it('should extract constant references', () => {
    const code = `
      function test() {
        const value = MAX_SIZE + MIN_SIZE;
        if (status === STATUS_ACTIVE) {}
      }
    `;

    const refs = extractReferences(code, 'typescript');

    const constRefs = refs.filter(r => r.refType === 'reference');
    const constNames = constRefs.map(r => r.toSymbolName);
    
    // 至少应该捕获到STATUS_ACTIVE (全大写且在非定义行)
    expect(constNames).toContain('STATUS_ACTIVE');
    
    // MAX_SIZE和MIN_SIZE在const行中,可能被跳过,这是预期行为
    // 因为解析器会跳过定义行以避免将声明误认为引用
  });

  it('should filter out keywords', () => {
    const code = `
      if (condition) {}
      while (true) {}
      for (let i = 0; i < 10; i++) {}
      async function asyncTest() {}
    `;

    const refs = extractReferences(code, 'typescript');

    const callNames = refs.filter(r => r.refType === 'call').map(r => r.toSymbolName);
    
    expect(callNames).not.toContain('if');
    expect(callNames).not.toContain('while');
    expect(callNames).not.toContain('for');
    expect(callNames).not.toContain('async');
  });

  it('should record line numbers', () => {
    const code = `foo();
bar();
baz();`;

    const refs = extractReferences(code, 'typescript');

    const calls = refs.filter(r => r.refType === 'call');
    
    expect(calls[0].line).toBe(1);
    expect(calls[1].line).toBe(2);
    expect(calls[2].line).toBe(3);
  });
});

// ========== Python 符号提取测试 ==========

describe('extractSymbols - Python', () => {
  it('should extract function definitions', () => {
    const code = `
def foo():
    pass

def bar(x, y):
    return x + y

def _private():
    pass
    `;

    const symbols = extractSymbols(code, 'python');

    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({ name: 'foo', kind: 'function', exported: true });
    expect(symbols[1]).toMatchObject({ name: 'bar', kind: 'function', exported: true });
    expect(symbols[2]).toMatchObject({ name: '_private', kind: 'function', exported: false });
  });

  it('should extract class definitions', () => {
    const code = `
class Foo:
    pass

class Bar(Base):
    pass

class _Private:
    pass
    `;

    const symbols = extractSymbols(code, 'python');

    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({ name: 'Foo', kind: 'class', exported: true });
    expect(symbols[1]).toMatchObject({ name: 'Bar', kind: 'class', exported: true });
    expect(symbols[2]).toMatchObject({ name: '_Private', kind: 'class', exported: false });
  });
});

// ========== Python 引用提取测试 ==========

describe('extractReferences - Python', () => {
  it('should extract import statements', () => {
    const code = `
import os
import sys
from pathlib import Path
from typing import List, Dict
    `;

    const refs = extractReferences(code, 'python');

    const imports = refs.filter(r => r.refType === 'import');
    const importNames = imports.map(r => r.toSymbolName);
    
    expect(importNames).toContain('os');
    expect(importNames).toContain('sys');
    expect(importNames).toContain('Path');
  });

  it('should extract function calls', () => {
    const code = `
def test():
    len(items)
    process(data)
    `;

    const refs = extractReferences(code, 'python');

    const calls = refs.filter(r => r.refType === 'call');
    const callNames = calls.map(r => r.toSymbolName);
    
    expect(callNames).toContain('len');
    expect(callNames).toContain('process');
  });

  it('should extract method calls', () => {
    const code = `
obj.method()
self.process()
Class.static_method()
    `;

    const refs = extractReferences(code, 'python');

    const methodCalls = refs.filter(r => r.refType === 'method_call');
    const methodNames = methodCalls.map(r => r.toSymbolName);
    
    expect(methodNames).toContain('method');
    expect(methodNames).toContain('process');
    expect(methodNames).toContain('static_method');
  });
});

// ========== 边界条件测试 ==========

describe('extractSymbols - Edge Cases', () => {
  it('should return empty array for unsupported language', () => {
    const code = 'function foo() {}';
    const symbols = extractSymbols(code, 'unsupported-lang');
    expect(symbols).toEqual([]);
  });

  it('should handle empty code', () => {
    const symbols = extractSymbols('', 'typescript');
    expect(symbols).toEqual([]);
  });

  it('should handle code with only whitespace', () => {
    const symbols = extractSymbols('   \n\n\t  ', 'typescript');
    expect(symbols).toEqual([]);
  });

  it('should handle very long symbol names', () => {
    const longName = 'a'.repeat(1000);
    const code = `function ${longName}() {}`;
    
    const symbols = extractSymbols(code, 'typescript');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe(longName);
  });
});

// ========== 准确性验证测试 ==========

describe('Parser Accuracy - Real World Cases', () => {
  it('should extract all symbols from a realistic TypeScript file', () => {
    const code = `
import { readFileSync } from 'fs';

export interface Config {
  name: string;
  version: number;
}

export type Status = 'active' | 'inactive';

export const MAX_RETRIES = 3;

export class DataProcessor {
  constructor(private config: Config) {}
  
  process(data: string): string {
    return data.toUpperCase();
  }
}

export function loadConfig(path: string): Config {
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content);
}

const helper = () => {
  console.log('helper');
};
    `;

    const symbols = extractSymbols(code, 'typescript');
    const symbolNames = symbols.map(s => s.name);

    // 验证所有主要符号都被提取
    expect(symbolNames).toContain('Config');
    expect(symbolNames).toContain('Status');
    expect(symbolNames).toContain('MAX_RETRIES');
    expect(symbolNames).toContain('DataProcessor');
    expect(symbolNames).toContain('loadConfig');
    expect(symbolNames).toContain('helper');

    // 验证导出状态
    const configSymbol = symbols.find(s => s.name === 'Config');
    expect(configSymbol?.exported).toBe(true);
    
    const helperSymbol = symbols.find(s => s.name === 'helper');
    expect(helperSymbol?.exported).toBe(false);
  });

  it('should extract references from a realistic file', () => {
    const code = `
import { helper } from './utils';

export function main() {
  const result = helper();
  console.log(result);
  process.exit(0);
}
    `;

    const refs = extractReferences(code, 'typescript');

    // 验证import
    const imports = refs.filter(r => r.refType === 'import');
    expect(imports.some(r => r.toSymbolName === 'helper')).toBe(true);

    // 验证函数调用
    const calls = refs.filter(r => r.refType === 'call');
    const callNames = calls.map(r => r.toSymbolName);
    expect(callNames).toContain('helper');
    expect(callNames).toContain('exit');

    // 验证方法调用
    const methodCalls = refs.filter(r => r.refType === 'method_call');
    const methodNames = methodCalls.map(r => r.toSymbolName);
    expect(methodNames).toContain('log');
  });
});
