import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentToolStep, MessageDTO, MessageMetadata } from '@atoms/shared';
import { config, ensureDataDirs } from './config.js';
import { dbStore, generateId, toProjectDTO } from './db.js';
import { eventBus } from './event-bus.js';
import { pluginRegistry } from './plugin-registry.js';

function resolvePiCliPath(): string {
  const candidates = [
    path.join(config.repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent'),
    path.join(config.repoRoot, 'server', 'node_modules', '@earendil-works', 'pi-coding-agent'),
  ];
  for (const pkgDir of candidates) {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi || 'dist/bundle/cli.js';
      const resolved = path.resolve(pkgDir, relBin);
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  const binFallback = path.join(config.repoRoot, 'node_modules', '.bin', 'pi');
  if (fs.existsSync(binFallback)) return binFallback;
  throw new Error('无法找到 @earendil-works/pi-coding-agent，请先运行 npm install');
}

export function ensurePiConfigFile(): void {
  ensureDataDirs();
  const modelsJsonPath = path.join(config.piConfigDir, 'models.json');
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
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
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
  fs.writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig, null, 2), 'utf8');
}

function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  if (typeof obj.command === 'string') return obj.command.slice(0, 120);
  if (typeof obj.path === 'string') return obj.path;
  if (typeof obj.file_path === 'string') return obj.file_path;
  if (typeof obj.pattern === 'string') return obj.pattern;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  return `${toolName}(${keys.slice(0, 3).join(', ')})`;
}

function extractTextFromToolResult(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 1200);
  if (!result || typeof result !== 'object') return '';
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
          return (item as Record<string, unknown>).text as string;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 1200);
  }
  if (typeof obj.output === 'string') return obj.output.slice(0, 1200);
  return JSON.stringify(obj).slice(0, 800);
}

interface ActiveRun {
  projectId: string;
  runId: string;
  messageId: string;
  child: ChildProcessWithoutNullStreams;
  assistantText: string;
  thinkingText: string;
  steps: AgentToolStep[];
  stepIndexById: Map<string, number>;
  aborted: boolean;
  settled: boolean;
  stderrBuf: string;
  timeoutTimer: NodeJS.Timeout;
  reqSeq: number;
  onSettled: (projectId: string, ok: boolean) => Promise<string | null>;
}

class PiAgentManager {
  private activeRuns = new Map<string, ActiveRun>();
  private piCliPath: string | null = null;

  private getPiCliPath(): string {
    if (!this.piCliPath) {
      this.piCliPath = resolvePiCliPath();
    }
    return this.piCliPath;
  }

  isRunning(projectId: string): boolean {
    return this.activeRuns.has(projectId);
  }

  getActiveCount(): number {
    return this.activeRuns.size;
  }

  async startOrSteer(params: {
    owner: string;
    projectId: string;
    presetId?: string;
    workspaceDir: string;
    userMessage: string;
    history: MessageDTO[];
    isInitialBuild: boolean;
    onSettled: (projectId: string, ok: boolean) => Promise<string | null>;
  }): Promise<{ mode: 'started' | 'steered'; runId: string; messageId: string }> {
    const existing = this.activeRuns.get(params.projectId);
    if (existing && !existing.settled) {
      const cmdId = `steer-${++existing.reqSeq}`;
      this.writeRpc(existing.child, {
        id: cmdId,
        type: 'steer',
        message: params.userMessage,
      });
      eventBus.emit(params.projectId, {
        type: 'agent_status',
        messageId: existing.messageId,
        statusText: '已收到你的补充指令，将在当前步骤完成后立即调整执行方向...',
      });
      return { mode: 'steered', runId: existing.runId, messageId: existing.messageId };
    }

    if (!config.glmApiKey) {
      throw new Error('服务端未配置 GLM_API_KEY，无法启动 Coding Agent。请在 .env 中配置后重试。');
    }

    if (this.activeRuns.size >= config.maxConcurrentAgents) {
      throw new Error(`当前同时构建的项目数已达上限（${config.maxConcurrentAgents}），请稍候再试。`);
    }

    const bundle = pluginRegistry.prepareProjectAgentBundle({
      owner: params.owner,
      projectId: params.projectId,
      workspaceDir: params.workspaceDir,
      presetId: params.presetId,
    });
    const sessionDir = path.join(params.workspaceDir, '.pi-sessions');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Write conversation context file so Pi has full requirement context
    const contextMd = [
      '# Project Conversation Context',
      '',
      `- Preset: ${bundle.preset.manifest.id} (${bundle.preset.manifest.name})`,
      `- Loaded Plugins: ${bundle.preset.plugins.map((p) => p.manifest.id).join(', ') || 'none'}`,
      bundle.runtimeEnv.ATOMS_DB_PREFIX
        ? `- Isolated DB Table Prefix: \`${bundle.runtimeEnv.ATOMS_DB_PREFIX}\` (always use logical table names; proxy prefixes automatically)`
        : '',
      '',
      ...params.history.slice(-20).map((m) => `## ${m.role.toUpperCase()}\n${m.content}\n`),
      `## LATEST REQUEST\n${params.userMessage}\n`,
    ].join('\n');
    fs.writeFileSync(path.join(params.workspaceDir, 'PROJECT_CONTEXT.md'), contextMd, 'utf8');

    const runId = dbStore.createAgentRun(params.projectId, params.userMessage);
    const messageId = generateId('msg');
    dbStore.addMessage(
      params.projectId,
      'assistant',
      '',
      { mode: 'build', steps: [], thinking: '' },
      messageId,
    );

    const updatedProj = dbStore.updateProject(params.projectId, {
      status: 'building',
      hasWorkspace: true,
    });
    if (updatedProj) {
      eventBus.emit(params.projectId, {
        type: 'project_updated',
        project: toProjectDTO(updatedProj, false),
      });
    }

    eventBus.emit(params.projectId, {
      type: 'agent_start',
      runId,
      messageId,
    });

    const sanitizedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG || 'en_US.UTF-8',
      NODE_ENV: 'development',
      PI_CODING_AGENT_DIR: bundle.piAgentDir,
      GLM_API_KEY: config.glmApiKey,
      ...bundle.runtimeEnv,
    };

