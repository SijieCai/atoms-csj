import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req, res) => {
  try {
    const tables = await db.listTables();
    res.json({
      ok: true,
      db: 'atoms-sqlite-proxy',
      prefix: db.prefix,
      tableCount: tables.length,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      db: 'atoms-sqlite-proxy',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const port = Number(process.env.PORT || 4000);
app.listen(port, '127.0.0.1', () => {
  console.log(`[app] listening on http://127.0.0.1:${port} (db prefix: ${db.prefix || 'none'})`);
});
