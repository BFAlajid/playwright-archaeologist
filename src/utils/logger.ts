/**
 * Leveled logger for playwright-archaeologist.
 *
 * Provides debug, info, warn, error, and success log methods
 * with timestamps and ANSI color output. Debug messages are
 * suppressed unless verbose mode is enabled.
 */

// ANSI color codes — no external dependency needed.
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  /** Update the minimum log level at runtime. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Get the current minimum log level. */
  getLevel(): LogLevel {
    return this.level;
  }

  /** Check whether a given level would be emitted. */
  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.isLevelEnabled('debug')) return;
    const ts = `${DIM}${timestamp()}${RESET}`;
    const prefix = `${CYAN}DEBUG${RESET}`;
    // eslint-disable-next-line no-console
    console.error(`${ts} ${prefix} ${message}`, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    if (!this.isLevelEnabled('info')) return;
    const ts = `${DIM}${timestamp()}${RESET}`;
    const prefix = `${BOLD}INFO${RESET}`;
    // eslint-disable-next-line no-console
    console.error(`${ts} ${prefix}  ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (!this.isLevelEnabled('warn')) return;
    const ts = `${DIM}${timestamp()}${RESET}`;
    const prefix = `${YELLOW}WARN${RESET}`;
    // eslint-disable-next-line no-console
    console.error(`${ts} ${prefix}  ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    if (!this.isLevelEnabled('error')) return;
    const ts = `${DIM}${timestamp()}${RESET}`;
    const prefix = `${RED}ERROR${RESET}`;
    // eslint-disable-next-line no-console
    console.error(`${ts} ${prefix} ${message}`, ...args);
  }

  /** Success message — always shown at info level or below. */
  success(message: string, ...args: unknown[]): void {
    if (!this.isLevelEnabled('info')) return;
    const ts = `${DIM}${timestamp()}${RESET}`;
    const prefix = `${GREEN}OK${RESET}`;
    // eslint-disable-next-line no-console
    console.error(`${ts} ${prefix}    ${message}`, ...args);
  }
}

/**
 * Shared singleton logger instance.
 * The CLI sets its level to 'debug' when --verbose is passed.
 */
export const logger = new Logger('info');
