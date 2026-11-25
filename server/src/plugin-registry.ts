import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentIconType,
  AgentIntentSpec,
  AgentPresetSummary,
  AgentUISpec,
  PluginSummary,
} from '@atoms/shared';
import { config } from './config.js';
import { buildTablePrefix, createDbProxyToken } from './db-proxy.js';

export interface PluginMcpConfig {
  serverName: string;
  entry: string;
  exposure?: 'direct' | 'codemode' | 'deferred' | 'hidden';
  description?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  skillDir?: string;
  mcp?: PluginMcpConfig;
  envNeeds?: string[];
  systemPromptAppend?: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  skillDirAbs: string | null;
  mcpEntryAbs: string | null;
}

export interface PresetManifest {
  id: string;
  aliases?: string[];
  name: string;
  shortName?: string;
  icon?: AgentIconType;
  description: string;
  templateId: string;
  plugins: string[];
  systemPromptFile?: string;
  systemPromptAppend?: string;
  intent?: AgentIntentSpec;
  ui?: Partial<AgentUISpec>;
}

export interface LoadedPreset {
  manifest: PresetManifest;
  dir: string | null;
  templateDirAbs: string;
  plugins: LoadedPlugin[];
  systemPromptText: string | null;
  ui: AgentUISpec;
}

export interface PreparedAgentBundle {
  piAgentDir: string;
  skillDirs: string[];
  systemPromptAppends: string[];
  runtimeEnv: Record<string, string>;
  preset: LoadedPreset;
}

export const DEFAULT_AGENT_ID = 'fullstack-coder';

function normalizeUISpec(manifest: PresetManifest): AgentUISpec {
  const isResearch = manifest.id === 'deep-research' || manifest.icon === 'research';
  return {
    workspaceLabel: manifest.ui?.workspaceLabel || (isResearch ? '研究空间' : '代码仓库'),
    previewTabLabel: manifest.ui?.previewTabLabel || (isResearch ? '研究报告' : '应用预览'),
    tabs: manifest.ui?.tabs?.length
      ? manifest.ui.tabs
      : isResearch
        ? ['preview', 'code', 'logs']
        : ['preview', 'code', 'database', 'logs'],
    starterPrompts: manifest.ui?.starterPrompts || [],
  };
}

