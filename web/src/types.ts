export type Config = {
  live_available: boolean;
  provider_url: string;
  default_model: string;
  database: string;
  otel_export_enabled: boolean;
  suite_version: string;
};
export type Sample = {
  probe_id: string;
  title: string;
  category: string;
  repetition: number;
  score: number;
  error: string | null;
  output?: string;
  returned_model?: string;
  latency_ms: number;
  request_id?: string;
  reasoning_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  grade_reason: string;
};
export type Report = {
  mode: string;
  requested_model: string;
  score: number | null;
  sample_count: number;
  valid_count: number;
  error_count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  total_tokens: number;
  metadata_coverage: number;
  samples?: Sample[];
  verdict: string;
  categories: Record<string, number>;
  suite_version: string | null;
  route: {
    status: string;
    label: string;
    reason: string;
    mismatch_count: number;
    observed_models: string[];
  };
  comparison: {
    status: string;
    label: string;
    reason: string;
    drop_pp?: number;
    delta_ci95_pp?: number[];
    paired_probes?: number;
  };
  import_summary?: {
    record_count: number;
    configuration_changes: number;
    configurations: { line: number; model: string; effort?: string }[];
    responses: {
      line: number;
      requested_model: string;
      returned_model: string;
      request_id?: string;
      mismatch: boolean;
    }[];
    note: string;
  };
};
export type Run = {
  id: string;
  title: string;
  created_at: string;
  status: string;
  trace_id: string;
  config: {
    mode: string;
    requested_model: string;
    repetitions?: number;
    scenario?: string;
    api_style?: string;
    reasoning_effort?: string;
  };
  report?: Report;
  error?: string;
  baseline_id?: string;
};
export type RunInput = {
  title: string;
  mode: string;
  requested_model: string;
  repetitions: number;
  api_style: string;
  reasoning_effort: string;
  scenario: string;
};
export type Suite = {
  version: string;
  count: number;
  probes: {
    id: string;
    category: string;
    title: string;
    prompt: string;
    expected: unknown;
  }[];
};
