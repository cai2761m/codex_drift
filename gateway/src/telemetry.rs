use axum::{extract::Request, http::HeaderMap, middleware::Next, response::Response};
use opentelemetry::{
    Context, global,
    propagation::Extractor,
    trace::{FutureExt, TraceContextExt, Tracer},
};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{Resource, propagation::TraceContextPropagator, trace::SdkTracerProvider};

struct Headers<'a>(&'a HeaderMap);
impl Extractor for Headers<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }
    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}

pub fn initialize() -> Result<SdkTracerProvider, Box<dyn std::error::Error + Send + Sync>> {
    global::set_text_map_propagator(TraceContextPropagator::new());
    let mut builder = SdkTracerProvider::builder().with_resource(
        Resource::builder()
            .with_service_name("drift-gateway")
            .build(),
    );
    if let Ok(endpoint) = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        if !endpoint.trim().is_empty() {
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_http()
                .with_protocol(Protocol::HttpBinary)
                .with_endpoint(format!("{}/v1/traces", endpoint.trim_end_matches('/')))
                .build()?;
            builder = builder.with_batch_exporter(exporter);
        }
    }
    let provider = builder.build();
    global::set_tracer_provider(provider.clone());
    Ok(provider)
}

pub async fn trace_request(request: Request, next: Next) -> Response {
    let parent = global::get_text_map_propagator(|p| p.extract(&Headers(request.headers())));
    let span = global::tracer("drift-gateway")
        .start_with_context(format!("HTTP {}", request.method()), &parent);
    let context = Context::current_with_span(span);
    let trace_id = context.span().span_context().trace_id().to_string();
    let mut response = next.run(request).with_context(context.clone()).await;
    if let Ok(value) = trace_id.parse() {
        response.headers_mut().insert("x-trace-id", value);
    }
    context.span().end();
    response
}

pub async fn analyzer_call(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, reqwest::Error> {
    let parent = Context::current();
    let span = global::tracer("drift-gateway").start_with_context("analyzer.request", &parent);
    let context = Context::current_with_span(span);
    let mut carrier = std::collections::HashMap::new();
    global::get_text_map_propagator(|p| p.inject_context(&context, &mut carrier));
    let mut request = client.post(url).json(body);
    for (key, value) in carrier {
        request = request.header(key, value);
    }
    let result = request.send().with_context(context.clone()).await;
    context.span().end();
    result
}
