import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

export type SandboxActionKind = 'test' | 'agent-action' | 'repository-mutation';

export type SandboxRunStatus =
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timeout';

export type ApprovalRisk = 'low' | 'medium' | 'high';

export interface ApprovalCheckpoint {
  id: string;
  title: string;
  detail: string;
  risk: ApprovalRisk;
  required: boolean;
}

export interface ApprovalDecision {
  checkpointId: string;
  approved: boolean;
  decidedAt: string;
  reason?: string;
}

export interface ApprovalProvider {
  requestApproval(checkpoint: ApprovalCheckpoint, request: SandboxRunRequest): Promise<ApprovalDecision>;
}

export interface SandboxRunRequest {
  id: string;
  title: string;
  kind: SandboxActionKind;
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  mutatesRepository?: boolean;
  checkpoints?: ApprovalCheckpoint[];
  allowedExitCodes?: number[];
}

export interface SandboxRunResult {
  requestId: string;
  status: SandboxRunStatus;
  commandSummary: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  approvals: ApprovalDecision[];
}

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_CAPTURED_OUTPUT_CHARS = 64000;
const APPROVE_LABEL = 'Approve';

export class VscodeApprovalProvider implements ApprovalProvider {
  public async requestApproval(checkpoint: ApprovalCheckpoint, request: SandboxRunRequest): Promise<ApprovalDecision> {
    if (!checkpoint.required) {
      return approve(checkpoint.id);
    }

    const selected = await vscode.window.showWarningMessage(
      checkpoint.title,
      {
        modal: true,
        detail: [
          checkpoint.detail,
          '',
          `Command: ${formatCommand(request.command, request.args ?? [])}`,
          `Working directory: ${request.cwd}`,
          `Risk: ${checkpoint.risk}`
        ].join('\n')
      },
      APPROVE_LABEL,
      'Cancel'
    );

    if (selected === APPROVE_LABEL) {
      return approve(checkpoint.id);
    }

    return {
      checkpointId: checkpoint.id,
      approved: false,
      decidedAt: new Date().toISOString(),
      reason: 'User cancelled approval checkpoint.'
    };
  }
}

export class SandboxRunner {
  public constructor(private readonly approvalProvider: ApprovalProvider = new VscodeApprovalProvider()) {}

  public async run(request: SandboxRunRequest, cancellationToken?: vscode.CancellationToken): Promise<SandboxRunResult> {
    const startedAt = new Date();
    const approvals = await this.collectApprovals(request);
    const rejected = approvals.find((decision) => !decision.approved);

    if (rejected) {
      return createResult(request, 'rejected', startedAt, null, null, '', '', approvals);
    }

    if (cancellationToken?.isCancellationRequested) {
      return createResult(request, 'cancelled', startedAt, null, null, '', '', approvals);
    }

    return this.spawnProcess(request, approvals, startedAt, cancellationToken);
  }

  private async collectApprovals(request: SandboxRunRequest): Promise<ApprovalDecision[]> {
    const checkpoints = normalizeCheckpoints(request);
    const decisions: ApprovalDecision[] = [];

    for (const checkpoint of checkpoints) {
      const decision = await this.approvalProvider.requestApproval(checkpoint, request);
      decisions.push(decision);

      if (!decision.approved) {
        break;
      }
    }

    return decisions;
  }

  private async spawnProcess(
    request: SandboxRunRequest,
    approvals: ApprovalDecision[],
    startedAt: Date,
    cancellationToken?: vscode.CancellationToken
  ): Promise<SandboxRunResult> {
    return new Promise<SandboxRunResult>((resolve) => {
      const child = spawn(request.command, request.args ?? [], {
        cwd: request.cwd,
        env: { ...process.env, ...(request.env ?? {}) },
        shell: false,
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      let didTimeout = false;
      let didCancel = false;

      const timeout = setTimeout(() => {
        didTimeout = true;
        child.kill('SIGTERM');
      }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const cancellationDisposable = cancellationToken?.onCancellationRequested(() => {
        didCancel = true;
        child.kill('SIGTERM');
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk.toString());
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk.toString());
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        cancellationDisposable?.dispose();
        resolve(createResult(request, 'failed', startedAt, null, null, stdout, appendBounded(stderr, error.message), approvals));
      });

      child.on('close', (exitCode, signal) => {
        clearTimeout(timeout);
        cancellationDisposable?.dispose();

        if (didTimeout) {
          resolve(createResult(request, 'timeout', startedAt, exitCode, signal, stdout, stderr, approvals));
          return;
        }

        if (didCancel) {
          resolve(createResult(request, 'cancelled', startedAt, exitCode, signal, stdout, stderr, approvals));
          return;
        }

        const allowedExitCodes = request.allowedExitCodes ?? [0];
        const status: SandboxRunStatus = exitCode !== null && allowedExitCodes.includes(exitCode) ? 'completed' : 'failed';
        resolve(createResult(request, status, startedAt, exitCode, signal, stdout, stderr, approvals));
      });
    });
  }
}

function normalizeCheckpoints(request: SandboxRunRequest): ApprovalCheckpoint[] {
  const checkpoints = [...(request.checkpoints ?? [])];

  if (request.mutatesRepository && !checkpoints.some((checkpoint) => checkpoint.id === 'repository-mutation')) {
    checkpoints.unshift({
      id: 'repository-mutation',
      title: 'Approve repository mutation',
      detail: `${request.title} can change files, branches, or repository state. Review the command before approving.`,
      risk: 'high',
      required: true
    });
  }

  if (request.kind === 'test' && !checkpoints.some((checkpoint) => checkpoint.id === 'test-execution')) {
    checkpoints.unshift({
      id: 'test-execution',
      title: 'Approve test execution',
      detail: `${request.title} will run tests or validation commands in the workspace.`,
      risk: request.mutatesRepository ? 'medium' : 'low',
      required: !!request.mutatesRepository
    });
  }

  return checkpoints;
}

function approve(checkpointId: string): ApprovalDecision {
  return {
    checkpointId,
    approved: true,
    decidedAt: new Date().toISOString()
  };
}

function createResult(
  request: SandboxRunRequest,
  status: SandboxRunStatus,
  startedAt: Date,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
  approvals: ApprovalDecision[]
): SandboxRunResult {
  const finishedAt = new Date();
  return {
    requestId: request.id,
    status,
    commandSummary: formatCommand(request.command, request.args ?? []),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    exitCode,
    signal,
    stdout,
    stderr,
    approvals
  };
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    return combined;
  }

  return combined.slice(combined.length - MAX_CAPTURED_OUTPUT_CHARS);
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map(quoteArg)].join(' ');
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) {
    return arg;
  }

  return JSON.stringify(arg);
}
