import type { Run, RunInput } from "./types";
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("服务返回了无效响应，请检查网关是否启动。");
  }
  if (!response.ok)
    throw new Error(
      payload.error || payload.detail || `请求失败 (${response.status})`,
    );
  return payload as T;
}
export async function waitRun(id: string): Promise<Run> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const run = await api<Run>("/runs/" + id);
    if (run.status === "completed") return run;
    if (run.status === "failed") throw new Error(run.error || "检测失败");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("演示检测等待超时，稍后可在历史记录查看结果。");
}
export async function loadDemo() {
  const config: RunInput = {
    title: "健康基线 · 演示",
    mode: "demo",
    requested_model: "demo-codex",
    repetitions: 3,
    api_style: "responses",
    reasoning_effort: "default",
    scenario: "healthy",
  };
  const baseline = await waitRun((await api<Run>("/runs", "POST", config)).id);
  await api("/baseline", "PUT", { run_id: baseline.id });
  for (const [scenario, title] of [
    ["healthy", "对照复测 · 演示"],
    ["degraded", "能力下降 · 演示"],
    ["rerouted", "模型名异常 · 演示"],
  ]) {
    await waitRun(
      (await api<Run>("/runs", "POST", { ...config, scenario, title })).id,
    );
  }
}
