#!/usr/bin/env node
/**
 * Atoms SQLite Storage Plugin — Stdio MCP Server (Zero external dependencies)
 * Connects Pi Coding Agent directly to the platform's user-prefixed DB Proxy API.
 */

const PROXY_URL = (process.env.ATOMS_DB_PROXY_URL || '').replace(/\/+$/, '');
const PROXY_TOKEN = (process.env.ATOMS_DB_TOKEN || '').trim();
const TABLE_PREFIX = (process.env.ATOMS_DB_PREFIX || '').trim();

const TOOLS = [
  {
    name: 'create_table',
    description:
      'Create a SQLite table in the current user-isolated namespace (logical table name is automatically prefixed with username + project).',
    inputSchema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'Logical table name (lowercase letters, digits, underscores, e.g. "todos").',
        },
        columns: {
          type: 'array',
          description: 'Column definitions',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: {
                type: 'string',
                description: 'SQLite type: INTEGER, TEXT, REAL, BLOB, NUMERIC, BOOLEAN, DATETIME',
              },
              primaryKey: { type: 'boolean' },
              autoIncrement: { type: 'boolean' },
              notNull: { type: 'boolean' },
              unique: { type: 'boolean' },
              default: { description: 'Default literal value or CURRENT_TIMESTAMP' },
            },
            required: ['name', 'type'],
          },
        },
        indexes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' } },
              unique: { type: 'boolean' },
            },
            required: ['columns'],
          },
        },
        ifNotExists: { type: 'boolean', default: true },
      },
      required: ['table', 'columns'],
    },
  },
  {
    name: 'list_tables',
    description:
      'List all tables belonging to this user and project (returns logicalName, user-prefixed physicalName, columns, and rowCount).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'describe_table',
    description: 'Inspect schema columns and SQL definition of a logical table in this namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Logical table name' },
      },
      required: ['table'],
    },
  },
  {
    name: 'query_sql',
    description:
      'Run a read-only SELECT SQL query against tables in this namespace. Use logical table names (proxy rewrites to user-prefixed tables) and ? parameter placeholders.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Single SELECT SQL statement using logical table names' },
        params: { type: 'array', description: 'Positional ? bind parameters', items: {} },
      },
      required: ['sql'],
    },
  },
  {
    name: 'execute_sql',
    description:
      'Run a write SQL statement (INSERT, UPDATE, DELETE) against tables in this namespace. Use logical table names and ? parameter placeholders.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Single INSERT/UPDATE/DELETE SQL statement' },
        params: { type: 'array', description: 'Positional ? bind parameters', items: {} },
      },
      required: ['sql'],
    },
  },
  {
    name: 'drop_table',
    description: 'Drop a table belonging to this user and project namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Logical table name to drop' },
      },
      required: ['table'],
    },
  },
];

async function callProxy(endpoint, payload) {
  if (!PROXY_URL || !PROXY_TOKEN) {
    throw new Error('ATOMS_DB_PROXY_URL or ATOMS_DB_TOKEN is not configured in MCP environment');
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

async function handleToolCall(name, args) {
  switch (name) {
    case 'create_table':
      return callProxy('/create-table', args);
    case 'list_tables':
      return callProxy('/list-tables', {});
    case 'describe_table':
      return callProxy('/describe-table', { table: args?.table });
    case 'drop_table':
      return callProxy('/drop-table', { table: args?.table });
    case 'query_sql':
      return callProxy('/sql', { sql: args?.sql, params: args?.params || [], mode: 'query' });
    case 'execute_sql':
      return callProxy('/sql', { sql: args?.sql, params: args?.params || [], mode: 'execute' });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendJson(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications have no id and require no response
  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      const protocolVersion = params?.protocolVersion || '2024-11-05';
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'atoms-sqlite-storage-mcp',
            version: '1.0.0',
          },
          instructions: `Atoms DB Proxy MCP server (table prefix: ${TABLE_PREFIX || 'auto'}). Use logical table names like "todos"; the proxy automatically applies the user prefix.`,
        },
      });
      return;
    }

    if (method === 'ping') {
      sendJson({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendJson({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const data = await handleToolCall(toolName, toolArgs);
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            isError: false,
          },
        });
      } catch (err) {
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          },
        });
      }
      return;
    }

    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, '').trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      void handleMessage(parsed);
    } catch {
      // ignore malformed input
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
