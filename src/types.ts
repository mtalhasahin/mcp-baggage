/**
 * The shapes everything else passes around.  [PURE]
 *
 * Deliberately looser than the MCP schema: a server is free to send fields
 * this tool has never heard of, and the point is to weigh what arrives, not
 * to validate it. Anything unrecognised still counts toward the bill.
 */

/** How a server is reached. */
export type Transport = 'stdio' | 'http';

/** One server, as some client's config file describes it. */
export type ServerSpec = {
  /** The name the config gave it — this is what tool names are prefixed with. */
  name: string;
  /** Which client's config this came from: `claude-code`, `cursor`, `codex`, `vscode`, `windsurf`. */
  client: string;
  /** Where that config lives, so a report can say which file to edit. */
  source: string;
  /** `user` for a machine-wide config, `project` for one inside the repo. */
  scope: 'user' | 'project';
  transport: Transport;
  /** stdio only. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http only. */
  url?: string;
  headers?: Record<string, string>;
  /** Some clients can carry a server while leaving it switched off. */
  enabled: boolean;
  /**
   * Every client whose config carries this same server.
   *
   * The same command appears in two or three configs more often than not, and
   * it costs the same in each, so it is weighed once and the report names the
   * files rather than billing it twice.
   */
  carriedBy: string[];
};

/** A tool as the server declares it, and as the model will be shown it. */
export type ToolDef = {
  name: string;
  description?: string;
  /** JSON Schema. Kept as-is: its size is the whole subject. */
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
};

export type PromptDef = { name: string; description?: string; arguments?: unknown };
export type ResourceDef = { uri?: string; name?: string; description?: string; mimeType?: string };

/** What one server turned out to be carrying. */
export type Inventory = {
  server: ServerSpec;
  tools: ToolDef[];
  prompts: PromptDef[];
  resources: ResourceDef[];
  /** Server name and version from `initialize`, when it gave one. */
  title?: string;
  /** How long the handshake and listing took, in milliseconds. */
  ms: number;
  /** Set when the server could not be reached or refused to speak. */
  error?: string;
};

/** A tool weighed: what it costs, and whether anyone has used it. */
export type WeighedTool = {
  /** The bare name the server gave. */
  name: string;
  /** The name a client shows the model, e.g. `mcp__github__create_issue`. */
  qualified: string;
  tokens: number;
  /** Times it was called in the transcripts that were read, or `null` when none were. */
  calls: number | null;
};

export type WeighedServer = {
  server: ServerSpec;
  title?: string;
  tools: WeighedTool[];
  /** Tokens for the tool definitions alone. */
  tokens: number;
  prompts: number;
  resources: number;
  ms: number;
  error?: string;
};
