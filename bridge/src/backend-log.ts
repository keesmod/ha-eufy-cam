/** Code and optional bounded discovery detail, never a raw error or inventory. */
export function logBackendFault(code: string, detail?: string): void {
  console.error('Eufy backend:', code, ...(detail ? [detail] : []));
}
