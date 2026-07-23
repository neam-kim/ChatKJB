export const DAEMON_APP_NAME: "ChatKJB";
export const DAEMON_BUNDLE_ID: "com.chatkjb.bot";
export const DAEMON_NODE_RUNTIME_FORMAT: "self-contained-static-v1";

export interface NodeRuntimeClassification {
  kind: "self-contained-static" | "unsupported-dynamic";
  runtimeFormat: "self-contained-static-v1" | null;
  dependencies: string[];
  nonSystemDependencies: string[];
}

export interface DaemonReleaseVersion {
  shortVersion: string;
  buildNumber: string;
}

export interface DaemonAppReceiptExpectation {
  nodeSha256: string;
  iconSha256: string;
  nodeRuntime: NodeRuntimeClassification;
  releaseVersion: DaemonReleaseVersion;
}

export interface BuildDaemonAppOptions {
  force?: boolean;
  log?: (message: string) => void;
  appPath?: string;
  nodeSource?: string;
  inspectRuntime?: (nodeSource: string) => NodeRuntimeClassification;
  removeTree?: (path: string, options: { recursive: true; force: true }) => void;
}

export function daemonAppPath(): string;
export function daemonExecutablePath(): string;
export function parseOtoolDynamicDependencies(output: string): string[];
export function classifyNodeDynamicDependencies(
  dependencies: readonly string[]
): NodeRuntimeClassification;
export function isDaemonAppReceiptCurrent(
  receipt: Record<string, unknown> | null | undefined,
  expected: DaemonAppReceiptExpectation
): boolean;
export function buildDaemonApp(options?: BuildDaemonAppOptions): {
  appPath: string;
  executablePath: string;
  rebuilt: boolean;
};