class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private presets = new Map<string, LoadedPreset>();
  private aliasToCanonical = new Map<string, string>();
  private loaded = false;

  reload(): void {
    this.plugins.clear();
    this.presets.clear();
    this.aliasToCanonical.clear();

    // 1. Discover atomic plugins under plugins/*/plugin.json
    if (fs.existsSync(config.pluginsDir)) {
      const entries = fs.readdirSync(config.pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(config.pluginsDir, entry.name);
        const manifestPath = path.join(dir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
          const skillDirAbs = manifest.skillDir ? path.resolve(dir, manifest.skillDir) : null;
          const hasSkill = Boolean(skillDirAbs && fs.existsSync(path.join(skillDirAbs, 'SKILL.md')));
          const mcpEntryAbs = manifest.mcp?.entry ? path.resolve(dir, manifest.mcp.entry) : null;
          this.plugins.set(manifest.id, {
            manifest,
            dir,
            skillDirAbs: hasSkill ? skillDirAbs : null,
            mcpEntryAbs: mcpEntryAbs && fs.existsSync(mcpEntryAbs) ? mcpEntryAbs : null,
          });
        } catch (err) {
          console.error(`[plugin-registry] failed loading plugin in ${dir}:`, err);
        }
      }
    }

    // 2. Discover declarative Agent recipes under agents/*/agent.json
    const discovered: Array<{ manifest: PresetManifest; dir: string | null }> = [];
    if (fs.existsSync(config.agentsDir)) {
      const entries = fs.readdirSync(config.agentsDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(config.agentsDir, entry.name);
        const recipePath = path.join(dir, 'agent.json');
        if (!fs.existsSync(recipePath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(recipePath, 'utf8')) as PresetManifest;
          discovered.push({ manifest, dir });
        } catch (err) {
          console.error(`[plugin-registry] failed loading agent recipe in ${dir}:`, err);
        }
      }
    }

    // Fallback to legacy presets/presets.json if agents/ is absent
    if (discovered.length === 0) {
      const presetsFile = path.join(config.repoRoot, 'presets', 'presets.json');
      if (fs.existsSync(presetsFile)) {
        const legacy = JSON.parse(fs.readFileSync(presetsFile, 'utf8')) as PresetManifest[];
        for (const pm of legacy) {
          discovered.push({ manifest: pm, dir: null });
        }
      } else {
        discovered.push({
          manifest: {
            id: DEFAULT_AGENT_ID,
            aliases: ['fullstack-web'],
            name: 'Fullstack Coder Agent',
            shortName: '全栈开发',
            icon: 'code',
            description: '默认全栈建站预设',
            templateId: 'fullstack-app',
            plugins: ['sqlite-storage'],
          },
          dir: null,
        });
      }
    }

    // Ensure fullstack-coder appears first for predictable ordering
    discovered.sort((a, b) => {
      if (a.manifest.id === DEFAULT_AGENT_ID) return -1;
      if (b.manifest.id === DEFAULT_AGENT_ID) return 1;
      return a.manifest.id.localeCompare(b.manifest.id);
    });

    for (const { manifest, dir } of discovered) {
      const templateDirAbs = path.join(config.templatesDir, manifest.templateId);
      const resolvedPlugins = (manifest.plugins || [])
        .map((pid) => this.plugins.get(pid))
        .filter((p): p is LoadedPlugin => Boolean(p));

      let systemPromptText: string | null = null;
      if (dir && manifest.systemPromptFile) {
        const promptPath = path.resolve(dir, manifest.systemPromptFile);
        if (fs.existsSync(promptPath)) {
          systemPromptText = fs.readFileSync(promptPath, 'utf8').trim();
        }
      }
      if (manifest.systemPromptAppend) {
        systemPromptText = [systemPromptText, manifest.systemPromptAppend].filter(Boolean).join('\n\n');
      }

      const loadedPreset: LoadedPreset = {
        manifest,
        dir,
        templateDirAbs,
        plugins: resolvedPlugins,
        systemPromptText,
        ui: normalizeUISpec(manifest),
      };

      this.presets.set(manifest.id, loadedPreset);
      this.aliasToCanonical.set(manifest.id, manifest.id);
      for (const alias of manifest.aliases || []) {
        this.aliasToCanonical.set(alias, manifest.id);
      }
    }

    this.loaded = true;
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.reload();
  }

  canonicalAgentId(presetId?: string | null): string {
    this.ensureLoaded();
    if (!presetId) return DEFAULT_AGENT_ID;
    return this.aliasToCanonical.get(presetId) || DEFAULT_AGENT_ID;
  }

  hasAgent(presetId?: string | null): boolean {
    this.ensureLoaded();
    if (!presetId) return false;
    return this.aliasToCanonical.has(presetId);
  }

  getPreset(presetId?: string): LoadedPreset {
    this.ensureLoaded();
    const canonical = this.canonicalAgentId(presetId);
    const found = this.presets.get(canonical) || this.presets.get(DEFAULT_AGENT_ID);
    if (!found) {
      throw new Error(`Agent recipe not found: ${presetId || DEFAULT_AGENT_ID}`);
    }
    return found;
  }

  getLoadedPresets(): LoadedPreset[] {
    this.ensureLoaded();
    return [...this.presets.values()];
  }

  listPlugins(): PluginSummary[] {
    this.ensureLoaded();
    return [...this.plugins.values()].map((p) => this.toPluginSummary(p));
  }

  listPresets(): AgentPresetSummary[] {
    this.ensureLoaded();
    return [...this.presets.values()].map((preset) => ({
      id: preset.manifest.id,
      aliases: preset.manifest.aliases || [],
      name: preset.manifest.name,
      shortName: preset.manifest.shortName || preset.manifest.name,
      icon: preset.manifest.icon || (preset.manifest.id === 'deep-research' ? 'research' : 'code'),
      description: preset.manifest.description,
      templateId: preset.manifest.templateId,
      plugins: preset.plugins.map((p) => this.toPluginSummary(p)),
      intent: preset.manifest.intent,
      ui: preset.ui,
    }));
  }

  private toPluginSummary(p: LoadedPlugin): PluginSummary {
    return {
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      hasSkill: Boolean(p.skillDirAbs),
      mcpServerName: p.mcpEntryAbs ? p.manifest.mcp?.serverName : undefined,
    };
  }

  /**
   * Computes scoped runtime environment variables for a workspace's enabled plugins.
   * Injected into BOTH Pi's MCP servers and the generated app's runtime process.
   */
  buildProjectRuntimeEnv(owner: string, workspaceId: string, presetId?: string): Record<string, string> {
    const preset = this.getPreset(presetId);
    const env: Record<string, string> = {};

    const hasSqliteStorage = preset.plugins.some((p) => p.manifest.id === 'sqlite-storage');
    if (hasSqliteStorage) {
      env.ATOMS_DB_PROXY_URL = `${config.internalBaseUrl}/api/db-proxy`;
      env.ATOMS_DB_TOKEN = createDbProxyToken(owner, workspaceId);
      env.ATOMS_DB_PREFIX = buildTablePrefix(owner, workspaceId);
    }

    const hasDeepResearch = preset.plugins.some((p) => p.manifest.id === 'deep-research');
    if (hasDeepResearch) {
      if (config.tavilyApiKey) env.TAVILY_API_KEY = config.tavilyApiKey;
      if (config.firecrawlApiKey) env.FIRECRAWL_API_KEY = config.firecrawlApiKey;
    }

    return env;
  }

  /**
   * Materializes a per-workspace isolated PI_CODING_AGENT_DIR containing:
   * - models.json (GLM provider)
   * - mcp.json (all MCP servers declared by the recipe's plugins, with scoped env)
   * and returns the plugin skill directories and system prompt additions.
   */
  prepareProjectAgentBundle(params: {
    owner: string;
    projectId: string;
    workspaceDir: string;
    presetId?: string;
  }): PreparedAgentBundle {
    const preset = this.getPreset(params.presetId);
    const runtimeEnv = this.buildProjectRuntimeEnv(params.owner, params.projectId, preset.manifest.id);

    const piAgentDir = path.join(params.workspaceDir, '.pi-agent');
    fs.mkdirSync(piAgentDir, { recursive: true });

    // 1. Write models.json for GLM
    const isGlm5Series = /^glm-5/i.test(config.glmModel);
    const isMultimodal = /flash|v/i.test(config.glmModel);
    const modelsConfig = {
      providers: {
        glm: {
          name: 'Zhipu GLM',
          baseUrl: config.glmBaseUrl,
          api: 'openai-completions',
          apiKey: '$GLM_API_KEY',
          authHeader: true,
          models: [
            {
              id: config.glmModel,
              name: config.glmModel,
              reasoning: true,
              input: isMultimodal ? ['text', 'image'] : ['text'],
              contextWindow: isGlm5Series ? 1_000_000 : 204_800,
              maxTokens: isGlm5Series ? 65_536 : 16_384,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: {
                supportsStore: false,
                supportsReasoningEffort: false,
                maxTokensField: 'max_tokens',
                thinkingFormat: 'zai',
                zaiToolStream: true,
              },
            },
          ],
        },
      },
    };
    fs.writeFileSync(path.join(piAgentDir, 'models.json'), JSON.stringify(modelsConfig, null, 2), 'utf8');

    // 2. Write mcp.json from enabled plugins
    const mcpServers: Record<string, unknown> = {};
    const skillDirs: string[] = [];
    const systemPromptAppends: string[] = [];

    if (preset.systemPromptText) {
      systemPromptAppends.push(preset.systemPromptText);
    }

    for (const plugin of preset.plugins) {
      if (plugin.skillDirAbs) {
        skillDirs.push(plugin.skillDirAbs);
      }
      if (plugin.manifest.systemPromptAppend) {
        systemPromptAppends.push(plugin.manifest.systemPromptAppend);
      }
      if (plugin.mcpEntryAbs && plugin.manifest.mcp) {
        const pluginEnv: Record<string, string> = {};
        for (const key of plugin.manifest.envNeeds || []) {
          if (runtimeEnv[key] !== undefined) {
            pluginEnv[key] = runtimeEnv[key];
          }
        }
        mcpServers[plugin.manifest.mcp.serverName] = {
          command: process.execPath,
          args: [plugin.mcpEntryAbs],
          env: pluginEnv,
          exposure: plugin.manifest.mcp.exposure || 'direct',
          description: plugin.manifest.mcp.description || plugin.manifest.description,
        };
      }
    }

    fs.writeFileSync(
      path.join(piAgentDir, 'mcp.json'),
      JSON.stringify({ mcpServers }, null, 2),
      'utf8',
    );

    return {
      piAgentDir,
      skillDirs,
      systemPromptAppends,
      runtimeEnv,
      preset,
    };
  }
}

export const pluginRegistry = new PluginRegistry();
