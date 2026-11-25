import crypto from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import express, { type Request, type Response } from 'express';
import type { TableColumnDTO, TableInfoDTO } from '@atoms/shared';
import { config, ensureDataDirs } from './config.js';

ensureDataDirs();

const appsDb = new DatabaseSync(config.appsDbPath);
appsDb.exec('PRAGMA journal_mode = WAL;');
appsDb.exec('PRAGMA foreign_keys = ON;');

const LOGICAL_IDENT_RE = /^[a-z][a-z0-9_]{0,47}$/;
const ALLOWED_COL_TYPES = new Set([
  'INTEGER',
  'INT',
  'TEXT',
  'REAL',
  'FLOAT',
  'DOUBLE',
  'BLOB',
  'NUMERIC',
  'BOOLEAN',
  'DATETIME',
  'TIMESTAMP',
]);

export interface DbScope {
  owner: string;
  projectId: string;
  prefix: string;
}

export interface CreateTableColumnInput {
  name: string;
  type: string;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: string | number | boolean | null;
}

export interface CreateTableInput {
  table: string;
  columns: CreateTableColumnInput[];
  indexes?: Array<{ name?: string; columns: string[]; unique?: boolean }>;
  ifNotExists?: boolean;
}

function sanitizeIdentPart(raw: string, fallback: string, maxLen: number): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '');
  const trimmed = cleaned.slice(0, maxLen);
  return trimmed || fallback;
}

/**
 * Generates a deterministic username-prefixed physical table namespace:
 *   u_<username>_<projectShort>__
 * Every logical table (e.g. "todos") maps to e.g. "u_demo_a1b2c3__todos".
 */
export function buildTablePrefix(owner: string, projectId: string): string {
  const safeUser = sanitizeIdentPart(owner, 'user', 20);
  const rawProj = projectId.startsWith('proj_') ? projectId.slice(5) : projectId;
  const safeProj = sanitizeIdentPart(rawProj, 'p', 12);
  return `u_${safeUser}_${safeProj}__`;
}

function signTokenPayload(b64: string): string {
  return crypto
    .createHmac('sha256', `${config.sessionSecret}:db-proxy`)
    .update(b64)
    .digest('base64url');
}

export function createDbProxyToken(owner: string, projectId: string): string {
  const scope: DbScope = {
    owner,
    projectId,
    prefix: buildTablePrefix(owner, projectId),
  };
  const b64 = Buffer.from(JSON.stringify(scope), 'utf8').toString('base64url');
  return `${b64}.${signTokenPayload(b64)}`;
}

export function verifyDbProxyToken(token: string | undefined): DbScope | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = signTokenPayload(b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as Partial<DbScope>;
    if (!parsed.owner || !parsed.projectId || !parsed.prefix) return null;
    if (parsed.prefix !== buildTablePrefix(parsed.owner, parsed.projectId)) return null;
    return parsed as DbScope;
  } catch {
    return null;
  }
}

function validateLogicalName(name: string, kind: string): string {
  const cleaned = name.trim().toLowerCase();
  if (!LOGICAL_IDENT_RE.test(cleaned)) {
    throw new Error(
      `非法的${kind} "${name}"：仅允许小写字母开头，由小写字母、数字和下划线组成（最多 48 字符）`,
    );
  }
  if (cleaned.startsWith('sqlite_')) {
    throw new Error(`禁止使用系统保留前缀 sqlite_: ${name}`);
  }
  return cleaned;
}

function stripStringsAndComments(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      out += ' ';
      continue;
    }
    if (!inDouble && ch === "'") {
      if (inSingle && next === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
      out += ' ';
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    out += inSingle ? ' ' : ch;
  }
  return out;
}

function extractCteNames(cleanedSql: string): Set<string> {
  const ctes = new Set<string>();
  const cteRe = /\b(?:WITH(?:\s+RECURSIVE)?|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = cteRe.exec(cleanedSql)) !== null) {
    ctes.add(m[1].toLowerCase());
  }
  return ctes;
}

