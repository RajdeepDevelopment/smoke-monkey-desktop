import { Logger } from '@nestjs/common';

/**
 * Lightweight connector/extension registry.
 *
 * Connectors (SSH is the first) extend the agent/IDE beyond the local
 * filesystem + shell. Each connector exposes:
 *   - an identity/descriptor used to list available connectors to the UI,
 *   - a way to resolve its configured destination(s),
 *   - terminal-like exec and file operations, all behind one interface so the
 *     frontend and the agent tool registry can consume connectors uniformly.
 *
 * New connectors register() themselves in a small bootstrap module; the agent
 * tool layer (`ssh_run`) and the workspace/terminal controllers can then
 * dispatch to whatever connector matches the requested scope.
 */

export interface ConnectorDescriptor {
  /** Stable id, e.g. 'ssh'. */
  id: string;
  /** Human label, e.g. 'SSH'. */
  label: string;
  /** Optional icon key for the UI. */
  icon?: string;
  /** Presentational capabilities. */
  capabilities?: string[];
}

/** A resolvable remote/local execution target (e.g. an SSH profile). */
export interface ConnectorDestination {
  /** Per-connector destination id (e.g. profile uuid or 'local'). */
  id: string;
  /** Display label, e.g. 'my-server' or 'Local'. */
  label: string;
  /** Optional sub-path hint for the working dir. */
  root?: string;
  /** Whether the connector reports this as currently connected. */
  connected?: boolean;
}

export interface ConnectorExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Called with cumulative (header, stdout, stderr) snapshots as they arrive. */
  onStream?: (header: string, stdout: string, stderr: string) => void;
}

export interface ConnectorExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
}

export interface ConnectorFileInfo {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  mtime?: string;
}

/** A connector is a remote/local transport that can run commands and inspect files. */
export interface Connector {
  readonly id: string;
  readonly label: string;
  /** List configured destinations (for SSH: the saved profiles; added to any
   *  implicit 'local' destination the host surfaces). */
  listDestinations(userId: string): Promise<ConnectorDestination[]>;
  /** Test connectivity to a specific destination. */
  test(destinationId: string, userId: string): Promise<{ ok: boolean; detail?: string }>;
  /** Run a one-shot command on the destination. */
  exec(destinationId: string, userId: string, command: string, options?: ConnectorExecOptions): Promise<ConnectorExecResult>;
  /** List a remote directory. */
  list(destinationId: string, userId: string, path: string): Promise<ConnectorFileInfo[]>;
  /** Read a remote file (utf-8, tail-capped). */
  read(destinationId: string, userId: string, path: string): Promise<{ content: string; size: number; truncated: boolean }>;
}

export class ConnectorRegistry {
  private readonly logger = new Logger(ConnectorRegistry.name);
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) {
      this.logger.warn(`Connector already registered, replacing: ${connector.id}`);
    }
    this.connectors.set(connector.id, connector);
    this.logger.log(`Registered connector: ${connector.id}`);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  getAll(): Connector[] {
    return Array.from(this.connectors.values());
  }

  listDescriptors(): ConnectorDescriptor[] {
    return this.getAll().map((c) => ({ id: c.id, label: c.label }));
  }
}
