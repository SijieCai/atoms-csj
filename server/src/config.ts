import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');

export type AppEnv = 'development' | 'production';

function resolveAppEnv(): AppEnv {
  const raw = (process.env.APP_ENV || process.env.NODE_ENV || 'development').trim().toLowerCase();
  return raw === 'production' || raw === 'prod' ? 'production' : 'development';
}

const appEnv = resolveAppEnv();

// Layered env loading (highest precedence first; existing process.env keys are never overwritten):
//   1. Process environment (CLI / systemd)
//   2. .env.<appEnv>.local (machine-specific private overrides, gitignored)
//   3. .env.<appEnv>       (checked-in env defaults: .env.development / .env.production)
//   4. .env.local          (shared private overrides, gitignored)
//   5. .env                (shared secrets & fallback config, gitignored, synced on deploy)
const envFilesToLoad = [
  `.env.${appEnv}.local`,
  `.env.${appEnv}`,
  '.env.local',
  '.env',
];

const loadedEnvFiles: string[] = [];
for (const filename of envFilesToLoad) {
  const fullPath = path.join(REPO_ROOT, filename);
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override: false });
    loadedEnvFiles.push(filename);
  }
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const norm = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(norm)) return true;
  if (['0', 'false', 'no', 'off'].includes(norm)) return false;
  return fallback;
}

function parseTrustProxy(raw: string | undefined, isProd: boolean): number | boolean {
  if (raw === undefined || raw.trim() === '') return isProd ? 1 : false;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'false' || trimmed === '0' || trimmed === 'off') return false;
  if (trimmed === 'true' || trimmed === 'on') return true;
  const num = Number(trimmed);
  return Number.isFinite(num) && num > 0 ? num : isProd ? 1 : false;
}

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

const isProd = appEnv === 'production';
const port = Number(process.env.PORT || 3000);

const publicDomain = (
  process.env.PUBLIC_DOMAIN || (isProd ? 'atoms.maplink.site' : `localhost:${port}`)
).trim();

const publicUrl = (
  process.env.PUBLIC_URL ||
  (isProd ? `https://${publicDomain}` : `http://${publicDomain}`)
)
  .trim()
  .replace(/\/+$/, '');

const cookieSecure = parseBooleanEnv(
  process.env.COOKIE_SECURE,
  isProd && publicUrl.startsWith('https://'),
);
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY, isProd);

const rawDataDir = process.env.DATA_DIR || './data';
const dataDir = path.isAbsolute(rawDataDir)
  ? rawDataDir
  : path.resolve(REPO_ROOT, rawDataDir);

const glmBaseUrl = (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const glmModel = process.env.GLM_MODEL || 'glm-5.3-flash';
const glmChatModel = (process.env.GLM_CHAT_MODEL || '').trim() || glmModel;

const demoUsers = parseDemoUsers(
  process.env.DEMO_USERS || 'demo:atoms2026,alice:atoms2026,bob:atoms2026',
);

const sessionSecret =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'change-me-to-a-long-random-secret-in-production'
    ? process.env.SESSION_SECRET
    : crypto.createHash('sha256').update(`atoms-${appEnv}-secret:${REPO_ROOT}`).digest('hex');

function parseOptionalPositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function defaultModelPricingCnyPerM(model: string): { input: number; output: number; cacheRead: number } {
  const lower = model.toLowerCase();
  if (lower.includes('flash')) {
    // GLM Flash series (approx CNY per 1M tokens; override via GLM_*_PRICE_PER_M)
    return { input: 0.5, output: 2.0, cacheRead: 0.1 };
  }
  if (lower.includes('air')) {
    return { input: 1.0, output: 4.0, cacheRead: 0.2 };
  }
  // GLM flagship series (e.g. glm-5 / glm-4.7)
  return { input: 4.0, output: 16.0, cacheRead: 1.0 };
}

const defaultPricing = defaultModelPricingCnyPerM(glmModel);

export const config = {
  port,
  appEnv,
  nodeEnv: isProd ? 'production' : 'development',
  isProd,
  loadedEnvFiles,
  publicDomain,
  publicUrl,
  cookieSecure,
  trustProxy,

  repoRoot: REPO_ROOT,
  dataDir,
  platformDbPath: path.join(dataDir, 'platform.db'),
  appsDbPath: path.join(dataDir, 'apps_shared.db'),
  workspacesDir: path.join(dataDir, 'workspaces'),
  piConfigDir: path.join(dataDir, 'pi-config'),
  pluginsDir: path.join(REPO_ROOT, 'plugins'),
  agentsDir: path.join(REPO_ROOT, 'agents'),
  templatesDir: path.join(REPO_ROOT, 'templates'),
  templateDir: path.join(REPO_ROOT, 'templates', 'fullstack-app'),
  webDistDir: path.join(REPO_ROOT, 'web', 'dist'),
  internalBaseUrl: `http://127.0.0.1:${port}`,

  demoUsers,
  sessionSecret,

  glmApiKey: (process.env.GLM_API_KEY || '').trim(),
  glmBaseUrl,
  glmModel,
  glmChatModel,
  glmInputPricePerM: Number(process.env.GLM_INPUT_PRICE_PER_M || defaultPricing.input),
  glmOutputPricePerM: Number(process.env.GLM_OUTPUT_PRICE_PER_M || defaultPricing.output),
  glmCacheReadPricePerM: Number(process.env.GLM_CACHE_READ_PRICE_PER_M || defaultPricing.cacheRead),

  tavilyApiKey: (process.env.TAVILY_API_KEY || '').trim(),
  firecrawlApiKey: (process.env.FIRECRAWL_API_KEY || '').trim(),

  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS || 1_800_000),
  agentIdleTimeoutMs: Number(process.env.AGENT_IDLE_TIMEOUT_MS || 300_000),
  agentBudgetMaxDurationMs: parseOptionalPositiveNumber(process.env.AGENT_BUDGET_MAX_DURATION_MS),
  agentBudgetMaxCostCny: parseOptionalPositiveNumber(process.env.AGENT_BUDGET_MAX_COST_CNY),
  agentBudgetMaxTokens: parseOptionalPositiveNumber(process.env.AGENT_BUDGET_MAX_TOKENS),
  agentBudgetMaxToolCalls: parseOptionalPositiveNumber(process.env.AGENT_BUDGET_MAX_TOOL_CALLS),
  agentBudgetSoftRatio: parseOptionalPositiveNumber(process.env.AGENT_BUDGET_SOFT_RATIO),
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