function resolvePhysicalTable(ident: string, prefix: string): string {
  const raw = ident.trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith('sqlite_')) {
    throw new Error(`权限拒绝：禁止访问系统表 ${raw}`);
  }
  if (lower.startsWith(prefix)) {
    const rest = lower.slice(prefix.length);
    validateLogicalName(rest, '表名');
    return `${prefix}${rest}`;
  }
  if (lower.startsWith('u_') && lower.includes('__')) {
    throw new Error(`权限拒绝：禁止跨租户访问其他用户的表 ${raw}`);
  }
  const logical = validateLogicalName(raw, '表名');
  return `${prefix}${logical}`;
}

/**
 * Rewrites logical table names in SQL into the caller's username-prefixed physical table names
 * and rejects forbidden statements or cross-tenant table references.
 */
export function rewriteAndGuardSql(rawSql: string, prefix: string): string {
  const trimmed = rawSql.trim().replace(/;+\s*$/, '');
  if (!trimmed) {
    throw new Error('SQL 不能为空');
  }

  const stripped = stripStringsAndComments(trimmed);
  if (stripped.includes(';')) {
    throw new Error('安全限制：单次调用仅允许执行一条 SQL 语句');
  }

  const forbidden = /\b(ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|LOAD_EXTENSION|sqlite_master|sqlite_schema|sqlite_temp_master)\b/i;
  const badMatch = stripped.match(forbidden);
  if (badMatch) {
    throw new Error(`安全限制：禁止在 SQL 中使用 ${badMatch[1]}`);
  }

  const ctes = extractCteNames(stripped);

  // Step 1: Replace explicit {{table}} placeholders
  let sql = trimmed.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_all, tbl: string) => {
    const phys = resolvePhysicalTable(tbl, prefix);
    return `"${phys}"`;
  });

  // Step 2: Rewrite standard SQL table targets (FROM / JOIN / INTO / UPDATE / TABLE / ON <tbl> in CREATE INDEX)
  // Protect single-quoted string literals while rewriting outside them
  const segments: Array<{ isStr: boolean; text: string }> = [];
  let cur = '';
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inSingle && sql[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      if (inSingle) {
        cur += ch;
        segments.push({ isStr: true, text: cur });
        cur = '';
        inSingle = false;
      } else {
        if (cur) segments.push({ isStr: false, text: cur });
        cur = ch;
        inSingle = true;
      }
    } else {
      cur += ch;
    }
  }
  if (cur) segments.push({ isStr: inSingle, text: cur });

  const tableClauseRe =
    /\b(FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|REFERENCES)\s+(?:"([^"]+)"|`([^`]+)`|([a-zA-Z_][a-zA-Z0-9_]*))/gi;

  const indexOnRe =
    /\b(CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"[^"]+"|`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*)\s+ON)\s+(?:"([^"]+)"|`([^`]+)`|([a-zA-Z_][a-zA-Z0-9_]*))/gi;

  const rewritten = segments
    .map((seg) => {
      if (seg.isStr) return seg.text;
      let part = seg.text.replace(
        tableClauseRe,
        (match, kw: string, dQuoted?: string, bQuoted?: string, bare?: string) => {
          const ident = dQuoted ?? bQuoted ?? bare ?? '';
          if (!ident) return match;
          // Ignore subqueries or CTEs
          if (ctes.has(ident.toLowerCase())) return match;
          const phys = resolvePhysicalTable(ident, prefix);
          return `${kw} "${phys}"`;
        },
      );
      part = part.replace(
        indexOnRe,
        (match, head: string, dQuoted?: string, bQuoted?: string, bare?: string) => {
          const ident = dQuoted ?? bQuoted ?? bare ?? '';
          if (!ident) return match;
          const phys = resolvePhysicalTable(ident, prefix);
          return `${head} "${phys}"`;
        },
      );
      return part;
    })
    .join('');

  return rewritten;
}

function formatDefaultLiteral(val: string | number | boolean | null): string {
  if (val === null) return 'NULL';
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) throw new Error('非法的数字默认值');
    return String(val);
  }
  if (typeof val === 'boolean') return val ? '1' : '0';
  const upper = val.trim().toUpperCase();
  if (upper === 'CURRENT_TIMESTAMP' || upper === 'CURRENT_DATE' || upper === 'CURRENT_TIME') {
    return upper;
  }
  return `'${val.replace(/'/g, "''")}'`;
}

