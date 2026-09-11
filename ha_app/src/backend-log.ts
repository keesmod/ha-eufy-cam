/** Code and optional bounded discovery detail, never a raw error or inventory. */
export function logBackendFault(code: string, detail?: string): void {
  console.error('Eufy backend:', code, ...(detail ? [detail] : []));
}

export function logDiscoveryDiagnostic(line: string): void {
  console.info('Eufy discovery:', line);
}
