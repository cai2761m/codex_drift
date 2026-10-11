"""Verify real OTLP/HTTP export and W3C propagation across Rust and Python, without a model API."""

import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

ROOT = Path(__file__).resolve().parents[1]
TRACE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
captured = []


class Collector(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        batch = ExportTraceServiceRequest.FromString(body)
        for resource in batch.resource_spans:
            service = next(
                (a.value.string_value for a in resource.resource.attributes if a.key == "service.name"), ""
            )
            for scope in resource.scope_spans:
                for span in scope.spans:
                    captured.append(
                        (
                            service,
                            span.name,
                            span.trace_id.hex(),
                            span.span_id.hex(),
                            span.parent_span_id.hex(),
                        )
                    )
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    collector = ThreadingHTTPServer(("127.0.0.1", 0), Collector)
    threading.Thread(target=collector.serve_forever, daemon=True).start()
    api_port, analyzer_port = free_port(), free_port()
    processes = []
    with tempfile.TemporaryDirectory(prefix="drift-otel-", dir=ROOT / "data") as temp:
        env = {
            **os.environ,
            "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{collector.server_port}",
            "API_BIND": f"127.0.0.1:{api_port}",
            "ANALYZER_URL": f"http://127.0.0.1:{analyzer_port}",
            "DATABASE_URL": "sqlite://" + (Path(temp) / "trace.db").as_posix() + "?mode=rwc",
            "OPENAI_API_KEY": "",
        }
        mingw = ROOT / ".tools/winlibs/mingw64/bin"
        if mingw.exists():
            env["PATH"] = str(mingw) + os.pathsep + env["PATH"]
        python = (
            ROOT / "analyzer/.venv/Scripts/python.exe"
            if os.name == "nt"
            else ROOT / "analyzer/.venv/bin/python"
        )
        gateway = (
            ROOT / "gateway/target/debug" / ("drift-gateway.exe" if os.name == "nt" else "drift-gateway")
        )
        try:
            for command, cwd in [
                (
                    [str(python), "-m", "uvicorn", "drift.app:app", "--port", str(analyzer_port)],
                    ROOT / "analyzer",
                ),
                ([str(gateway)], ROOT),
            ]:
                processes.append(
                    subprocess.Popen(
                        command, cwd=cwd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                    )
                )
            base = f"http://127.0.0.1:{api_port}/api"
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base + "/health", timeout=1) as response:
                        if json.load(response)["status"] == "ok":
                            break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise AssertionError("isolated services not ready")
            body = {
                "title": "OTLP check",
                "mode": "demo",
                "requested_model": "demo-codex",
                "repetitions": 1,
                "api_style": "responses",
                "reasoning_effort": "default",
                "scenario": "healthy",
            }
            request = urllib.request.Request(
                base + "/runs",
                data=json.dumps(body).encode(),
                headers={
                    "Content-Type": "application/json",
                    "traceparent": f"00-{TRACE}-2222222222222222-01",
                },
            )
            with urllib.request.urlopen(request) as response:
                job = json.load(response)
                assert job["trace_id"] == TRACE
            for _ in range(150):
                spans = [s for s in captured if s[2] == TRACE]
                gateway_span = next(
                    (s for s in spans if s[0] == "drift-gateway" and s[1] == "analyzer.request"), None
                )
                analyzer_span = next(
                    (s for s in spans if s[0] == "drift-analyzer" and s[1] == "POST /evaluate"), None
                )
                evaluate_span = next((s for s in spans if s[1] == "benchmark.evaluate"), None)
                if gateway_span and analyzer_span and evaluate_span:
                    assert analyzer_span[4] == gateway_span[3]
                    print(
                        "PASS: OTLP/HTTP export from Rust + Python; shared trace ID and exact parent span propagation."
                    )
                    return
                time.sleep(0.1)
            raise AssertionError("expected spans were not exported")
        finally:
            for process in processes:
                process.terminate()
            for process in processes:
                process.wait(timeout=10)
            collector.shutdown()


if __name__ == "__main__":
    main()
