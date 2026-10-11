# Codex Drift

本地优先的 Codex 能力变化与模型声明检测工具。**Rust + Python + TypeScript/React + SQLite/PostgreSQL + Docker + OpenTelemetry**。

主动调用兼容 API，以固定测试集对比健康基线；也可导入 Codex JSONL 或捕获的 API 响应。将能力退化、模型声明不一致与配置变化分别报告，并保留逐项答案、request ID 和 trace ID。

**工具不能从回答内容证明底层路由。** `model` 是服务端自报字段，中转可修改。字段一致不证明原模型，字段不一致也不自动证明偷偷换模。Codex `turn_context.model` 仅代表客户端配置。速度、token 数与模型自我介绍不能识别模型。

## 快速启动

### Docker（SQLite）

```sh
docker compose up --build -d
```

打开 http://localhost:3000，点击「载入演示」。生成健康基线、对照复测、能力下降与模型名异常四组**合成数据**。演示不需要密钥，不调用付费模型。数据库使用持久化卷。

### Windows 本地

需要 Rust 工具链及其 C 编译工具（MSVC Build Tools 或 MinGW）、Python ≥3.11、uv、Node.js 24。

```powershell
.\scripts\dev.ps1 -Build
# http://127.0.0.1:5173
.\scripts\stop.ps1
```

服务后台运行并将日志写入 `data/`。停止脚本仅停止此项目的服务并保留数据。本次开发环境的便携 Rust/MinGW 工具链在 `.tools/`，脚本会自动识别；此目录不属于分发代码。

Linux/macOS 可在三个终端分别运行（先 `uv sync --project analyzer` 和 `npm ci --prefix web`）：

```sh
# Terminal 1
cd analyzer && uv run uvicorn drift.app:app --host 127.0.0.1 --port 8001
# Terminal 2（项目根目录）
cargo run --manifest-path gateway/Cargo.toml
# Terminal 3
cd web && npm run dev
```

### 真实 API

复制 `.env.example` 为 `.env`，在**服务器**配置：

```dotenv
OPENAI_API_KEY=your-server-side-key
PROVIDER_BASE_URL=https://api.openai.com/v1
DEFAULT_MODEL=your-available-model-id
```

重启服务。Windows 脚本和 Docker Compose 会加载 `.env`；手动启动 Python 时须先导出这些变量到该进程环境。密钥不经过浏览器、不写入数据库或报告。不读取 Codex `auth.json` 或复用登录令牌。

「新建检测」选择真实 API，填写账号可用的模型 ID，选择 Responses 或 Chat Completions 及模型支持的推理参数。每次 8 × 重复次数（1–5）个请求，会产生提供方费用。接口失败、超时、拒绝或响应截断不会被当成能力失败；有接口错误的检测不作退化判定。不自动重试，以免重复计费。单请求超时默认 60 秒，可设置 `PROVIDER_TIMEOUT_SECONDS`。

## 解释结果

- **能力得分**：8 项确定性 JSON 校验，覆盖算术、约束推理、代码语义、边界、格式、提取、干扰检索和 SQL NULL。不执行模型生成的代码。严格格式失败也会失分。
- **能力退化信号**：以相同模型 ID、提供方 URL、接口、推理强度、模式和测试版本的基线配对。先将每项重复测试聚合，再按 8 个探针聚类 bootstrap 4,000 次。下降 ≥10 百分点且得分差的 95% 区间上界 <0，报告信号；否则下降只提示复测。
- **统计限制**：小型固定题集、模型随机性和训练数据污染限制推断。bootstrap 区间是测试得分差的不确定性，不是“换模概率”，不能代表通用智力。此初版没有完整代码执行、工具调用和长上下文任务评测。
- **模型名异常**：比较请求模型与响应 `model`；允许精确名称及其 `-YYYY-MM-DD` 快照。其他别名会被标记供人工核查；服务端自报字段可能不可信。
- **耗时与 tokens**：耗时是完整响应时间，包含网络和排队，不是首 token 时间。缓存与推理 token 在详情中展示；未返回字段保持 null。

先运行健康检测并「设为基线」，再复测。基线选择影响后续检测；历史报告保留当时的基线引用，不追溯改写。导入日志不能设为能力基线。基线可与当前筛选不同，检测时会明确报告配置不兼容。

## Codex 会话入口

在 Codex CLI 导出 JSONL，或者选择本机已有的 rollout JSONL：

