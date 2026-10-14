import { diagnosticModel } from './discovery-diagnostics.js';

/** Code and optional bounded discovery detail, never a raw error or inventory. */
export function logBackendFault(code: string, detail?: string): void {
  console.error('Eufy backend:', code, ...(detail ? [detail] : []));
}

export function logDiscoveryDiagnostic(line: string): void {
  console.info('Eufy discovery:', line);
}

/** A standalone camera the library did not admit while the option is on. Model code only. */
export function logStandaloneNotAdmitted(model: unknown): void {
  // Revalidate at this logging boundary. Never log an ID, name or raw value.
  console.info(
    'Eufy experimental standalone:',
    `model=${diagnosticModel(model)} is not admitted to the experimental route. The option is on, but the bundled library allows that route only for specific standalone models, so this camera stays standalone_transport_unverified without a connection attempt.`,
  );
}
