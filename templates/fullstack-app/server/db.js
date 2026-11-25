/**
 * Atoms DB Proxy Runtime Client
 * Talks to the platform's user-prefixed SQLite proxy so this app gets isolated persistence
 * without touching raw database files directly.
 */

const PROXY_URL = (process.env.ATOMS_DB_PROXY_URL || '').replace(/\/+$/, '');
const PROXY_TOKEN = (process.env.ATOMS_DB_TOKEN || '').trim();
const TABLE_PREFIX = (process.env.ATOMS_DB_PREFIX || '').trim();

async function callProxy(endpoint, payload) {
  if (!PROXY_URL || !PROXY_TOKEN) {
    throw new Error('Missing ATOMS_DB_PROXY_URL or ATOMS_DB_TOKEN environment variables');
  }
  const resp = await fetch(`${PROXY_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PROXY_TOKEN}`,
    },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
  if (!resp.ok || data.ok === false) {
    throw new Error(data.error || `DB Proxy request failed (HTTP ${resp.status})`);
  }
  return data;
}

export const db = {
  prefix: TABLE_PREFIX,

  createTable(spec) {
    return callProxy('/create-table', spec);
  },

  async listTables() {
    const res = await callProxy('/list-tables', {});
    return res.tables || [];
  },

  async describeTable(table) {
    const res = await callProxy('/describe-table', { table });
    return res.table;
  },

  dropTable(table) {
    return callProxy('/drop-table', { table });
  },

  async query(sql, params = []) {
    const res = await callProxy('/sql', { sql, params, mode: 'query' });
    return res.rows || [];
  },

  async get(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] ?? null;
  },

  async execute(sql, params = []) {
    const res = await callProxy('/sql', { sql, params, mode: 'execute' });
    return {
      changes: res.changes ?? 0,
      lastInsertRowid: res.lastInsertRowid ?? null,
    };
  },
};
