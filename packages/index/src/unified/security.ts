/**
 * 安全工具模块
 * 
 * 提供:
 * - 路径验证和sanitization
 * - FTS5查询sanitization
 * - 文件权限设置
 * - 输入验证
 */

import upath from "upath";
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync, statSync, chmodSync } from "node:fs";

/**
 * 验证工作区路径
 * 
 * 防止路径遍历攻击和访问系统外文件
 */
export function validateWorkspacePath(path: string): string {
  // 1. 解析为绝对路径
  const resolved = resolve(path);
  
  // 2. 检查路径遍历
  if (resolved.includes("..")) {
    throw new Error(`Invalid workspace path: contains parent directory reference (..)`);
  }
  
  // 3. 检查路径是否存在
  if (!existsSync(resolved)) {
    throw new Error(`Workspace path does not exist: ${resolved}`);
  }
  
  // 4. 检查是否为目录
  try {
    const stats = statSync(resolved);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${resolved}`);
    }
  } catch (error) {
    throw new Error(`Cannot access workspace path: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // 5. 检查危险路径(根目录、系统目录等)
  const normalizedPath = upath.normalize(resolved).toLowerCase();
  const dangerousPaths = [
    "/", // Unix root
    "c:/", "c:\\", // Windows system drive root
    "/system", "/windows", "/boot", // System directories
    "/usr", "/etc", "/var", // Unix system directories
  ];
  
  for (const dangerousPath of dangerousPaths) {
    if (normalizedPath === upath.normalize(dangerousPath)) {
      throw new Error(`Cannot use system directory as workspace: ${resolved}`);
    }
  }
  
  return resolved;
}

/**
 * 验证文件路径是否在工作区内
 * 
 * 防止访问工作区外的文件
 */
export function validateFilePath(filePath: string, workspaceRoot: string): string {
  const resolvedFile = resolve(filePath);
  const resolvedRoot = resolve(workspaceRoot);
  
  // 使用relative检查是否在工作区内
  const relPath = relative(resolvedRoot, resolvedFile);
  
  // 如果相对路径以..开头,说明文件在工作区外
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    throw new Error(`File path is outside workspace: ${filePath}`);
  }
  
  return resolvedFile;
}

/**
 * Sanitize FTS5查询字符串
 * 
 * 防止FTS5查询注入和语法错误
 * 
 * FTS5特殊字符:
 * - " (双引号): 短语搜索
 * - * (星号): 前缀匹配
 * - OR, AND, NOT: 布尔运算符
 * - NEAR(): 邻近搜索
 * - ^: 列限定符
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query || typeof query !== "string") {
    return "";
  }
  
  // 1. 去除首尾空白
  let sanitized = query.trim();
  
  // 2. 限制长度
  const MAX_QUERY_LENGTH = 1000;
  if (sanitized.length > MAX_QUERY_LENGTH) {
    sanitized = sanitized.slice(0, MAX_QUERY_LENGTH);
  }
  
  // 3. 转义FTS5特殊字符
  // 保留空格,转义其他特殊字符
  sanitized = sanitized
    .replace(/["*]/g, "") // 移除引号和星号
    .replace(/\s+/g, " ") // 标准化空白
    .trim();
  
  // 4. 移除FTS5操作符(防止注入)
  sanitized = sanitized
    .replace(/\b(OR|AND|NOT|NEAR)\b/gi, "") // 移除布尔运算符
    .replace(/[\^]/g, "") // 移除列限定符
    .trim();
  
  // 5. 如果为空,返回空字符串
  if (!sanitized) {
    return "";
  }
  
  // 6. 分词并添加前缀匹配
  const tokens = sanitized
    .split(/\s+/)
    .filter(token => token.length > 0)
    .filter(token => token.length >= 2) // 过滤太短的词
    .slice(0, 10); // 限制token数量
  
  if (tokens.length === 0) {
    return "";
  }
  
  // 7. 为每个token添加引号(精确匹配)并添加前缀通配符
  return tokens.map(token => `"${token}"*`).join(" ");
}

/**
 * 验证符号名称
 * 
 * 确保符号名称合法,防止SQL注入
 */
export function validateSymbolName(name: string): boolean {
  if (!name || typeof name !== "string") {
    return false;
  }
  
  // 符号名称长度限制
  if (name.length === 0 || name.length > 500) {
    return false;
  }
  
  // 允许的字符: 字母、数字、下划线、$、点、冒号(用于命名空间)
  const validPattern = /^[a-zA-Z_$][a-zA-Z0-9_$.:]*$/;
  
  return validPattern.test(name);
}