function normalizeParams(params: unknown): SQLInputValue[] {
  if (!Array.isArray(params)) return [];
  return params.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number' || typeof v === 'string' || v instanceof Uint8Array) return v;
    return JSON.stringify(v);
  });
}

export const dbProxy = {
  createTable(scope: DbScope, input: CreateTableInput): {
    logicalName: string;
    physicalName: string;
    sql: string;
  } {
    const logicalName = validateLogicalName(input.table, '表名');
    const physicalName = `${scope.prefix}${logicalName}`;

    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      throw new Error('columns 必须为非空数组');
    }

    const colDefs: string[] = [];
    for (const col of input.columns) {
      const colName = validateLogicalName(col.name, '列名');
      const colType = String(col.type || 'TEXT').trim().toUpperCase();
      if (!ALLOWED_COL_TYPES.has(colType)) {
        throw new Error(`不支持的列类型 "${col.type}"（允许: ${[...ALLOWED_COL_TYPES].join(', ')}）`);
      }
      const parts = [`"${colName}"`, colType];
      if (col.primaryKey) {
        parts.push('PRIMARY KEY');
        if (col.autoIncrement && (colType === 'INTEGER' || colType === 'INT')) {
          parts.push('AUTOINCREMENT');
        }
      }
      if (col.notNull) parts.push('NOT NULL');
      if (col.unique) parts.push('UNIQUE');
      if (col.default !== undefined) {
        parts.push(`DEFAULT ${formatDefaultLiteral(col.default)}`);
      }
      colDefs.push(parts.join(' '));
    }

    const ifNotExists = input.ifNotExists !== false ? 'IF NOT EXISTS ' : '';
    const createSql = `CREATE TABLE ${ifNotExists}"${physicalName}" (\n  ${colDefs.join(',\n  ')}\n)`;
    appsDb.exec(createSql);

    if (Array.isArray(input.indexes)) {
      for (const idx of input.indexes) {
        if (!Array.isArray(idx.columns) || idx.columns.length === 0) continue;
        const safeCols = idx.columns.map((c) => `"${validateLogicalName(c, '索引列名')}"`);
        const idxSuffix = sanitizeIdentPart(
          idx.name || idx.columns.join('_'),
          'idx',
          30,
        );
        const idxPhysName = `idx_${physicalName}_${idxSuffix}`;
        const uniq = idx.unique ? 'UNIQUE ' : '';
        appsDb.exec(
          `CREATE ${uniq}INDEX IF NOT EXISTS "${idxPhysName}" ON "${physicalName}" (${safeCols.join(', ')})`,
        );
      }
    }

    return { logicalName, physicalName, sql: createSql };
  },

  listTables(scope: DbScope): TableInfoDTO[] {
    const rows = appsDb
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name ASC`,
      )
      .all(`${scope.prefix}%`) as Array<{ name: string; sql: string }>;

    return rows.map((row) => {
      const logicalName = row.name.slice(scope.prefix.length);
      const countRow = appsDb
        .prepare(`SELECT COUNT(*) AS cnt FROM "${row.name}"`)
        .get() as { cnt?: number } | undefined;
      const colRows = appsDb.prepare(`PRAGMA table_info("${row.name}")`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const columns: TableColumnDTO[] = colRows.map((c) => ({
        name: c.name,
        type: c.type,
        notNull: Boolean(c.notnull),
        primaryKey: Boolean(c.pk),
        defaultValue: c.dflt_value,
      }));
      return {
        logicalName,
        physicalName: row.name,
        rowCount: Number(countRow?.cnt || 0),
        columns,
        sql: row.sql || '',
      };
    });
  },

  describeTable(scope: DbScope, table: string): TableInfoDTO {
    const logicalName = validateLogicalName(table, '表名');
    const physicalName = `${scope.prefix}${logicalName}`;
    const info = this.listTables(scope).find((t) => t.physicalName === physicalName);
    if (!info) {
      throw new Error(`表 "${logicalName}" 不存在（实际物理表名: ${physicalName}）`);
    }
    return info;
  },

  previewTableRows(
    scope: DbScope,
    table: string,
    limit = 30,
  ): { logicalName: string; physicalName: string; rows: Record<string, unknown>[] } {
    const logicalName = validateLogicalName(table, '表名');
    const physicalName = `${scope.prefix}${logicalName}`;
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const rows = appsDb
      .prepare(`SELECT * FROM "${physicalName}" LIMIT ?`)
      .all(safeLimit) as Record<string, unknown>[];
    return { logicalName, physicalName, rows };
  },

  dropTable(scope: DbScope, table: string): { logicalName: string; physicalName: string } {
    const logicalName = validateLogicalName(table, '表名');
    const physicalName = `${scope.prefix}${logicalName}`;
    appsDb.exec(`DROP TABLE IF EXISTS "${physicalName}"`);
    return { logicalName, physicalName };
  },

  dropProjectTables(owner: string, projectId: string): number {
    const prefix = buildTablePrefix(owner, projectId);
    const rows = appsDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`)
      .all(`${prefix}%`) as Array<{ name: string }>;
    for (const row of rows) {
      appsDb.exec(`DROP TABLE IF EXISTS "${row.name}"`);
    }
    return rows.length;
  },

  runSql(
    scope: DbScope,
    rawSql: string,
    params: unknown = [],
    mode?: 'query' | 'execute',
  ): {
    rewrittenSql: string;
    rows?: Record<string, unknown>[];
    changes?: number;
    lastInsertRowid?: number | string;
  } {
    const rewrittenSql = rewriteAndGuardSql(rawSql, scope.prefix);
    const bound = normalizeParams(params);
    const stmt = appsDb.prepare(rewrittenSql);

    const upperStart = rewrittenSql.trimStart().toUpperCase();
    const isSelectLike =
      mode === 'query' ||
      (!mode &&
        (upperStart.startsWith('SELECT') ||
          upperStart.startsWith('WITH') ||
          upperStart.includes(' RETURNING ')));

    if (isSelectLike) {
      const rows = stmt.all(...bound) as Record<string, unknown>[];
      return { rewrittenSql, rows };
    }

    const result = stmt.run(...bound);
    return {
      rewrittenSql,
      changes: Number(result.changes),
      lastInsertRowid:
        typeof result.lastInsertRowid === 'bigint'
          ? Number(result.lastInsertRowid)
          : result.lastInsertRowid,
    };
  },
};

