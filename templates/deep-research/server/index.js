import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PORT = Number(process.env.PORT || 4000);

function readFileSafe(relPath, fallback = '') {
  try {
    const abs = path.join(ROOT_DIR, relPath);
    if (!fs.existsSync(abs)) return fallback;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return fallback;
  }
}

function readSourcesSafe() {
  const raw = readFileSafe('sources.json', '[]');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function listSourceNotes() {
  const dir = path.join(ROOT_DIR, 'sources');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith('.') && name.endsWith('.md'))
      .sort()
      .map((name) => ({
        name,
        content: readFileSafe(path.join('sources', name), ''),
      }));
  } catch {
    return [];
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = urlObj.pathname;

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, type: 'deep-research-viewer', time: Date.now() });
    return;
  }

  if (pathname === '/api/research') {
    const reportPath = path.join(ROOT_DIR, 'report.md');
    let updatedAt = Date.now();
    try {
      if (fs.existsSync(reportPath)) {
        updatedAt = Math.round(fs.statSync(reportPath).mtimeMs);
      }
    } catch {
      // ignore
    }

    sendJson(res, 200, {
      report: readFileSafe('report.md', ''),
      plan: readFileSafe('plan.md', ''),
      sources: readSourcesSafe(),
      notes: listSourceNotes(),
      updatedAt,
    });
    return;
  }

  if (pathname === '/api/report.md') {
    const report = readFileSafe('report.md', '# 研究报告尚未生成\n');
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="research-report.md"',
      'Cache-Control': 'no-store',
    });
    res.end(report);
    return;
  }

  // Serve index.html for root or any client path
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(indexFile, 'utf8'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[deep-research-viewer] listening on http://127.0.0.1:${PORT}`);
});