```sh
codex exec --json "your task" > session.jsonl
```

在 UI 点击「导入会话」，选择文件或粘贴记录（最大 2 MiB）。支持 `turn_context` 配置、`turn.completed` 用量、`event_msg/token_count`、错误事件和显式 API 响应。仅保存白名单元数据，不存原始会话、用户提示、工具命令或认证字段。不同版本的未识别事件不会被臆造为身份信息；任意会话没有标准答案，因此能力得分为空。

若 JSONL 不包含响应 `model`，路由结论为「无法确认」。可用 `examples/codex-session.jsonl` 与 `examples/api-capture.jsonl` 试验。Token 事件可能重叠，不将导入用量观测合计当成账单。初版通过手动文件导入，不自动扫描或监视本机全部会话。

也可使用 `python scripts/import_session.py your-session.jsonl --model expected-model-id` 向本地服务导入明确指定的文件。

## PostgreSQL 与可观测性

```sh
docker compose -f compose.yaml -f compose.postgres.yaml up --build -d
docker compose -f compose.yaml -f compose.postgres.yaml -f compose.observability.yaml up --build -d
```

第二条同时启动 PostgreSQL、OTel Collector、Jaeger。追踪界面 http://localhost:16686。Rust 接收 W3C `traceparent`、创建网关 span、注入到 Python；Python FastAPI/HTTPX 插桩及测试 span 支持端到端追踪。API 响应含 `x-trace-id`，报告记录 trace ID。OTLP/HTTP 使用 `OTEL_EXPORTER_OTLP_ENDPOINT`（基地址，不含 `/v1/traces`）。未配置导出时仍生成本地 trace ID。

数据库切换使用 `DATABASE_URL`；SQLite 和 PostgreSQL 数据不会自动互相迁移。默认容器只将 Web 和 Jaeger 绑定本机地址。本版本是单用户本地工具，没有登录/租户隔离；公网部署需另行加认证。分析服务和数据库不暴露宿主机端口。

### Windows 本机容器验证

