// Single-account, process-wide admission limit: 5 attempts per 15 minutes, including concurrent
// requests and token-session logins. No attacker-controlled username/IP map or forwarded-header trust.
// Each instance has its own counter; multi-instance deployments also need an upstream shared limit.
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_ATTEMPTS = 5;
export class LoginLimiter {
  private start: number | null = null;
  private count = 0;
  take(now: number): { allowed: boolean; retryAfter: number } {
    if (this.start === null || now < this.start || now >= this.start + LOGIN_WINDOW_MS) {
      this.start = now; this.count = 0;
    }
    const retryAfter = Math.max(1, Math.ceil((this.start + LOGIN_WINDOW_MS - now) / 1000));
    if (this.count >= LOGIN_ATTEMPTS) return { allowed: false, retryAfter };
    this.count++; // Reserve before asynchronous password hashing; success never resets the budget.
    return { allowed: true, retryAfter };
  }
}
export const loginLimiter = new LoginLimiter();
