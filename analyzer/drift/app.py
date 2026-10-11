import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from pydantic import BaseModel, Field

from .analysis import summarize
from .benchmarks import PROBES, SUITE_VERSION, grade, public_suite
from .importer import analyze_import
from .provider import query

provider = TracerProvider(resource=Resource.create({"service.name": "drift-analyzer"}))
endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
if endpoint:
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint.rstrip("/") + "/v1/traces"))
    )
trace.set_tracer_provider(provider)
HTTPXClientInstrumentor().instrument()
tracer = trace.get_tracer("codex-drift.analysis")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    provider.shutdown()


app = FastAPI(title="Codex Drift Analyzer", version="0.1.0", lifespan=lifespan)
FastAPIInstrumentor.instrument_app(app, excluded_urls="health")


class Evaluation(BaseModel):
    mode: Literal["demo", "live"] = "demo"
    scenario: Literal["healthy", "degraded", "rerouted"] = "healthy"
    requested_model: str = Field(min_length=1, max_length=200)
    repetitions: int = Field(default=3, ge=1, le=5)
    api_style: Literal["responses", "chat"] = "responses"
    reasoning_effort: Literal["default", "none", "minimal", "low", "medium", "high", "xhigh"] = "default"
    baseline: dict | None = None


class ImportRequest(BaseModel):
    content: str = Field(max_length=2 * 1024 * 1024)
    expected_model: str = Field(default="", max_length=200)


@app.get("/health")
def health():
    return {"status": "ok", "service": "drift-analyzer", "otel_export_enabled": bool(endpoint)}


@app.get("/config")
def config():
    return {
        "live_available": bool(os.getenv("OPENAI_API_KEY")),
        "provider_url": os.getenv("PROVIDER_BASE_URL", "https://api.openai.com/v1"),
        "default_model": os.getenv("DEFAULT_MODEL", "demo-codex"),
        "otel_export_enabled": bool(endpoint),
        "suite_version": SUITE_VERSION,
    }


@app.get("/benchmarks")
def benchmarks():
    return public_suite()


@app.post("/evaluate")
async def evaluate(request: Evaluation):
    if request.mode == "live" and not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(400, "请先在服务器配置 OPENAI_API_KEY。")
    config = request.model_dump(exclude={"baseline"})
    config["provider_url"] = (
        "demo://local"
        if request.mode == "demo"
        else os.getenv("PROVIDER_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    )
    samples = []
    with tracer.start_as_current_span(
        "benchmark.evaluate",
        attributes={"drift.mode": request.mode, "drift.repetitions": request.repetitions},
    ):
        async with httpx.AsyncClient(
            timeout=float(os.getenv("PROVIDER_TIMEOUT_SECONDS", "60")), follow_redirects=False
        ) as client:
            for rep in range(request.repetitions):
                for probe in PROBES:
                    sample = await query(client, probe, config, rep + 1)
                    sample["score"], sample["grade_reason"] = (
                        (0.0, "接口错误不计为能力失败")
                        if sample.get("error")
                        else grade(probe, sample["output"])
                    )
                    samples.append(sample)
    report = {
        **config,
        "suite_version": SUITE_VERSION,
        "samples": samples,
        "finished_at": datetime.now(UTC).isoformat(),
        "limitations": [
            "固定 8 项测试只覆盖有限能力；不执行模型生成的代码。",
            "延迟是完整响应耗时，包含网络、排队与推理；不是首 token 延迟。",
            "未返回的 token 字段保留为空；token 数和速度不能识别模型。",
            "演示模式的所有输出、耗时和模型名都是合成数据。",
        ],
    }
    return summarize(report, request.baseline)


@app.post("/analyze-import")
def import_session(request: ImportRequest):
    try:
        return analyze_import(request.content, request.expected_model)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
