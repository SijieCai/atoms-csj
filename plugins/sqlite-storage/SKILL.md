---
name: atoms-sqlite-storage
description: Create user-prefixed SQLite tables and execute isolated SQL queries via the Atoms DB Proxy (both build-time MCP tools and runtime server/db.js SDK). Use whenever designing schemas, creating tables, seeding data, or implementing persistent backend APIs in an Atoms workspace.
---

# Atoms SQLite Storage Plugin (User-Prefixed Proxy)

本工作区不直接访问本地数据库文件，而是统一通过 **Atoms DB Proxy** 操作平台共享 SQLite：
- 你在建表和写 SQL 时只需使用简洁的**逻辑表名**（如 `todos`、`transactions`、`votes`，小写字母+数字+下划线）。
- 代理会自动为所有表名加上当前用户的隔离前缀（环境变量 `ATOMS_DB_PREFIX`，形如 `u_<username>_<project>__todos`），并拦截任何跨租户表或系统表访问。

## 一、开发阶段：使用 MCP 工具建表与验证

已直接挂载 `atoms_db` MCP 工具，开发时推荐先用它们完成建表、写入示例数据并验证 SQL：

1. `mcp__atoms_db__create_table` — 创建数据表（自动加用户名前缀，幂等 `IF NOT EXISTS`）：
   ```json
   {
     "table": "todos",
     "columns": [
       { "name": "id", "type": "INTEGER", "primaryKey": true, "autoIncrement": true },
       { "name": "title", "type": "TEXT", "notNull": true },
       { "name": "status", "type": "TEXT", "notNull": true, "default": "todo" },
       { "name": "created_at", "type": "TEXT", "default": "CURRENT_TIMESTAMP" }
     ],
     "indexes": [{ "columns": ["status"] }]
   }
   ```
2. `mcp__atoms_db__list_tables` — 查看当前项目命名空间下已创建的所有表（含逻辑表名、带用户名前缀的物理表名及行数）。
3. `mcp__atoms_db__describe_table` — 查看指定表的列结构。
4. `mcp__atoms_db__execute_sql` — 执行写操作（`INSERT` / `UPDATE` / `DELETE`），始终使用 `?` 参数化绑定：
   ```json
   {
     "sql": "INSERT INTO todos (title, status) VALUES (?, ?)",
     "params": ["体验 Atoms 全栈构建", "doing"]
   }
   ```
5. `mcp__atoms_db__query_sql` — 执行 `SELECT` 查询验证数据：
   ```json
   {
     "sql": "SELECT id, title, status, created_at FROM todos ORDER BY id DESC LIMIT ?",
     "params": [20]
   }
   ```
6. `mcp__atoms_db__drop_table` — 需要重建结构时删除当前命名空间下的指定表。

## 二、应用运行时：在 `server/index.js` 中使用 `./db.js` 代理客户端

工作区已内置 `server/db.js`，运行时平台会自动注入 `ATOMS_DB_PROXY_URL` 与 `ATOMS_DB_TOKEN`。

在 `server/index.js` 中直接导入并使用异步方法（全部自动附带用户名前缀隔离）：

```js
import { db } from './db.js';

// 1. 启动时幂等建表（防止环境重建后缺表）
async function initSchema() {
  await db.createTable({
    table: 'todos',
    columns: [
      { name: 'id', type: 'INTEGER', primaryKey: true, autoIncrement: true },
      { name: 'title', type: 'TEXT', notNull: true },
      { name: 'status', type: 'TEXT', notNull: true, default: 'todo' },
      { name: 'created_at', type: 'TEXT', default: 'CURRENT_TIMESTAMP' },
    ],
  });

  const existing = await db.get('SELECT COUNT(*) AS cnt FROM todos');
  if (!existing || existing.cnt === 0) {
    await db.execute('INSERT INTO todos (title, status) VALUES (?, ?)', ['欢迎使用任务看板', 'todo']);
  }
}

// 2. 在 Express 路由中读写数据
app.get('/api/todos', async (_req, res) => {
  try {
    const rows = await db.query('SELECT * FROM todos ORDER BY id DESC');
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/todos', async (req, res) => {
  try {
    const { title, status = 'todo' } = req.body || {};
    const result = await db.execute(
      'INSERT INTO todos (title, status) VALUES (?, ?)',
      [title, status],
    );
    const created = await db.get('SELECT * FROM todos WHERE id = ?', [result.lastInsertRowid]);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

## 三、SQL 安全与代理规范（务必遵守）

1. **禁止**在 `server/index.js` 中直接 `import { DatabaseSync } from 'node:sqlite'` 操作本地文件——必须通过 `./db.js` 走代理。
2. 每次 SQL 调用仅执行**单条语句**（不要用分号拼接多条 SQL）。
3. 禁止使用 `PRAGMA`、`ATTACH`、`sqlite_master` 等系统语句；查表结构请调用 `db.listTables()` / `db.describeTable(table)`。
4. 始终使用 `?` 占位符传参，避免 SQL 注入。
5. 表名仅使用小写字母、数字和下划线（如 `order_items`），代理会自动映射为带用户名前缀的物理表。