/**
 * 设置数据库文件权限
 * 
 * 限制为用户可读写(600)
 */
export function setDatabasePermissions(dbPath: string): void {
  try {
    // 0o600 = 用户读写,其他人无权限
    // Windows上这个操作可能不生效,但不会报错
    chmodSync(dbPath, 0o600);
    console.log(`[Security] Set database permissions: ${dbPath}`);
  } catch (error) {
    // 权限设置失败不应该阻止程序运行
    console.warn(`[Security] Failed to set database permissions:`, error);
  }
}

/**
 * 验证数据库路径
 * 
 * 确保数据库在工作区的.owncoder目录内
 */
export function validateDatabasePath(dbPath: string, workspaceRoot: string): string {
  const resolvedDb = resolve(dbPath);
  const resolvedRoot = resolve(workspaceRoot);
  const expectedDir = resolve(resolvedRoot, ".owncoder");
  
  // 数据库应该在 workspace/.owncoder/ 目录下
  const relPath = relative(expectedDir, resolvedDb);
  
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    throw new Error(`Database path must be inside .owncoder directory: ${dbPath}`);
  }
  
  return resolvedDb;
}

/**
 * Sanitize SQL标识符
 * 
 * 使用反引号包裹标识符,防止SQL保留字冲突
 */
export function sanitizeSqlIdentifier(identifier: string): string {
  if (!identifier || typeof identifier !== "string") {
    throw new Error("Invalid SQL identifier");
  }
  
  // 移除已有的反引号
  const cleaned = identifier.replace(/`/g, "");
  
  // 验证标识符只包含安全字符
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cleaned)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  
  return `\`${cleaned}\``;
}

/**
 * 构建安全的LIKE模式
 * 
 * 转义LIKE通配符(%和_)
 */
export function escapeLikePattern(pattern: string): string {
  if (!pattern || typeof pattern !== "string") {
    return "";
  }
  
  // 转义 % 和 _ 通配符
  return pattern
    .replace(/\\/g, "\\\\") // 先转义反斜杠
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * 验证搜索选项
 * 
 * 确保用户输入的选项在合法范围内
 */
export interface SearchOptionsValidation {
  limit?: number;
  type?: "symbol" | "file" | "all";
  symbolKind?: string[];
  exportedOnly?: boolean;
  pathPrefix?: string;
}

export function validateSearchOptions(options?: SearchOptionsValidation): SearchOptionsValidation {
  if (!options) {
    return {};
  }
  
  const validated: SearchOptionsValidation = {};

  if (options.type === "symbol" || options.type === "file" || options.type === "all") {
    validated.type = options.type;
  }
  
  // 验证limit
  if (options.limit !== undefined) {
    const limit = Number(options.limit);
    if (isNaN(limit) || limit < 1) {
      validated.limit = 20; // 默认值
    } else if (limit > 1000) {
      validated.limit = 1000; // 最大值
    } else {
      validated.limit = Math.floor(limit);
    }
  }
  
  // 验证symbolKind
  if (options.symbolKind && Array.isArray(options.symbolKind)) {
    const allowedKinds = new Set([
      "function",
      "class",
      "interface",
      "type",
      "constant",
      "enum",
      "variable",
      "method",
      "property",
    ]);
    
    validated.symbolKind = options.symbolKind
      .filter(kind => typeof kind === "string")
      .filter(kind => allowedKinds.has(kind))
      .slice(0, 10); // 最多10种类型
  }

  if (typeof options.exportedOnly === "boolean") {
    validated.exportedOnly = options.exportedOnly;
  }
  
  // 验证pathPrefix
  if (options.pathPrefix !== undefined && typeof options.pathPrefix === "string") {
    // 移除危险字符
    validated.pathPrefix = options.pathPrefix
      .replace(/\.\./g, "") // 移除 ..
      .replace(/[<>"|?*]/g, "") // 移除Windows非法字符
      .slice(0, 500); // 限制长度
  }
  
  return validated;
}

/**
 * 日志sanitization
 * 
 * 移除日志中的敏感信息
 */
export function sanitizeLogMessage(message: string): string {
  if (!message || typeof message !== "string") {
    return "";
  }
  
  let sanitized = message;
  
  // 移除可能的文件路径中的用户名
  sanitized = sanitized.replace(/\/Users\/[^\/]+\//g, "/Users/****/");
  sanitized = sanitized.replace(/C:\\Users\\[^\\]+\\/g, "C:\\Users\\****\\");
  
  // 移除可能的API密钥模式
  sanitized = sanitized.replace(/\b[A-Za-z0-9]{32,}\b/g, "****");
  
  return sanitized;
}
