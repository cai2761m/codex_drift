import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Database,
  Download,
  FileJson,
  Fingerprint,
  FlaskConical,
  GitBranch,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { api, loadDemo } from "./api";
import type { Config, Report, Run, RunInput, Suite } from "./types";

type Page = "overview" | "history" | "suite" | "settings";
const categoryNames: Record<string, string> = {
  reasoning: "推理能力",
  coding: "代码理解",
  instruction: "指令遵循",
  context: "上下文检索",
};
const time = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
const num = (value: number | null | undefined, suffix = "") =>
  value == null
    ? "—"
    : value.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + suffix;
const short = (value: string) => value.slice(0, 8);

function Badge({ status, children }: { status: string; children?: ReactNode }) {
  const labels: Record<string, string> = {
    healthy: "观测正常",
    alert: "发现异常",
    watch: "需要复测",
    unknown: "证据不足",
    running: "检测中",
    queued: "等待中",
    failed: "检测失败",
    completed: "已完成",
  };
  return (
    <span className={"badge " + status}>
      <span />
      {children || labels[status] || status}
    </span>
  );
}

function Trend({ runs, baseline }: { runs: Run[]; baseline?: Run }) {
  const data = runs
    .filter((r) => r.report?.score != null)
    .slice(0, 16)
    .reverse();
  const width = 760,
    left = 44,
    right = 20,
    top = 20,
    height = 172;
  const x = (i: number) =>
    left + (i * (width - left - right)) / Math.max(data.length - 1, 1);
  const y = (value: number) => top + height * (1 - value / 100);
  const points = data
    .map((run, i) => `${x(i)},${y(run.report!.score!)}`)
    .join(" ");
  return (
    <div className="chart-wrap">
      <svg viewBox="0 0 760 232" role="img" aria-label="历史检测的得分趋势">
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b3ed70" stopOpacity=".2" />
            <stop offset="100%" stopColor="#b3ed70" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={width - right}
              y1={y(t)}
              y2={y(t)}
              stroke="#292d29"
              strokeDasharray="3 5"
            />
            <text x="0" y={y(t) + 4} fill="#737b72" fontSize="11">
              {t}
            </text>
          </g>
        ))}
        {baseline?.report?.score != null && (
          <g>
            <line
              x1={left}
              x2={width - right}
              y1={y(baseline.report.score)}
              y2={y(baseline.report.score)}
              stroke="#838f78"
              strokeDasharray="6 5"
            />
          </g>
        )}
        {data.length > 1 && (
          <>
            <polygon
              points={`${left},${y(0)} ${points} ${x(data.length - 1)},${y(0)}`}
              fill="url(#chart-fill)"
            />
            <polyline
              points={points}
              fill="none"
              stroke="#b3ed70"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
          </>
        )}
        {data.map((run, i) => (
          <g key={run.id}>
            <circle
              cx={x(i)}
              cy={y(run.report!.score!)}
              r="5"
              fill={run.report?.verdict === "alert" ? "#e4a568" : "#b3ed70"}
              stroke="#161a16"
              strokeWidth="3"
            >
              <title>
                {run.title}: {run.report!.score} 分
              </title>
            </circle>
            <text
              x={x(i)}
              y="224"
              textAnchor={
                i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"
              }
              fill="#828b81"
              fontSize="10"
            >
              {new Date(run.created_at).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              })}
            </text>
          </g>
        ))}
      </svg>
      {data.length === 0 && (
        <div className="chart-empty">
          <Activity size={24} />
          <p>等待第一组观测数据</p>
          <span>运行检测后，这里将呈现真实的得分变化</span>
        </div>
      )}
    </div>
  );
}

