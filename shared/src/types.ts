export type ProjectStatus = 'chatting' | 'queued' | 'building' | 'ready' | 'error';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface AgentToolStep {
  id: string;
  toolName: string;
  argsSummary?: string;
  status: 'running' | 'done' | 'error';
  output?: string;
}

export interface HandoffMetadata {
  targetProjectId: string;
  targetWorkspaceId?: string | null;
  targetAgentId: string;
  targetAgentName: string;
  targetTitle: string;
  reason?: string;
}

export interface AgentBudgetConfig {
  /** Hard time limit in milliseconds */
  maxDurationMs: number;
  /** Hard estimated cost limit in CNY */
  maxCostCny: number;
  /** Hard cumulative token limit */
  maxTokens: number;
  /** Hard tool call count limit */
  maxToolCalls: number;
  /** Fraction [0.5..0.95] at which Agent receives a soft steer warning to wrap up */
  softWarnRatio: number;
}

export interface AgentUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  estimatedCostCny: number;
  toolCalls: number;
  elapsedMs: number;
}

export interface AgentBudgetSnapshot {
  limits: AgentBudgetConfig;
  softWarned: boolean;
  exceededReason?: string;
}

export interface MessageMetadata {
  mode?: 'chat' | 'build' | 'handoff';
  agentId?: string;
  thinking?: string;
  steps?: AgentToolStep[];
  previewUrl?: string;
  aborted?: boolean;
  error?: string;
  handoff?: HandoffMetadata;
  usage?: AgentUsageStats;
  budget?: AgentBudgetSnapshot;
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  hasSkill: boolean;
  mcpServerName?: string;
}

export type AgentIconType = 'code' | 'research' | 'bot';
export type AgentWorkspaceTab = 'preview' | 'code' | 'database' | 'logs';

export interface AgentStarterPrompt {
  title: string;
  prompt: string;
}

export interface AgentIntentSpec {
  description: string;
  keywords?: string[];
  examples?: string[];
}

export interface AgentUISpec {
  workspaceLabel: string;
  previewTabLabel: string;
  tabs: AgentWorkspaceTab[];
  starterPrompts: AgentStarterPrompt[];
}

export interface AgentPresetSummary {
  id: string;
  aliases?: string[];
  name: string;
  shortName: string;
  icon: AgentIconType;
  description: string;
  templateId: string;
  plugins: PluginSummary[];
  intent?: AgentIntentSpec;
  budget?: Partial<AgentBudgetConfig>;
  ui: AgentUISpec;
}

export type AgentRecipeSummary = AgentPresetSummary;

export interface TableColumnDTO {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface TableInfoDTO {
  logicalName: string;
  physicalName: string;
  rowCount: number;
  columns: TableColumnDTO[];
  sql: string;
}

export interface ActiveRunSnapshot {
  runId?: string;
  messageId: string;
  mode: 'chat' | 'build';
  queued?: boolean;
  startedAt: number;
  lastActivityAt: number;
  statusText?: string;
  thinking: string;
  text: string;
  steps: AgentToolStep[];
  usage?: AgentUsageStats;
  budget?: AgentBudgetSnapshot;
  seq: number;
}

export interface WorkspaceDTO {
  id: string;
  owner: string;
  name: string;
  presetId: string;
  tablePrefix: string;
  previewUrl: string;
  previewRunning: boolean;
  activeBuildProjectId?: string | null;
  activeBuildTitle?: string | null;
  queuedProjectIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDTO {
  id: string;
  owner: string;
  title: string;
  presetId: string;
  workspaceId: string | null;
  workspaceName?: string | null;
  tablePrefix: string;
  status: ProjectStatus;
  hasWorkspace: boolean;
  previewUrl: string | null;
  previewRunning: boolean;
  activeStep?: string | null;
  lastActivityAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageDTO {
  id: string;
  projectId: string;
  role: MessageRole;
  content: string;
  metadata?: MessageMetadata;
  createdAt: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
}

export type SSEEventPayload =
  | {
      type: 'connected';
      projectId: string;
      serverBootId: string;
      projectStatus: ProjectStatus;
      isBuilding: boolean;
      activeRun: ActiveRunSnapshot | null;
      latestMessageId?: string | null;
      messageCount?: number;
    }
  | { type: 'heartbeat' }
  | { type: 'project_updated'; project: ProjectDTO }
  | { type: 'message_created'; message: MessageDTO }
  | { type: 'chat_start'; messageId: string; startedAt?: number }
  | { type: 'chat_delta'; messageId: string; delta: string }
  | { type: 'chat_done'; message: MessageDTO; suggestBuild?: boolean }
  | { type: 'agent_queued'; messageId: string; workspaceId: string; position: number; blockingProjectId: string; blockingTitle?: string }
  | { type: 'agent_start'; runId: string; messageId: string; startedAt?: number }
  | { type: 'agent_thinking_delta'; messageId: string; delta: string }
  | { type: 'agent_text_delta'; messageId: string; delta: string }
  | { type: 'agent_tool_start'; messageId: string; step: AgentToolStep }
  | { type: 'agent_tool_update'; messageId: string; stepId: string; outputDelta: string }
  | { type: 'agent_tool_end'; messageId: string; stepId: string; status: 'done' | 'error'; output?: string }
  | { type: 'agent_status'; messageId: string; statusText: string }
  | { type: 'agent_budget_update'; messageId: string; usage: AgentUsageStats; budget: AgentBudgetSnapshot }
  | { type: 'preview_ready'; projectId: string; previewUrl: string }
  | { type: 'agent_done'; runId: string; message: MessageDTO; status: 'succeeded' | 'aborted' | 'failed'; error?: string }
  | { type: 'error'; message: string };

export type SSEEvent = SSEEventPayload & {
  seq?: number;
  ts?: number;
};

export type UserGlobalSSEEvent =
  | {
      type: 'user_connected';
      username: string;
      serverBootId: string;
      activeProjectIds: string[];
      ts: number;
    }
  | { type: 'heartbeat'; ts: number }
  | { type: 'workspace_updated'; workspace: WorkspaceDTO }
  | { type: 'workspace_deleted'; workspaceId: string }
  | { type: 'project_updated'; project: ProjectDTO }
  | {
      type: 'project_activity';
      projectId: string;
      status: ProjectStatus;
      isBuilding: boolean;
      activeStep?: string | null;
      startedAt?: number | null;
      lastActivityAt?: number | null;
    }
  | {
      type: 'project_run_finished';
      projectId: string;
      status: 'succeeded' | 'aborted' | 'failed';
      project: ProjectDTO;
    }
  | { type: 'project_deleted'; projectId: string };