先按 [Docker Desktop Windows 官方安装指南](https://docs.docker.com/desktop/setup/install/windows-install/) 安装，选择 WSL 2 后端并启动 Linux 容器引擎。重新打开 PowerShell，确认 `docker version` 同时显示 Client 和 Server，`docker compose version` 可用。无需在 Windows 另外安装 PostgreSQL、Rust 或 Python。

```powershell
Set-Location D:\develop\codexDrift
.\scripts\verify_docker.ps1
# 同时启动 OTel Collector / Jaeger：
.\scripts\verify_docker.ps1 -Observability
```

脚本构建并启动容器，检查 `http://127.0.0.1:3000/api/health` 返回 `database=PostgreSQL` 且分析服务在线；在容器内运行冒烟检查，通过 Web → Rust → Python → PostgreSQL 验证健康基线、复测、退化、模型名异常、导入与 trace ID。随后直接查询 PostgreSQL 表，再重启数据库及网关，核对记录 ID 和基线仍然保留。**验证会新增 5 条合成记录并设置演示基线**，不调用付费 API。退出后容器继续运行。已有本地开发界面 5173 和 SQLite 数据与容器 3000 / PostgreSQL 分开。

Docker Desktop 首次初始化 Linux 引擎可能需要等待。脚本默认等候引擎最长 180 秒，每次 CLI 探测也有超时限制；仍未启动时才报错，并且不会开始项目容器操作。可用 `.\scripts\verify_docker.ps1 -EngineTimeoutSeconds 300` 延长等待。`docker desktop status` 可确认 Desktop 是 `starting` 还是 `running`。

脚本还检查 Docker 数据盘所在宿主机分区的剩余空间，构建前要求至少 5 GiB。Windows 默认数据盘在 `%LOCALAPPDATA%\Docker\wsl`；将项目放在 D 盘不会改变 Docker 数据盘的位置。配置中的 `DataFolder` / `DiskImageLocation` 可指定另一位置。若构建报 I/O 错误或 `read-only file system`，检查该分区是否已满；腾出空间后重启 Docker Desktop。也可通过 Docker Desktop Settings → Resources → Advanced 的 Disk image location 将现有数据盘迁到有足够空间的分区，迁移完成后重新验证。依据 [Docker WSL 2 数据位置说明](https://docs.docker.com/desktop/features/wsl/)。

若将整个 `%LOCALAPPDATA%\Docker` 改为指向其他盘的目录联接，WSL 可能在挂载 `main/ext4.vhdx` 时报告 `0x800701c0`（不受信任的装入点）。应保留原数据，恢复入口为真实目录，再通过 Docker Desktop 支持的磁盘位置设置进行迁移。本机已遇到并确认这一情形；恢复时先停止 Docker 和对应 WSL 分发，保存原目录联接与数据副本，并核对 VHDX 的 SHA-256。

使用 `-Observability` 时打开 http://127.0.0.1:16686，在 Jaeger 选择 `drift-gateway` 或 `drift-analyzer`，检查一次检测的跨服务追踪。脚本只检查该容器已启动，追踪展示需在 Jaeger 中确认。

启动失败时检查日志；停止时保留数据库卷：

```powershell
docker compose -f compose.yaml -f compose.postgres.yaml logs --tail 100 gateway analyzer postgres
docker compose -f compose.yaml -f compose.postgres.yaml down
# 若使用了可观测性覆盖文件，停止时也包含它：
docker compose -f compose.yaml -f compose.postgres.yaml -f compose.observability.yaml down
```

不要给 `down` 添加 `-v`，否则会删除持久化卷。上述操作不会自动迁移本地 SQLite 记录。修改 `.env` 中的 `POSTGRES_PASSWORD` 仅影响初始化新卷；已有 PostgreSQL 卷仍保留原密码。

若报 `dockerDesktopLinuxEngine` 管道不存在，表示 CLI 未连上 Docker Desktop Linux 引擎，尚未开始构建项目。先执行 `wsl --version`；若明确提示未安装 WSL，以管理员身份打开 PowerShell，运行 `wsl --install --no-distribution`，完成后按提示重启 Windows。Docker Desktop 不需要额外安装 Ubuntu。然后从开始菜单打开 Docker Desktop，确认使用 WSL 2 引擎并等待启动完成。`docker version` 应出现 Server 信息，再运行验证脚本。该步骤依据 [Microsoft WSL 安装命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands#install) 和 [Docker WSL 2 后端文档](https://docs.docker.com/desktop/features/wsl/)。

## 结构与接口

```text
web/          React + TypeScript，总览、任务、基线、导入、报告导出
gateway/      Rust/Axum，异步检测、SQLx 双数据库、W3C tracing
analyzer/     Python/FastAPI，API 适配、确定性评分、配对分析、日志提取
infra/        OTel Collector
scripts/      Windows 启停与端到端验证
examples/     无敏感内容的导入示例
```

网关 `/api/health`、`/api/config`、`/api/benchmarks`、`GET/POST /api/runs`、`GET /api/runs/{id}`、`GET /api/runs/{id}/export`、`PUT /api/baseline`、`POST /api/import`。真实调用只使用服务器配置的提供方地址。最多两项检测并发，任务后台执行，UI 每三秒刷新。列表显示最近 100 条，详情与导出包含完整逐项证据。重启会将尚未完成的进程内任务标记失败，需手动重跑。

## 验证

```sh
cd analyzer
uv run ruff check --config pyproject.toml drift tests
uv run pytest -q
cd ..
cargo test --locked --manifest-path gateway/Cargo.toml
cd web && npm run build
```

服务启动后，运行 `analyzer/.venv/Scripts/python.exe scripts/smoke.py`（Linux 使用 `.venv/bin/python`）。端到端验证仅使用合成数据，会增加 5 条演示记录并设定演示基线。

容器 Web 入口可指定为 `python scripts/smoke.py --base-url http://127.0.0.1:3000/api --expect-database PostgreSQL`。`verify_docker.ps1` 在分析容器内部执行此脚本，不依赖宿主机 Python。

`analyzer/.venv/Scripts/python.exe scripts/verify_otlp.py` 会启动隔离的 Rust/Python 进程与本地 OTLP 接收器，验证实际 protobuf 导出及跨服务父子 span。无真实模型调用，不改动主数据库。

接口字段依据 [OpenAI API 官方文档](https://developers.openai.com/api/reference/overview)、[Responses 参考](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)；JSONL 依据 [Codex 非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)。检测规则是本项目的启发式方法，不是 OpenAI 的模型身份认证机制。
#   c o d e x _ d r i f t  
 #   c o d e x _ d r i f t  
 