    const piArgs = [
      this.getPiCliPath(),
      '--mode',
      'rpc',
      '--provider',
      'glm',
      '--model',
      config.glmModel,
      '--thinking',
      'high',
      '--session-dir',
      sessionDir,
    ];

    for (const skillDir of bundle.skillDirs) {
      piArgs.push('--skill', skillDir);
    }
    for (const promptAppend of bundle.systemPromptAppends) {
      piArgs.push('--append-system-prompt', promptAppend);
    }

    const child = spawn(process.execPath, piArgs, {
      cwd: params.workspaceDir,
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const run: ActiveRun = {
      projectId: params.projectId,
      runId,
      messageId,
      child,
      assistantText: '',
      thinkingText: '',
      steps: [],
      stepIndexById: new Map(),
      aborted: false,
      settled: false,
      stderrBuf: '',
      reqSeq: 0,
      onSettled: params.onSettled,
      timeoutTimer: setTimeout(() => {
        if (!run.settled) {
          run.aborted = true;
          eventBus.emit(params.projectId, {
            type: 'agent_status',
            messageId,
            statusText: '构建超过最大耗时限制，正在终止任务...',
          });
          this.writeRpc(child, { id: `abort-timeout`, type: 'abort' });
          setTimeout(() => {
            if (!run.settled) child.kill('SIGKILL');
          }, 4000).unref();
        }
      }, config.agentTimeoutMs),
    };

    this.activeRuns.set(params.projectId, run);
    this.attachSubprocessHandlers(run);

    const agentPrompt = params.isInitialBuild
      ? `请先阅读工作区里的 AGENTS.md、PROJECT_CONTEXT.md 以及已加载的 atoms-sqlite-storage Skill 指南，然后根据用户需求完成这个全栈网站的开发（前端 React+Tailwind 写在 client/，后端 Express 接口写在 server/index.js 并使用 ./db.js 代理客户端读写数据；同时优先调用 atoms_db MCP 工具完成建表和写入示例数据）。\n\n用户最新需求：\n${params.userMessage}\n\n完成后请务必执行 npm run build 确保前端编译通过，并检查 server/index.js 无语法错误，最后用简洁中文汇报你实现的功能、创建的数据表和交互亮点。不要在后台遗留运行中的服务器进程。`
      : `请根据用户的最新修改需求，在当前工作区（遵守 AGENTS.md 与 atoms-sqlite-storage Skill 规范，保持相对路径 ./api/... 并使用 atoms_db MCP / ./db.js 代理操作数据）进行增量修改，完成后执行 npm run build 验证无报错并汇报改动内容。\n\n用户需求：\n${params.userMessage}`;

    this.writeRpc(child, {
      id: `prompt-${++run.reqSeq}`,
      type: 'prompt',
      message: agentPrompt,
    });

    return { mode: 'started', runId, messageId };
  }

  abort(projectId: string): boolean {
    const run = this.activeRuns.get(projectId);
    if (!run || run.settled) return false;
    run.aborted = true;
    eventBus.emit(projectId, {
      type: 'agent_status',
      messageId: run.messageId,
      statusText: '正在停止当前构建任务...',
    });
    this.writeRpc(run.child, { id: `abort-${++run.reqSeq}`, type: 'abort' });
    setTimeout(() => {
      if (!run.settled) {
        try {
          run.child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }, 4000).unref();
    return true;
  }

  shutdownAll(): void {
    for (const run of this.activeRuns.values()) {
      clearTimeout(run.timeoutTimer);
      try {
        run.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.activeRuns.clear();
  }

  private writeRpc(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private attachSubprocessHandlers(run: ActiveRun): void {
    // Strict LF-only JSONL framing (do NOT use Node readline, which splits on U+2028/U+2029)
    let stdoutBuf = '';
    run.child.stdout.setEncoding('utf8');
    run.child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          this.handleRpcRecord(run, record);
        } catch {
          // ignore non-JSON diagnostic output
        }
      }
    });

    run.child.stderr.setEncoding('utf8');
    run.child.stderr.on('data', (chunk: string) => {
      run.stderrBuf = (run.stderrBuf + chunk).slice(-4000);
    });

    run.child.on('error', (err) => {
      void this.finalizeRun(run, 'failed', `启动 Pi 子进程失败: ${err.message}`);
    });

    run.child.on('close', (code) => {
      if (!run.settled) {
        const status = run.aborted ? 'aborted' : code === 0 ? 'succeeded' : 'failed';
        const errMsg =
          status === 'failed'
            ? `Coding Agent 异常退出 (code=${code})${run.stderrBuf ? `: ${run.stderrBuf.slice(-400)}` : ''}`
            : undefined;
        void this.finalizeRun(run, status, errMsg);
      }
    });
  }

  private handleRpcRecord(run: ActiveRun, record: Record<string, unknown>): void {
    const type = String(record.type || '');

    if (type === 'response') {
      if (record.success === false) {
        const err = String(record.error || 'Agent command failed');
        if (record.command === 'prompt') {
          void this.finalizeRun(run, 'failed', err);
        } else {
          eventBus.emit(run.projectId, {
            type: 'agent_status',
            messageId: run.messageId,
            statusText: `指令提示: ${err}`,
          });
        }
      }
      return;
    }

    if (type === 'extension_ui_request') {
      // Auto-decline interactive TUI dialogs in headless demo mode so agent never stalls
      if (typeof record.id === 'string') {
        this.writeRpc(run.child, {
          type: 'extension_ui_response',
          id: record.id,
          cancelled: true,
        });
      }
      return;
    }

    if (type === 'message_update') {
      const evt = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!evt) return;
      const evtType = String(evt.type || '');

      if (evtType === 'text_delta' && typeof evt.delta === 'string') {
        run.assistantText += evt.delta;
        eventBus.emit(run.projectId, {
          type: 'agent_text_delta',
          messageId: run.messageId,
          delta: evt.delta,
        });
      } else if (evtType === 'thinking_delta' && typeof evt.delta === 'string') {
        run.thinkingText += evt.delta;
        eventBus.emit(run.projectId, {
          type: 'agent_thinking_delta',
          messageId: run.messageId,
          delta: evt.delta,
        });
      } else if (evtType === 'toolcall_start') {
        const stepId = String(evt.id || `tc-${run.steps.length + 1}`);
        const toolName = String(evt.toolName || 'tool');
        if (!run.stepIndexById.has(stepId)) {
          const step: AgentToolStep = { id: stepId, toolName, status: 'running' };
          run.stepIndexById.set(stepId, run.steps.length);
          run.steps.push(step);
          eventBus.emit(run.projectId, {
            type: 'agent_tool_start',
            messageId: run.messageId,
            step,
          });
        }
      } else if (evtType === 'toolcall_end') {
        const tc = evt.toolCall as Record<string, unknown> | undefined;
        const stepId = String(tc?.id || evt.id || '');
        const idx = run.stepIndexById.get(stepId);
        if (idx !== undefined && tc) {
          const toolName = String(tc.name || run.steps[idx].toolName);
          run.steps[idx].toolName = toolName;
          run.steps[idx].argsSummary = summarizeToolArgs(toolName, tc.arguments);
          eventBus.emit(run.projectId, {
            type: 'agent_tool_start',
            messageId: run.messageId,
            step: run.steps[idx],
          });
        }
      } else if (evtType === 'error') {
        const err = typeof evt.error === 'string' ? evt.error : JSON.stringify(evt.error || 'Model stream error');
        void this.finalizeRun(run, run.aborted ? 'aborted' : 'failed', err);
      }
      return;
    }

    if (type === 'tool_execution_start') {
      const stepId = String(record.toolCallId || `exec-${run.steps.length + 1}`);
      const toolName = String(record.toolName || 'tool');
      const argsSummary = summarizeToolArgs(toolName, record.args);
      const existingIdx = run.stepIndexById.get(stepId);
      if (existingIdx !== undefined) {
        run.steps[existingIdx].argsSummary = argsSummary || run.steps[existingIdx].argsSummary;
        run.steps[existingIdx].status = 'running';
        eventBus.emit(run.projectId, {
          type: 'agent_tool_start',
          messageId: run.messageId,
          step: run.steps[existingIdx],
        });
      } else {
        const step: AgentToolStep = {
          id: stepId,
          toolName,
          argsSummary,
          status: 'running',
        };
        run.stepIndexById.set(stepId, run.steps.length);
        run.steps.push(step);
        eventBus.emit(run.projectId, {
          type: 'agent_tool_start',
          messageId: run.messageId,
          step,
        });
      }
      return;
    }

    if (type === 'tool_execution_update') {
      const stepId = String(record.toolCallId || '');
      const idx = run.stepIndexById.get(stepId);
      const partial = extractTextFromToolResult(record.partialResult);
      if (idx !== undefined && partial) {
        run.steps[idx].output = partial;
        eventBus.emit(run.projectId, {
          type: 'agent_tool_update',
          messageId: run.messageId,
          stepId,
          outputDelta: partial,
        });
      }
      return;
    }

    if (type === 'tool_execution_end') {
      const stepId = String(record.toolCallId || '');
      const idx = run.stepIndexById.get(stepId);
      const isError = Boolean(record.isError);
      const output = extractTextFromToolResult(record.result);
      if (idx !== undefined) {
        run.steps[idx].status = isError ? 'error' : 'done';
        if (output) run.steps[idx].output = output;
        eventBus.emit(run.projectId, {
          type: 'agent_tool_end',
          messageId: run.messageId,
          stepId,
          status: run.steps[idx].status,
          output,
        });
      }
      return;
    }

    if (type === 'bash_execution_update' && typeof record.chunk === 'string') {
      const lastRunning = [...run.steps].reverse().find((s) => s.status === 'running');
      if (lastRunning) {
        lastRunning.output = `${lastRunning.output || ''}${record.chunk}`.slice(-1200);
        eventBus.emit(run.projectId, {
          type: 'agent_tool_update',
          messageId: run.messageId,
          stepId: lastRunning.id,
          outputDelta: lastRunning.output,
        });
      }
      return;
    }

    if (type === 'agent_settled') {
      const status = run.aborted ? 'aborted' : 'succeeded';
      void this.finalizeRun(run, status);
    }
  }

  private async finalizeRun(
    run: ActiveRun,
    status: 'succeeded' | 'aborted' | 'failed',
    error?: string,
  ): Promise<void> {
    if (run.settled) return;
    run.settled = true;
    clearTimeout(run.timeoutTimer);
    this.activeRuns.delete(run.projectId);

    // Gracefully terminate the per-run Pi RPC subprocess (session state is persisted in .pi-sessions)
    try {
      run.child.stdin.end();
      setTimeout(() => {
        if (!run.child.killed) run.child.kill('SIGTERM');
      }, 800).unref();
    } catch {
      // ignore
    }

    let previewUrl: string | null = null;
    if (status === 'succeeded') {
      eventBus.emit(run.projectId, {
        type: 'agent_status',
        messageId: run.messageId,
        statusText: '代码已完成，正在启动全栈应用与 SQLite 数据库预览服务...',
      });
      try {
        previewUrl = await run.onSettled(run.projectId, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error = `预览服务启动失败: ${msg}`;
        status = 'failed';
      }
    }

    const finalContent =
      run.assistantText.trim() ||
      (status === 'aborted'
        ? '已停止本次构建任务。你可以继续输入新的需求或修改意见。'
        : status === 'failed'
          ? `构建过程中遇到错误：${error || '未知错误'}`
          : '全栈项目构建完成！你可以在右侧预览并与应用交互。');

    const metadata: MessageMetadata = {
      mode: 'build',
      thinking: run.thinkingText || undefined,
      steps: run.steps,
      previewUrl: previewUrl || undefined,
      aborted: status === 'aborted' || undefined,
      error,
    };

    const savedMsg =
      dbStore.updateMessage(run.messageId, finalContent, metadata) ||
      dbStore.addMessage(run.projectId, 'assistant', finalContent, metadata);

    dbStore.finishAgentRun(run.runId, status, error);

    const projectStatus = status === 'succeeded' ? 'ready' : status === 'aborted' ? 'ready' : 'error';
    const updatedProj = dbStore.updateProject(run.projectId, {
      status: projectStatus,
      hasWorkspace: true,
    });
    if (updatedProj) {
      eventBus.emit(run.projectId, {
        type: 'project_updated',
        project: toProjectDTO(updatedProj, Boolean(previewUrl)),
      });
    }

    if (previewUrl) {
      eventBus.emit(run.projectId, {
        type: 'preview_ready',
        projectId: run.projectId,
        previewUrl,
      });
    }

    eventBus.emit(run.projectId, {
      type: 'agent_done',
      runId: run.runId,
      message: savedMsg,
      status,
      error,
    });
  }
}

export const piManager = new PiAgentManager();
