/**
 * Structured JSON logging in Cloud Logging's format (Principle III, T037).
 *
 * The field names are not cosmetic: the alerting policy in contracts/admin-api.md counts entries
 * by `severity` and `labels.component`, so renaming either silently disables the operator's only
 * failure notification (FR-043).
 */
export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** Derives a child logger that carries extra fields on every entry. */
  child(fields: LogFields): Logger
  readonly correlationId: string
}

export interface LoggerOptions {
  component: 'api' | 'optimizer' | 'scripts'
  correlationId: string
  base?: LogFields
  /** Injected so tests can capture output without patching globals. */
  sink?: (line: string) => void
}

function serialise(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => console.log(line))

  const emit = (severity: Severity, message: string, fields?: LogFields): void => {
    const entry = {
      severity,
      message,
      time: new Date().toISOString(),
      'logging.googleapis.com/labels': { component: options.component },
      labels: { component: options.component },
      correlationId: options.correlationId,
      ...Object.fromEntries(
        Object.entries({ ...options.base, ...fields }).map(([k, v]) => [k, serialise(v)]),
      ),
    }
    sink(JSON.stringify(entry))
  }

  return {
    correlationId: options.correlationId,
    debug: (m, f) => emit('DEBUG', m, f),
    info: (m, f) => emit('INFO', m, f),
    warn: (m, f) => emit('WARNING', m, f),
    error: (m, f) => emit('ERROR', m, f),
    child: (fields) => createLogger({ ...options, base: { ...options.base, ...fields } }),
  }
}

/**
 * A correlation ID links a decision to the API calls it caused (Principle III). Derived from the
 * cycle ID where one exists so the link survives a retry of the same scheduled instant.
 */
export function correlationIdForCycle(cycleId: string): string {
  return `cycle-${cycleId.replace(/[^0-9A-Za-z]/g, '')}`
}
