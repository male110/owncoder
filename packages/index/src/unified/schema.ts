/**
 * 统一索引系统的SQLite数据库Schema
 * 
 * 设计原则:
 * 1. 单一数据库存储所有索引数据
 * 2. 利用SQLite FTS5进行全文搜索
 * 3. 使用递归CTE进行图遍历
 * 4. 增量更新通过hash对比实现
 * 5. 版本化迁移支持schema演进
 */

import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;

/**
 * Schema迁移定义
 */
interface SchemaMigration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

/**
 * 所有schema迁移
 * 按版本号排序,从1开始
 */
const MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    description: "Initial schema - files, symbols, references, FTS5 indexes",
    up: (db: Database.Database) => {
      // 文件表 - 存储所有被索引的文件
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT UNIQUE NOT NULL,
          language TEXT,
          size INTEGER NOT NULL,
          hash TEXT NOT NULL,
          indexed_at INTEGER NOT NULL,
          mtime INTEGER NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
        CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
      `);

      // 符号表 - 存储函数、类、变量等代码符号
      db.exec(`
        CREATE TABLE IF NOT EXISTS symbols (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          qualified_name TEXT,
          kind TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          start_col INTEGER,
          end_col INTEGER,
          exported BOOLEAN DEFAULT 0,
          signature TEXT,
          doc TEXT,
          UNIQUE(file_id, name, kind, start_line)
        );
        
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
        CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified_name);
      `);

      // 引用关系表 - 存储符号之间的引用关系
      db.exec(`
        CREATE TABLE IF NOT EXISTS symbol_references (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          to_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          ref_type TEXT NOT NULL,
          line INTEGER NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_refs_from ON symbol_references(from_symbol_id);
        CREATE INDEX IF NOT EXISTS idx_refs_to ON symbol_references(to_symbol_id);
      `);

      // FTS5全文索引 - 符号搜索
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
          name,
          qualified_name,
          signature,
          doc,
          content=symbols,
          content_rowid=id
        );
        
        CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
          INSERT INTO symbols_fts(rowid, name, qualified_name, signature, doc)
          VALUES (new.id, new.name, new.qualified_name, new.signature, new.doc);
        END;
        
        CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
          DELETE FROM symbols_fts WHERE rowid = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
          INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, signature, doc)
          VALUES ('delete', old.id, old.name, old.qualified_name, old.signature, old.doc);
          INSERT INTO symbols_fts(rowid, name, qualified_name, signature, doc)
          VALUES (new.id, new.name, new.qualified_name, new.signature, new.doc);
        END;
      `);

      // FTS5全文索引 - 文件内容搜索(可选)
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
          path,
          content
        );
      `);
    },
    down: (db: Database.Database) => {
      // 回滚:删除所有表
      db.exec(`
        DROP TABLE IF EXISTS files_fts;
        DROP TRIGGER IF EXISTS symbols_ad;
        DROP TRIGGER IF EXISTS symbols_ai;
        DROP TABLE IF EXISTS symbols_fts;
        DROP TABLE IF EXISTS symbol_references;
        DROP TABLE IF EXISTS symbols;
        DROP TABLE IF EXISTS files;
      `);
    },
  },
  {
    version: 2,
    description: "Support unresolved cross-file references - allow NULL to_symbol_id, add to_symbol_name and to_file_path",
    up: (db: Database.Database) => {
      // SQLite不支持ALTER TABLE MODIFY COLUMN
      // 需要创建新表,复制数据,然后重命名
      
      // 1. 创建新的symbol_references表(允许to_symbol_id为NULL)
      db.exec(`
        CREATE TABLE symbol_references_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          to_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
          to_symbol_name TEXT,
          to_file_path TEXT,
          ref_type TEXT NOT NULL,
          line INTEGER NOT NULL,
          CHECK (
            (to_symbol_id IS NOT NULL) OR 
            (to_symbol_name IS NOT NULL AND to_file_path IS NOT NULL)
          )
        );
      `);

      // 2. 复制现有数据
      db.exec(`
        INSERT INTO symbol_references_new (
          id, from_symbol_id, to_symbol_id, ref_type, line
        )
        SELECT id, from_symbol_id, to_symbol_id, ref_type, line
        FROM symbol_references;
      `);

      // 3. 删除旧表
      db.exec(`DROP TABLE symbol_references;`);

      // 4. 重命名新表
      db.exec(`ALTER TABLE symbol_references_new RENAME TO symbol_references;`);

      // 5. 重建索引
      db.exec(`
        CREATE INDEX idx_refs_from ON symbol_references(from_symbol_id);
        CREATE INDEX idx_refs_to ON symbol_references(to_symbol_id);
        CREATE INDEX idx_refs_unresolved ON symbol_references(to_symbol_name, to_file_path) 
          WHERE to_symbol_id IS NULL;
      `);
    },
    down: (db: Database.Database) => {
      // 回滚:恢复到只有已解析引用的状态
      
      // 1. 创建旧版本的表
      db.exec(`
        CREATE TABLE symbol_references_old (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          to_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          ref_type TEXT NOT NULL,
          line INTEGER NOT NULL
        );
      `);

      // 2. 只复制已解析的引用(to_symbol_id不为NULL)
      db.exec(`
        INSERT INTO symbol_references_old (
          id, from_symbol_id, to_symbol_id, ref_type, line
        )
        SELECT id, from_symbol_id, to_symbol_id, ref_type, line
        FROM symbol_references
        WHERE to_symbol_id IS NOT NULL;
      `);

      // 3. 删除新表
      db.exec(`DROP TABLE symbol_references;`);

      // 4. 重命名
      db.exec(`ALTER TABLE symbol_references_old RENAME TO symbol_references;`);

      // 5. 重建索引
      db.exec(`
        CREATE INDEX idx_refs_from ON symbol_references(from_symbol_id);
        CREATE INDEX idx_refs_to ON symbol_references(to_symbol_id);
      `);
    },
  },
  {
    version: 3,
    description: "Repair FTS maintenance and rebuild stale file/symbol search indexes",
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
          INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, signature, doc)
          VALUES ('delete', old.id, old.name, old.qualified_name, old.signature, old.doc);
          INSERT INTO symbols_fts(rowid, name, qualified_name, signature, doc)
          VALUES (new.id, new.name, new.qualified_name, new.signature, new.doc);
        END;

        DELETE FROM files_fts
        WHERE rowid NOT IN (SELECT id FROM files);
        INSERT INTO symbols_fts(symbols_fts) VALUES ('rebuild');
      `);
    },
  },
];

