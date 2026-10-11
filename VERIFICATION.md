# 验证记录

2026-10-04，Windows 本地开发环境。

| 范围 | 结果 |
| --- | --- |
| Python 评分、比较、日志提取、API 适配、W3C 上下文 | 31 项测试通过 |
| Rust SQLite 保存、基线、重启后中断任务恢复 | 2 项测试通过 |
| React/TypeScript | 类型检查及 Vite 生产构建通过 |
| Rust → Python → SQLite HTTP 链路 | 健康基线、退化、模型名异常、导入与基线拒绝规则通过 |
| OTel 实际导出 | 隔离进程向本地 OTLP/HTTP 接收器发送 protobuf，Rust/Python trace ID 与父子 span 匹配 |
| 浏览器交互 | 新建检测、自动刷新、逐项证据展开、JSONL 粘贴导入、JSON 文件下载通过 |
| 导出报告 | HTTP 200、JSON 内容、attachment 文件名与逐项样本核对通过 |

演示健康场景 100 分；合成退化场景 37.5 分、下降 62.5 pp。能力下降且模型名相同，与模型名不一致分别报告。导入任意会话的能力得分为空；仅有配置时路由未知。未调用真实付费模型。

尚未执行：本机没有 Docker 或 PostgreSQL 服务，容器构建、Compose 启动和 PostgreSQL 集成测试没有本机运行结果。仓库提供 PostgreSQL 集成测试及带 PostgreSQL 服务的 CI 配置；CI 尚未触发。

已补充 `scripts/verify_docker.ps1`：构建及启动 PostgreSQL 容器栈、HTTP 数据库类型确认、容器内部冒烟检查、SQL 表查询、数据库/网关重启后的记录与基线持久化核对。PowerShell 语法解析和缺少 Docker 的前置检查通过；冒烟脚本 URL 参数、Ruff 检查、对 SQLite 入口的 PostgreSQL 类型拒绝检查通过，拒绝时未改动记录或基线。这些检查不代表 Docker/PostgreSQL 已运行通过；本机目前仍缺少 Docker。

2026-10-10 更新：Docker CLI / Compose 已安装。PostgreSQL 及附加可观测性两个组合的 `docker compose config --quiet` 均通过。Linux 引擎尚不可用：Docker Desktop 进程未运行，`wsl --version` / `wsl --status` 明确报告 WSL 未安装，当前会话未提升管理员权限。因此容器构建和 PostgreSQL 运行验证仍未执行；需管理员安装 WSL、按提示重启并启动 Docker Desktop 后继续。

2026-10-11 更新：WSL 3.0.1、VirtualMachinePlatform 和 WSL Windows 功能已安装；硬件虚拟化已开启。Docker Desktop Linux 引擎首次初始化约 89 秒后达到 `running`，`docker info` 返回 `linux`。以 Windows PowerShell 5.1 执行容器验证，成功拉取 PostgreSQL 镜像并进入三项服务的镜像构建，但构建被 Docker 存储错误中断：C 盘剩余约 3 MB，默认数据 VHDX 位于 C 盘，WSL 内核日志出现 I/O 错误及 EXT4 文件系统重新挂载为只读。PostgreSQL 应用容器及端到端检查尚未完成，需要先恢复宿主机磁盘空间或迁移 Docker 数据盘。

验证脚本已加入引擎就绪等待（默认 180 秒、单次 CLI 探测最多 5 秒）和 Docker 数据盘分区的最小 5 GiB 空间检查。Windows PowerShell 5.1 语法和真实满盘阻止检查通过；模拟不存在的 Docker endpoint 时，2 秒超时检查通过，未进入容器操作。

真实 API 适配通过合成 HTTP 响应验证；接入用户账号及实际模型需要服务器 API Key。测试集为 8 项有限探针，其统计区间与元数据异常均不能证明底层路由。
