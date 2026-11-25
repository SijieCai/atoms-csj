import fs from 'node:fs';
import path from 'node:path';
import type { AgentPresetSummary, PluginSummary } from '@atoms/shared';
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
  name: string;
  description: string;
  templateId: string;
  plugins: string[];
  systemPromptAppend?: string;
}

export interface LoadedPreset {
  manifest: PresetManifest;
  templateDirAbs: string;
  plugins: LoadedPlugin[];
}

export interface PreparedAgentBundle {
  piAgentDir: string;
  skillDirs: string[];
  systemPromptAppends: string[];
  runtimeEnv: Record<string, string>;
  preset: LoadedPreset;
}

const DEFAULT_PRESET_ID = 'fullstack-web';

class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private presets = new Map<string, LoadedPreset>();
  private loaded = false;

  reload(): void {
    this.plugins.clear();
    this.presets.clear();

    // 1. Discover plugins under plugins/*/plugin.json
    if (fs.existsSync(config.pluginsDir)) {
      const entries = fs.readdirSync(config.pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(config.pluginsDir, entry.name);
        const manifestPath = path.join(dir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
          const skillDirAbs = manifest.skillDir
            ? path.resolve(dir, manifest.skillDir)
            : null;
          const hasSkill = Boolean(skillDirAbs && fs.existsSync(path.join(skillDirAbs, 'SKILL.md')));
          const mcpEntryAbs = manifest.mcp?.entry
            ? path.resolve(dir, manifest.mcp.entry)
            : null;
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

    // 2. Load domain agent presets from presets/presets.json
    const presetsFile = path.join(config.repoRoot, 'presets', 'presets.json');
    let presetManifests: PresetManifest[] = [];
    if (fs.existsSync(presetsFile)) {
      presetManifests = JSON.parse(fs.readFileSync(presetsFile, 'utf8')) as PresetManifest[];
    } else {
      presetManifests = [
        {
          id: DEFAULT_PRESET_ID,
          name: '全栈网站 Agent',
          description: '默认全栈建站预设',
          templateId: 'fullstack-app',
          plugins: ['sqlite-storage'],
        },
      ];
    }

    for (const pm of presetManifests) {
      const templateDirAbs = path.join(config.templatesDir, pm.templateId);
      const resolvedPlugins = pm.plugins
        .map((pid) => this.plugins.get(pid))
        .filter((p): p is LoadedPlugin => Boolean(p));
      this.presets.set(pm.id, {
        manifest: pm,
        templateDirAbs,
        plugins: resolvedPlugins,
      });
    }

    this.loaded = true;
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.reload();
  }

  getPreset(presetId?: string): LoadedPreset {
    this.ensureLoaded();
    const id = presetId || DEFAULT_PRESET_ID;
    const found = this.presets.get(id) || this.presets.get(DEFAULT_PRESET_ID);
    if (!found) {
      throw new Error(`Agent preset not found: ${id}`);
    }
    return found;
  }

  listPlugins(): PluginSummary[] {
    this.ensureLoaded();
    return [...this.plugins.values()].map((p) => this.toPluginSummary(p));
  }

  listPresets(): AgentPresetSummary[] {
    this.ensureLoaded();
    return [...this.presets.values()].map((preset) => ({
      id: preset.manifest.id,
      name: preset.manifest.name,
      description: preset.manifest.description,
      templateId: preset.manifest.templateId,
      plugins: preset.plugins.map((p) => this.toPluginSummary(p)),
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
   * Computes scoped runtime environment variables for a project's enabled plugins.
   * Injected into BOTH Pi's MCP servers and the generated app's runtime process.
   */
  buildProjectRuntimeEnv(owner: string, projectId: string, presetId?: string): Record<string, string> {
    const preset = this.getPreset(presetId);
    const env: Record<string, string> = {};

    const hasSqliteStorage = preset.plugins.some((p) => p.manifest.id === 'sqlite-storage');
    if (hasSqliteStorage) {
      env.ATOMS_DB_PROXY_URL = `${config.internalBaseUrl}/api/db-proxy`;
      env.ATOMS_DB_TOKEN = createDbProxyToken(owner, projectId);
      env.ATOMS_DB_PREFIX = buildTablePrefix(owner, projectId);
    }

    return env;
  }

  /**
   * Materializes a per-project isolated PI_CODING_AGENT_DIR containing:
   * - models.json (GLM provider)
   * - mcp.json (all MCP servers declared by the preset's plugins, with scoped env)
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
              input: ['text'],
              contextWindow: 204800,
              maxTokens: 16384,
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

    if (preset.manifest.systemPromptAppend) {
      systemPromptAppends.push(preset.manifest.systemPromptAppend);
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
