import time
import json
import logging
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("bulldb.observability")

# Simple Structured JSON logging handler
class StructuredLogger:
    @staticmethod
    def info(event: str, extra: Optional[Dict[str, Any]] = None):
        payload = {"level": "INFO", "event": event, "timestamp": time.time()}
        if extra: payload.update(extra)
        logger.info(json.dumps(payload))

    @staticmethod
    def error(event: str, extra: Optional[Dict[str, Any]] = None):
        payload = {"level": "ERROR", "event": event, "timestamp": time.time()}
        if extra: payload.update(extra)
        logger.error(json.dumps(payload))


# OpenTelemetry Tracing Setup
try:
    from opentelemetry import trace
    from opentelemetry.trace import Status, StatusCode
    TRACING_AVAILABLE = True
except ImportError:
    TRACING_AVAILABLE = False

class TracerWrapper:
    @staticmethod
    def trace_span(name: str):
        # decorator or context manager
        if TRACING_AVAILABLE:
            tracer = trace.get_tracer("bulldb")
            return tracer.start_as_current_span(name)
        else:
            class DummySpan:
                def __enter__(self): return self
                def __exit__(self, exc_type, exc_val, exc_tb): pass
                def set_attribute(self, key, value): pass
                def set_status(self, status): pass
            return DummySpan()


# Prometheus Metric exporter mock
class PrometheusMetrics:
    _metrics: Dict[str, float] = {}

    @classmethod
    def increment(cls, name: str, value: float = 1.0):
        cls._metrics[name] = cls._metrics.get(name, 0.0) + value

    @classmethod
    def record_duration(cls, name: str, duration: float):
        cls._metrics[name] = duration # Record last duration

    @classmethod
    def export_metrics(cls) -> str:
        # Formats metrics in Prometheus exposition text format
        lines = []
        for k, v in cls._metrics.items():
            lines.append(f"bulldb_{k} {v}")
        return "\n".join(lines)
