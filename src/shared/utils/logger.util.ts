export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

/** Structured logger for production debugging */
export function log(
  level: LogLevel,
  message: string,
  context?: LogContext
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context
  };

  switch (level) {
    case 'debug':
      console.debug(JSON.stringify(logEntry));
      break;
    case 'info':
      console.log(JSON.stringify(logEntry));
      break;
    case 'warn':
      console.warn(JSON.stringify(logEntry));
      break;
    case 'error':
      console.error(JSON.stringify(logEntry));
      break;
  }
}

/** Convenience methods for structured logging */
export const logger = {
  debug: (message: string, context?: LogContext): void => log('debug', message, context),
  info: (message: string, context?: LogContext): void => log('info', message, context),
  warn: (message: string, context?: LogContext): void => log('warn', message, context),
  error: (message: string, context?: LogContext): void => log('error', message, context)
};
