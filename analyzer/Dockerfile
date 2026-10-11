FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY drift ./drift
RUN uv sync --frozen --no-dev
EXPOSE 8001
CMD [".venv/bin/uvicorn", "drift.app:app", "--host", "0.0.0.0", "--port", "8001"]
