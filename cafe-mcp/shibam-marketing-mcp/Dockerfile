# Build context is cafe-mcp/ (Root Directory), not this directory, because
# mcp-common must be reachable. Railway: set this service's
# "Dockerfile Path" to shibam-marketing-mcp/Dockerfile and keep
# Root Directory = cafe-mcp.
FROM python:3.11-slim

WORKDIR /app

COPY mcp-common ./mcp-common
COPY shibam-marketing-mcp ./shibam-marketing-mcp

RUN pip install --no-cache-dir -r shibam-marketing-mcp/requirements.txt -e ./mcp-common

CMD ["python", "shibam-marketing-mcp/main.py"]