/**
 * 初始化数据库Schema
 * 
 * 使用版本化迁移系统,支持schema演进。
 * 
 * @param db - SQLite数据库实例
 * 
 * @example
 * ```typescript
 * const db = new Database("index.db");
 * initializeSchema(db);
 * ```
 */
export function initializeSchema(db: Database.Database): void {
  // 启用WAL模式以支持并发读
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000"); // 等待5秒而非立即失败

  // 创建版本表（向后兼容：旧版本可能缺少description/applied_at列）
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  
  // 补齐旧版schema_version可能缺失的列
  try {
    const columns = db.prepare("PRAGMA table_info(schema_version)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(c => c.name));
    if (!colNames.has("description")) {
      db.exec(`ALTER TABLE schema_version ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
    }
    if (!colNames.has("applied_at")) {
      db.exec(`ALTER TABLE schema_version ADD COLUMN applied_at INTEGER NOT NULL DEFAULT 0`);
    }
  } catch {
    // 表刚创建的，列已经齐全，忽略
  }

  // 获取当前版本
  const currentVersion = getCurrentSchemaVersion(db);

  // 执行迁移
  const migrationsToApply = MIGRATIONS.filter(m => m.version > currentVersion);

  if (migrationsToApply.length === 0) {
    console.log(`[Schema] Already at version ${currentVersion}, no migrations needed`);
    return;
  }

  console.log(`[Schema] Current version: ${currentVersion}, target: ${SCHEMA_VERSION}`);
  console.log(`[Schema] Applying ${migrationsToApply.length} migrations...`);

  for (const migration of migrationsToApply) {
    console.log(`[Schema] Applying migration ${migration.version}: ${migration.description}`);

    const transaction = db.transaction(() => {
      migration.up(db);
      
      db.prepare(`
        INSERT INTO schema_version (version, description, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.description, Date.now());
    });

    try {
      transaction();
      console.log(`[Schema] ✓ Migration ${migration.version} applied successfully`);
    } catch (error) {
      console.error(`[Schema] ✗ Migration ${migration.version} failed:`, error);
      throw new Error(`Schema migration ${migration.version} failed: ${error}`);
    }
  }

  console.log(`[Schema] All migrations applied, now at version ${SCHEMA_VERSION}`);
}

/**
 * 获取当前schema版本
 * 
 * @param db - SQLite数据库实例
 * @returns 当前版本号,如果未初始化则返回0
 */
export function getCurrentSchemaVersion(db: Database.Database): number {
  try {
    const version = db
      .prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
      .pluck()
      .get() as number | undefined;

    return version ?? 0;
  } catch {
    // 表不存在,版本为0
    return 0;
  }
}

/**
 * 回滚到指定版本
 * 
 * ⚠️ 警告: 这会删除数据!仅用于开发和测试。
 * 
 * @param db - SQLite数据库实例
 * @param targetVersion - 目标版本号
 * 
 * @example
 * ```typescript
 * // 回滚到版本1
 * rollbackSchema(db, 1);
 * 
 * // 回滚到初始状态
 * rollbackSchema(db, 0);
 * ```
 */
export function rollbackSchema(db: Database.Database, targetVersion: number): void {
  const currentVersion = getCurrentSchemaVersion(db);

  if (targetVersion >= currentVersion) {
    console.log(`[Schema] Already at or below version ${targetVersion}`);
    return;
  }

  console.log(`[Schema] Rolling back from ${currentVersion} to ${targetVersion}`);

  const migrationsToRollback = MIGRATIONS
    .filter(m => m.version > targetVersion && m.version <= currentVersion)
    .sort((a, b) => b.version - a.version); // 降序

  for (const migration of migrationsToRollback) {
    if (!migration.down) {
      throw new Error(`Migration ${migration.version} does not support rollback`);
    }

    console.log(`[Schema] Rolling back migration ${migration.version}: ${migration.description}`);

    const transaction = db.transaction(() => {
      migration.down!(db);
      db.prepare("DELETE FROM schema_version WHERE version = ?").run(migration.version);
    });

    try {
      transaction();
      console.log(`[Schema] ✓ Migration ${migration.version} rolled back`);
    } catch (error) {
      console.error(`[Schema] ✗ Rollback ${migration.version} failed:`, error);
      throw new Error(`Schema rollback ${migration.version} failed: ${error}`);
    }
  }

  console.log(`[Schema] Rollback complete, now at version ${targetVersion}`);
}
