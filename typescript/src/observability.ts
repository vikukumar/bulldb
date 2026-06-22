export class StructuredLogger {
  static info(event: string, extra?: Record<string, any>) {
    console.log(JSON.stringify({
      level: "INFO",
      event,
      timestamp: Date.now() / 1000,
      ...extra
    }));
  }

  static error(event: string, extra?: Record<string, any>) {
    console.error(JSON.stringify({
      level: "ERROR",
      event,
      timestamp: Date.now() / 1000,
      ...extra
    }));
  }
}

export class TracerWrapper {
  static traceSpan(name: string) {
    try {
      const api = require("@opentelemetry/api");
      const tracer = api.trace.getTracer("bulldb");
      return tracer.startActiveSpan(name, (span: any) => span);
    } catch (err) {
      // OpenTelemetry not loaded, return dummy span
      return {
        end: () => {},
        setAttribute: () => {},
        setStatus: () => {}
      };
    }
  }
}

export class PrometheusMetrics {
  private static metrics: Record<string, number> = {};

  static increment(name: string, value = 1.0) {
    this.metrics[name] = (this.metrics[name] || 0.0) + value;
  }

  static recordDuration(name: string, duration: number) {
    this.metrics[name] = duration;
  }

  static exportMetrics(): string {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(this.metrics)) {
      lines.push(`bulldb_${k} ${v}`);
    }
    return lines.join("\n");
  }
}