function authenticateProxy(req: Request, res: Response): DbScope | null {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const scope = verifyDbProxyToken(token);
  if (!scope) {
    res.status(401).json({ error: 'Invalid or missing Atoms DB Proxy token' });
    return null;
  }
  return scope;
}

export function createDbProxyRouter(): express.Router {
  const router = express.Router();

  router.post('/create-table', (req, res) => {
    const scope = authenticateProxy(req, res);
    if (!scope) return;
    try {
      const result = dbProxy.createTable(scope, req.body as CreateTableInput);
      res.json({ ok: true, prefix: scope.prefix, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/list-tables', (req, res) => {
    const scope = authenticateProxy(req, res);
    if (!scope) return;
    try {
      const tables = dbProxy.listTables(scope);
      res.json({ ok: true, owner: scope.owner, prefix: scope.prefix, tables });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/describe-table', (req, res) => {
    const scope = authenticateProxy(req, res);
    if (!scope) return;
    try {
      const table = String((req.body as { table?: string })?.table || '');
      const info = dbProxy.describeTable(scope, table);
      res.json({ ok: true, prefix: scope.prefix, table: info });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/drop-table', (req, res) => {
    const scope = authenticateProxy(req, res);
    if (!scope) return;
    try {
      const table = String((req.body as { table?: string })?.table || '');
      const result = dbProxy.dropTable(scope, table);
      res.json({ ok: true, prefix: scope.prefix, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/sql', (req, res) => {
    const scope = authenticateProxy(req, res);
    if (!scope) return;
    try {
      const body = (req.body || {}) as {
        sql?: string;
        params?: unknown[];
        mode?: 'query' | 'execute';
      };
      const result = dbProxy.runSql(scope, String(body.sql || ''), body.params || [], body.mode);
      res.json({ ok: true, prefix: scope.prefix, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.startsWith('权限拒绝') || msg.startsWith('安全限制') ? 403 : 400;
      res.status(status).json({ ok: false, error: msg });
    }
  });

  return router;
}
