import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

function parseDemoUsers(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const user = trimmed.slice(0, idx).trim();
    const pass = trimmed.slice(idx + 1).trim();
    if (user && pass) {
      map.set(user, pass);
    }
  }
  return map;
}

const rawDataDir = process.env.DATA_DIR || './data';
const dataDir = path.isAbsolute(rawDataDir)
  ? rawDataDir
  : path.resolve(REPO_ROOT, rawDataDir);

const glmBaseUrl = (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4').replace(/\/+$/, '');
const glmModel = process.env.GLM_MODEL || 'glm-4.7';
const glmChatModel = (process.env.GLM_CHAT_MODEL || '').trim() || glmModel;

const demoUsers = parseDemoUsers(
  process.env.DEMO_USERS || 'demo:atoms2026,alice:atoms2026,bob:atoms2026',
);

const sessionSecret =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'change-me-to-a-long-random-secret-in-production'
    ? process.env.SESSION_SECRET
    : crypto.createHash('sha256').update(`atoms-dev-secret:${REPO_ROOT}`).digest('hex');

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  repoRoot: REPO_ROOT,
  dataDir,
  platformDbPath: path.join(dataDir, 'platform.db'),
  appsDbPath: path.join(dataDir, 'apps_shared.db'),
  workspacesDir: path.join(dataDir, 'workspaces'),
  piConfigDir: path.join(dataDir, 'pi-config'),
  pluginsDir: path.join(REPO_ROOT, 'plugins'),
  templatesDir: path.join(REPO_ROOT, 'templates'),
  templateDir: path.join(REPO_ROOT, 'templates', 'fullstack-app'),
  webDistDir: path.join(REPO_ROOT, 'web', 'dist'),
  internalBaseUrl: `http://127.0.0.1:${Number(process.env.PORT || 3000)}`,

  demoUsers,
  sessionSecret,

  glmApiKey: (process.env.GLM_API_KEY || '').trim(),
  glmBaseUrl,
  glmModel,
  glmChatModel,

  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS || 480_000),
  maxConcurrentAgents: Number(process.env.MAX_CONCURRENT_AGENTS || 2),
  previewPortStart: Number(process.env.PREVIEW_PORT_START || 14_000),
  previewPortEnd: Number(process.env.PREVIEW_PORT_END || 14_200),
  previewIdleTtlMs: Number(process.env.PREVIEW_IDLE_TTL_MS || 1_800_000),
};

export function ensureDataDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  fs.mkdirSync(config.piConfigDir, { recursive: true });
}
