/**
 * Isolated executable fixture for T6 PR automatic code review verification.
 * This file is not imported by production code or GitHub workflows.
 */
export function summarizeChecks(checks) {
  if (!Array.isArray(checks)) {
    throw new TypeError('checks must be an array');
  }

  const total = checks.length;
  const passed = checks.filter((check) => check === 'passed').length;
  const failed = checks.filter((check) => check === 'failed').length;

  return {
    total,
    passed,
    failed,
    pending: total - passed - failed,
    ready: total > 0 && failed === 0 && passed === total,
  };
}