function RunTable({
  runs,
  baselineId,
  onSelect,
  onBaseline,
}: {
  runs: Run[];
  baselineId: string | null;
  onSelect: (run: Run) => void;
  onBaseline: (id: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>检测任务</th>
            <th>请求模型</th>
            <th>能力得分</th>
            <th>返回模型名</th>
            <th>状态</th>
            <th>检测时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.id}
              onClick={() => onSelect(run)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelect(run);
              }}
            >
              <td>
                <div className="task-cell">
                  <span className="task-icon">
                    {run.config.mode === "import" ? (
                      <FileJson size={16} />
                    ) : (
                      <FlaskConical size={16} />
                    )}
                  </span>
                  <div>
                    <strong>{run.title}</strong>
                    <small>
                      {run.config.mode === "demo"
                        ? "合成演示"
                        : run.config.mode === "import"
                          ? "会话导入"
                          : "真实 API"}{" "}
                      · {short(run.id)} {baselineId === run.id && <em>基线</em>}
                    </small>
                  </div>
                </div>
              </td>
              <td className="mono">{run.config.requested_model || "未提供"}</td>
              <td>
                <strong
                  className={
                    run.report?.score != null && run.report.score < 70
                      ? "text-amber"
                      : ""
                  }
                >
                  {num(run.report?.score)}
                </strong>
                <span className="muted"> / 100</span>
              </td>
              <td>
                <span
                  className={
                    "route-dot " + (run.report?.route.status || "unknown")
                  }
                />
                {run.report?.route.status === "mismatch"
                  ? "不一致"
                  : run.report?.route.status === "consistent"
                    ? "一致"
                    : "未确认"}
              </td>
              <td>
                <Badge
                  status={
                    run.status === "completed"
                      ? run.report?.verdict || "unknown"
                      : run.status
                  }
                />
              </td>
              <td className="muted date-cell">{time(run.created_at)}</td>
              <td>
                <button
                  className="icon-button"
                  aria-label={"设为基线：" + run.title}
                  title="设为基线"
                  disabled={
                    run.status !== "completed" ||
                    run.config.mode === "import" ||
                    !!run.report?.error_count
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onBaseline(run.id);
                  }}
                >
                  <Layers3 size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.length === 0 && (
        <div className="table-empty">
          暂无检测记录。点击「新建检测」开始收集证据。
        </div>
      )}
    </div>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "Tab") {
        const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary',
        );
        if (!elements?.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function NewRun({
  config,
  onClose,
  onCreate,
}: {
  config: Config | null;
  onClose: () => void;
  onCreate: (body: RunInput) => Promise<void>;
}) {
  const [body, setBody] = useState<RunInput>({
    title: "模型能力检测",
    mode: "demo",
    requested_model: "demo-codex",
    repetitions: 3,
    api_style: "responses",
    reasoning_effort: "default",
    scenario: "healthy",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (key: keyof RunInput, value: string | number) =>
    setBody((prev) => ({ ...prev, [key]: value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onCreate(body);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="新建检测"
      subtitle="固定测试集 · 确定性评分 · 可追溯证据"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="mode-picker">
          <button
            type="button"
            className={body.mode === "demo" ? "selected" : ""}
            onClick={() =>
              setBody({ ...body, mode: "demo", requested_model: "demo-codex" })
            }
          >
            <FlaskConical size={18} />
            本地演示<span>无需 API Key</span>
          </button>
          <button
            type="button"
            disabled={!config?.live_available}
            className={body.mode === "live" ? "selected" : ""}
            onClick={() =>
              setBody({
                ...body,
                mode: "live",
                requested_model:
                  config?.default_model === "demo-codex"
                    ? ""
                    : config?.default_model || "",
              })
            }
          >
            <Radio size={18} />
            真实 API
            <span>
              {config?.live_available ? "服务器凭据已配置" : "先配置服务器凭据"}
            </span>
          </button>
        </div>
        <label>
          任务名称
          <input
            value={body.title}
            maxLength={80}
            required
            onChange={(e) => update("title", e.target.value)}
          />
        </label>
        <label>
          请求模型
          <input
            className="mono"
            value={body.requested_model}
            maxLength={200}
            required
            placeholder="填写账号可用的模型 ID"
            onChange={(e) => update("requested_model", e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            接口类型
            <select
              value={body.api_style}
              onChange={(e) => update("api_style", e.target.value)}
            >
              <option value="responses">Responses API</option>
              <option value="chat">Chat Completions</option>
            </select>
          </label>
          <label>
            推理强度
            <select
              value={body.reasoning_effort}
              onChange={(e) => update("reasoning_effort", e.target.value)}
            >
              {[
                "default",
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-grid">
          <label>
            每项重复次数
            <select
              value={body.repetitions}
              onChange={(e) => update("repetitions", Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((v) => (
                <option key={v} value={v}>
                  {v} 次 · 共 {v * 8} 个请求
                </option>
              ))}
            </select>
          </label>
          {body.mode === "demo" && (
            <label>
              演示场景
              <select
                value={body.scenario}
                onChange={(e) => update("scenario", e.target.value)}
              >
                <option value="healthy">健康基线</option>
                <option value="degraded">能力下降</option>
                <option value="rerouted">返回模型名异常</option>
              </select>
            </label>
          )}
        </div>
        <div className="info-note">
          <CircleHelp size={16} />
          <span>
            {body.mode === "demo"
              ? "演示输出、耗时和模型名均为合成数据，不访问任何模型。"
              : `会发送 ${body.repetitions * 8} 次付费请求至服务器配置的接口。模型必须支持所选接口与参数。`}
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Zap size={16} />
            )}
            开始检测
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ImportModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (title: string, content: string, model: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("Codex 会话观测");
  const [model, setModel] = useState("");
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onImport(title, content, model);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="导入 Codex 会话"
      subtitle="支持 exec JSONL、rollout JSONL 与 API 响应记录"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label>
          记录名称
          <input
            value={title}
            required
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          预期模型（可选）
          <input
            className="mono"
            value={model}
            maxLength={200}
            onChange={(e) => setModel(e.target.value)}
            placeholder="不填写时不判断模型名是否匹配"
          />
        </label>
        <label className="file-drop">
          <Upload size={24} />
          <strong>{filename || "选择 JSON / JSONL 文件"}</strong>
          <span>最大 2 MiB · 仅保存白名单元数据</span>
          <input
            type="file"
            accept=".json,.jsonl,application/json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 2 * 1024 * 1024) {
                setError("文件不能超过 2 MiB");
                return;
              }
              setContent(await file.text());
              setFilename(file.name);
              setError("");
            }}
          />
        </label>
        <label>
          或直接粘贴 JSONL
          <textarea
            className="mono"
            rows={5}
            value={content}
            required
            onChange={(e) => setContent(e.target.value)}
            placeholder={
              '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}'
            }
          />
        </label>
        <div className="info-note">
          <ShieldCheck size={16} />
          <span>
            不会读取
            auth.json。会话配置不是实际路由证据，任意对话也不能直接评估能力下降。
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || !content.trim()}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Upload size={16} />
            )}
            分析记录
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function Detail({
  run,
  baselineId,
  onClose,
  onBaseline,
}: {
  run: Run;
  baselineId: string | null;
  onClose: () => void;
  onBaseline: (id: string) => void;
}) {
  const report = run.report;
  return (
    <Modal
      title={run.title}
      subtitle={`${time(run.created_at)} · ${run.config.mode === "demo" ? "合成演示" : run.config.mode === "live" ? "真实 API" : "会话导入"}`}
      onClose={onClose}
    >
      <div className="detail-meta">
        <Badge
          status={
            run.status === "completed"
              ? report?.verdict || "unknown"
              : run.status
          }
        />
        <code>{short(run.id)}</code>
        <a className="button small" href={`/api/runs/${run.id}/export`} download={`codex-drift-${run.id}.json`}>
          <Download size={14} />
          导出 JSON
        </a>
      </div>
      {run.error && <div className="form-error">{run.error}</div>}
      {report && (
        <>
          <div className="detail-stats">
            <div>
              <small>能力得分</small>
              <strong>{num(report.score)}</strong>
            </div>
            <div>
              <small>模型名异常</small>
              <strong>{report.route.mismatch_count}</strong>
            </div>
            <div>
              <small>有效请求</small>
              <strong>
                {report.valid_count} / {report.sample_count}
              </strong>
            </div>
          </div>
          <div className="evidence-box">
            <h3>{report.route.label}</h3>
            <p>{report.route.reason}</p>
            <div className="model-flow">
              <code>{run.config.requested_model || "未声明"}</code>
              <ArrowRight size={16} />
              <code>
                {report.route.observed_models.join(", ") || "无响应模型元数据"}
              </code>
            </div>
          </div>
          <div className="evidence-box">
            <h3>{report.comparison.label}</h3>
            <p>{report.comparison.reason}</p>
            {report.comparison.delta_ci95_pp && (
              <code>
                得分差 95% CI [{report.comparison.delta_ci95_pp.join(", ")}] pp
                · {report.comparison.paired_probes} 项配对测试
              </code>
            )}
          </div>
          {report.samples && report.samples.length > 0 && (
            <div className="sample-list">
              <h3>逐项检测证据</h3>
              {report.samples.map((sample, i) => (
                <details key={i}>
                  <summary>
                    <span>
                      {sample.error ? (
                        <X size={15} />
                      ) : sample.score === 1 ? (
                        <Check size={15} />
                      ) : (
                        <X size={15} />
                      )}
                    </span>
                    <strong>{sample.title}</strong>
                    <small>
                      第 {sample.repetition} 次 ·{" "}
                      {num(sample.latency_ms, " ms")}
                    </small>
                    <ChevronDown size={15} />
                  </summary>
                  <div className="sample-body">
                    <p>{sample.error || sample.grade_reason}</p>
                    <pre>{sample.output || "无输出"}</pre>
                    <div>
                      returned_model:{" "}
                      <code>{sample.returned_model || "null"}</code>
                    </div>
                    <div>
                      request_id: <code>{sample.request_id || "null"}</code>
                    </div>
                    <div>
                      reasoning_tokens:{" "}
                      <code>{sample.reasoning_tokens ?? "null"}</code>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          )}
          {report.import_summary && (
            <div className="evidence-box">
              <h3>会话元数据</h3>
              <p>
                {report.import_summary.record_count} 条事件 ·{" "}
                {report.import_summary.configuration_changes} 次配置变化
              </p>
              {report.import_summary.configurations.map((c, i) => (
                <p key={i} className="mono">
                  第 {c.line} 条 · {c.model} · {c.effort || "未声明推理配置"}
                </p>
              ))}
              {report.import_summary.responses.map((r, i) => (
                <p key={i} className="mono">
                  第 {r.line} 条 · {r.requested_model || "?"} →{" "}
                  {r.returned_model}
                  {r.mismatch ? " · 不匹配" : ""}
                </p>
              ))}
              <p>{report.import_summary.note}</p>
            </div>
          )}
        </>
      )}
      <p className="trace-line mono">trace_id: {run.trace_id}</p>
      <footer>
        <button className="button" onClick={onClose}>
          关闭
        </button>
        {run.config.mode !== "import" &&
          run.status === "completed" &&
          report?.error_count === 0 && (
            <button
              className="button primary"
              disabled={baselineId === run.id}
              onClick={() => onBaseline(run.id)}
            >
              <Layers3 size={16} />
              {baselineId === run.id ? "当前基线" : "设为基线"}
            </button>
          )}
      </footer>
    </Modal>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [runs, setRuns] = useState<Run[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [suite, setSuite] = useState<Suite | null>(null);
  const [modal, setModal] = useState<"new" | "import" | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [demoBusy, setDemoBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await api<{ runs: Run[]; baseline_id: string | null }>(
        "/runs",
      );
      setRuns(data.runs);
      setBaselineId(data.baseline_id);
      setConnected(true);
      setError("");
    } catch (e) {
      setConnected(false);
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    void api<Config>("/config")
      .then(setConfig)
      .catch(() => {});
    void api<Suite>("/benchmarks")
      .then(setSuite)
      .catch(() => {});
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!detail || !["queued", "running"].includes(detail.status)) return;
    const timer = setInterval(() => {
      void api<Run>("/runs/" + detail.id).then(setDetail).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [detail?.id, detail?.status]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function setBaseline(id: string) {
    try {
      await api("/baseline", "PUT", { run_id: id });
      await refresh();
      setToast("已保存基线，后续同配置检测会与其比较。");
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  async function select(run: Run) {
    try {
      setDetail(await api<Run>("/runs/" + run.id));
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  async function seedDemo() {
    setDemoBusy(true);
    try {
      await loadDemo();
      await refresh();
      setToast("已载入 4 次合成检测，并建立演示基线。");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setDemoBusy(false);
    }
  }
  const filtered = runs.filter(
    (r) =>
      (filter === "all" || r.config.mode === filter) &&
      `${r.title} ${r.config.requested_model} ${r.id}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const complete = filtered.filter((r) => r.status === "completed");
  const latest = complete.find((run) => run.report?.score != null) || complete[0];
  const report = latest?.report;
  const baseline = runs.find((r) => r.id === baselineId);
  const alerts = complete.filter((r) => r.report?.verdict === "alert").length;
  const selectedMode =
    filter === "all"
      ? "全部来源"
      : filter === "demo"
        ? "合成演示"
        : filter === "live"
          ? "真实 API"
          : "会话导入";
  const names: Record<Page, string> = {
    overview: "观测总览",
    history: "检测记录",
    suite: "测试集",
    settings: "连接与配置",
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("overview");
          }}
        >
          <span className="brand-mark">
            <Terminal size={21} />
          </span>
          <span>
            codex<span className="brand-slash">/</span>drift
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">D</span>
          <div>
            <strong>本地观测空间</strong>
            <small>模型行为实验室</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {(
            [
              { id: "overview", label: "观测总览", icon: LayoutDashboard },
              { id: "history", label: "检测记录", icon: Activity },
              { id: "suite", label: "测试集", icon: FlaskConical },
              { id: "settings", label: "连接与配置", icon: Settings2 },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={18} />
              {item.label}
              {item.id === "history" && (
                <span className="nav-count">{runs.length}</span>
              )}
              {page === item.id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="side-note">
            <Fingerprint size={20} />
            <strong>让判断有据可依</strong>
            <p>
              用重复观测识别变化，
              <br />
              用原始证据核查异常。
            </p>
            <button onClick={() => setPage("suite")}>
              了解检测方法 <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="sidebar-status">
            <span className={"connection-dot " + (connected ? "online" : "")} />
            <span>{connected ? "本地服务已连接" : "正在连接服务"}</span>
            <small>v0.1.0</small>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={13} />
            <span>{names[page]}</span>
          </div>
          <div className="topbar-right">
            <span className="local-tag">
              <ShieldCheck size={13} />
              Local first
            </span>
            <span className="avatar">CD</span>
          </div>
        </header>
        <div className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span />
                MODEL OBSERVABILITY
              </div>
              <h1>{names[page]}</h1>
              <p>
                {page === "overview"
                  ? "持续观测能力变化，追踪模型路由的可见证据。"
                  : page === "history"
                    ? "每一次检测都有记录，每一条结论都可追溯。"
                    : page === "suite"
                      ? "固定测试、明确答案，让能力变化可以比较。"
                      : "凭据保留在服务器，观测数据保留在你的空间。"}
              </p>
            </div>
            <div className="heading-actions">
              <button className="button" onClick={() => setModal("import")}>
                <Upload size={15} />
                导入会话
              </button>
              <button
                className="button primary"
                onClick={() => setModal("new")}
              >
                <Plus size={17} />
                新建检测
              </button>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error} <button onClick={() => void refresh()}>重新连接</button>
            </div>
          )}
          {(page === "overview" || page === "history") && (
            <>
              <div className="filter-bar">
                <div className="segmented">
                  {[
                    ["all", "全部观测"],
                    ["live", "真实 API"],
                    ["import", "Codex 会话"],
                    ["demo", "演示数据"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setFilter(id)}
                      className={filter === id ? "selected" : ""}
                    >
                      {label}
                      {id === "all" && <span>{runs.length}</span>}
                    </button>
                  ))}
                </div>
                <button
                  className="text-button"
                  onClick={() => void seedDemo()}
                  disabled={demoBusy}
                >
                  {demoBusy ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <FlaskConical size={14} />
                  )}{" "}
                  {demoBusy ? "生成演示中…" : "载入演示"}
                  <ArrowRight size={14} />
                </button>
              </div>
              {page === "overview" && (
                <>
                  <div className="notice">
                    <div>
                      <CircleHelp size={16} />
                      <p>
                        <strong>证据优先。</strong>
                        得分下降可提示能力变化；返回模型名可提示身份异常。两者都不能独立证明底层模型路由。
                      </p>
                    </div>
                  <span>{report?.mode === "demo" ? "最新结果 · 合成演示" : selectedMode}</span>
                  </div>
                  <div className="stats-grid">
                    <section className="stat-card">
                      <div className="stat-label">
                        最新能力得分
                        <FlaskConical size={17} />
                      </div>
                      <div className="stat-number">
                        {num(report?.score)}
                        <small>/ 100</small>
                      </div>
                      <div className="stat-foot">
                        {report?.comparison.drop_pp != null ? (
                          <>
                            <ArrowDownRight size={14} />
                            <span>
                              较基线{" "}
                              {report.comparison.drop_pp >= 0 ? "下降" : "上升"}{" "}
                              {Math.abs(report.comparison.drop_pp)} pp
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="tiny-dot" />
                            固定测试集 · {suite?.count || 8} 项探针
                          </>
                        )}
                      </div>
                    </section>
                    <section className="stat-card">
                      <div className="stat-label">
                        模型名异常
                        <GitBranch size={17} />
                      </div>
                      <div
                        className={
                          "stat-number " +
                          (report?.route.mismatch_count ? "text-amber" : "")
                        }
                      >
                        {num(report?.route.mismatch_count)}
                        <small>次 / 最新检测</small>
                      </div>
                      <div className="stat-foot">
                        <span
                          className={
                            "tiny-dot " +
                            (report?.route.mismatch_count ? "amber" : "")
                          }
                        />
                        {report?.route.label || "等待接口身份元数据"}
                      </div>
                    </section>
                    <section className="stat-card">
                      <div className="stat-label">
                        完整响应耗时
                        <Zap size={17} />
                      </div>
                      <div className="stat-number">
                        {report?.p50_ms == null
                          ? "—"
                          : num(report.p50_ms / 1000)}
                        <small>秒 · P50</small>
                      </div>
                      <div className="stat-foot">
                        P95{" "}
                        <span className="mono">
                          {report?.p95_ms == null
                            ? "—"
                            : num(report.p95_ms / 1000, " s")}
                        </span>
                        <span className="stat-foot-divider" />
                        含网络与排队
                      </div>
                    </section>
                    <section className="stat-card">
                      <div className="stat-label">
                        累计检测
                        <Activity size={17} />
                      </div>
                      <div className="stat-number">
                        {complete.length}
                        <small>次</small>
                      </div>
                      <div className="stat-foot">
                        <span
                          className={"tiny-dot " + (alerts ? "amber" : "")}
                        />
                        {alerts} 次异常信号
                        <span className="stat-foot-divider" />
                        {
                          filtered.filter((r) =>
                            ["queued", "running"].includes(r.status),
                          ).length
                        }{" "}
                        次进行中
                      </div>
                    </section>
                  </div>
                  <div className="charts-grid">
                    <section className="panel trend-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>能力得分趋势</h2>
                          <p>当前筛选下最近 16 次有效检测</p>
                        </div>
                        <div className="legend">
                          <span />
                          <small>检测得分</small>
                          <span className="baseline-line" />
                          <small>所选基线</small>
                        </div>
                      </div>
                      <Trend runs={filtered} baseline={baseline} />
                      <div className="chart-footer">
                        <span>
                          <span className="tiny-dot" />{" "}
                          {config?.suite_version || "core-v1"} · 分数范围 0–100
                        </span>
                        <span>
                          不同配置的趋势仅供浏览；退化判断按同配置配对
                        </span>
                      </div>
                    </section>
                    <section className="panel dimensions">
                      <div className="panel-heading">
                        <div>
                          <h2>能力维度</h2>
                          <p>最新完成检测的测试表现</p>
                        </div>
                        <SlidersHorizontal size={17} />
                      </div>
                      <div className="dimension-list">
                        {Object.entries(categoryNames).map(([key, label]) => (
                          <div key={key}>
                            <div className="dimension-label">
                              <span>{label}</span>
                              <strong>
                                {num(report?.categories[key])}
                                <small> / 100</small>
                              </strong>
                            </div>
                            <div className="progress-track">
                              <div
                                style={{
                                  width: `${report?.categories[key] || 0}%`,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="dimension-footer">
                        <Code2 size={14} />
                        <span>确定性校验 · 无模型裁判</span>
                      </div>
                    </section>
                  </div>
                  <div className="evidence-strip">
                    <div className="evidence-strip-icon">
                      <GitBranch size={21} />
                    </div>
                    <div>
                      <h3>
                        {report?.route.status === "mismatch"
                          ? "观察到返回模型名不一致"
                          : report?.comparison.status === "regression"
                            ? "观察到测试表现下降"
                            : "从观测走向可核查的证据"}
                      </h3>
                      <p>
                        {report?.route.status === "mismatch"
                          ? `请求 ${latest?.config.requested_model}，返回 ${report.route.observed_models.join(", ")}。请结合 request_id 向提供方核查。`
                          : report?.comparison.status === "regression"
                            ? report.comparison.reason
                            : "保存一组健康基线，再用相同配置复测；日志记录可以补充模型声明与配置变化。"}
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() =>
                        latest ? void select(latest) : setModal("new")
                      }
                    >
                      {latest ? "查看证据" : "开始建立基线"}
                      <ArrowUpRight size={16} />
                    </button>
                  </div>
                </>
              )}
              <section className="panel records-panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      {page === "overview" ? "最近检测" : "全部检测记录"}
                      <span className="count-chip">{filtered.length}</span>
                    </h2>
                    <p>
                      {page === "overview"
                        ? "查看结果、核查证据或保存为基线"
                        : "最多展示最近 100 次检测，可搜索名称、模型与 ID"}
                    </p>
                  </div>
                  <div className="table-actions">
                    {page === "history" ? (
                      <label className="search-input">
                        <Search size={15} />
                        <input
                          placeholder="搜索检测记录"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                    ) : (
                      <button
                        className="text-button"
                        onClick={() => setPage("history")}
                      >
                        查看全部
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                </div>
                <RunTable
                  runs={page === "overview" ? filtered.slice(0, 5) : filtered}
                  baselineId={baselineId}
                  onSelect={(run) => void select(run)}
                  onBaseline={(id) => void setBaseline(id)}
                />
              </section>
            </>
          )}
          {page === "suite" && (
            <>
              <div className="suite-intro">
                <div className="suite-icon">
                  <FlaskConical size={25} />
                </div>
                <div>
                  <h2>
                    Core evaluation suite{" "}
                    <code>{suite?.version || "core-v1"}</code>
                  </h2>
                  <p>
                    8 项基础探针，涵盖四个维度。每项返回纯
                    JSON，以参考答案精确校验。
                  </p>
                </div>
                <span className="pill">固定版本</span>
              </div>
              <div className="probe-grid">
                {suite?.probes.map((p, i) => (
                  <section className="panel probe-card" key={p.id}>
                    <div className="probe-header">
                      <span className="probe-number">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="pill">{categoryNames[p.category]}</span>
                    </div>
                    <h3>{p.title}</h3>
                    <p>{p.prompt}</p>
                    <div>
                      <small>参考答案</small>
                      <pre>{JSON.stringify(p.expected)}</pre>
                    </div>
                  </section>
                ))}
              </div>
              <div className="method-panel panel">
                <h2>如何解释检测结果</h2>
                <div className="method-grid">
                  <div>
                    <span>01</span>
                    <h3>建立同配置基线</h3>
                    <p>
                      模型、接口、推理强度、提供方和测试版本相同，才能比较。
                    </p>
                  </div>
                  <div>
                    <span>02</span>
                    <h3>按测试项配对</h3>
                    <p>
                      对探针聚类 bootstrap 4,000 次。下降 ≥10 pp 且 95%
                      区间上界小于 0，报告退化信号。
                    </p>
                  </div>
                  <div>
                    <span>03</span>
                    <h3>核查身份元数据</h3>
                    <p>
                      模型名不一致只代表元数据异常。服务端可能使用别名、快照或修改字段，需提供方证据确认路由。
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
          {page === "settings" && (
            <div className="settings-grid">
              <section className="panel settings-panel">
                <h2>
                  <Radio size={18} />
                  模型接口
                </h2>
                <dl>
                  <dt>凭据状态</dt>
                  <dd>
                    <Badge
                      status={config?.live_available ? "healthy" : "unknown"}
                    >
                      {config?.live_available
                        ? "服务器已配置"
                        : "未配置 API Key"}
                    </Badge>
                  </dd>
                  <dt>服务地址</dt>
                  <dd className="mono">{config?.provider_url || "—"}</dd>
                  <dt>默认模型</dt>
                  <dd className="mono">{config?.default_model || "—"}</dd>
                </dl>
                <p>
                  在服务器 .env 中设置 OPENAI_API_KEY、PROVIDER_BASE_URL 和
                  DEFAULT_MODEL 后重启分析服务。浏览器不接收或保存密钥。
                </p>
              </section>
              <section className="panel settings-panel">
                <h2>
                  <Database size={18} />
                  数据与追踪
                </h2>
                <dl>
                  <dt>持久化数据库</dt>
                  <dd>{config?.database || "—"}</dd>
                  <dt>OpenTelemetry 导出</dt>
                  <dd>
                    {config?.otel_export_enabled
                      ? "已启用 OTLP"
                      : "本地 trace ID；未开启导出"}
                  </dd>
                  <dt>当前基线</dt>
                  <dd>{baseline?.title || "尚未设置"}</dd>
                </dl>
                <p>
                  SQLite 可直接本地使用。Docker 的 postgres 配置支持
                  PostgreSQL；observability 配置提供 Collector 与 Jaeger。
                </p>
              </section>
              <section className="panel settings-panel full">
                <h2>
                  <ShieldCheck size={18} />
                  检测边界
                </h2>
                <p>
                  这个工具提供可复现的能力预警和服务端声明核查。回答风格、速度、token
                  用量与模型自我介绍都不足以确认真实模型身份。仅有 Codex
                  配置日志时，路由结论保持「证据不足」。
                </p>
                <div className="settings-links">
                  <a
                    href="https://developers.openai.com/api/reference/overview"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenAI API 元数据文档 <ArrowUpRight size={14} />
                  </a>
                  <a
                    href="https://learn.chatgpt.com/docs/non-interactive-mode"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Codex JSONL 文档 <ArrowUpRight size={14} />
                  </a>
                </div>
              </section>
            </div>
          )}
          <footer className="page-footer">
            <span>
              Codex Drift <span> / </span> Evidence before assumptions.
            </span>
            <span>
              <span
                className={"connection-dot " + (connected ? "online" : "")}
              />{" "}
              {connected ? "服务在线" : "服务离线"}{" "}
              <span className="footer-divider" /> 数据保存在本地
            </span>
          </footer>
        </div>
      </main>
      {modal === "new" && (
        <NewRun
          config={config}
          onClose={() => setModal(null)}
          onCreate={async (body) => {
            await api("/runs", "POST", body);
            await refresh();
            setToast("检测已开始，结果会自动更新。");
          }}
        />
      )}
      {modal === "import" && (
        <ImportModal
          onClose={() => setModal(null)}
          onImport={async (title, content, expected_model) => {
            await api("/import", "POST", { title, content, expected_model });
            await refresh();
            setToast("会话元数据已导入。");
          }}
        />
      )}
      {detail && (
        <Detail
          run={detail}
          baselineId={baselineId}
          onClose={() => setDetail(null)}
          onBaseline={(id) => void setBaseline(id)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
