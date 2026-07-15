# Single build file for the unified cafe-mcp server.
# Railway: Root Directory = cafe-mcp; Builder = Dockerfile (auto-detected
# since this file sits at the Root Directory root).
FROM python:3.11-slim

WORKDIR /app

# Dependency layers first for build caching
COPY requirements.txt ./
COPY mcp-common ./mcp-common
RUN pip install --no-cache-dir -r requirements.txt -e ./mcp-common

# Application code
COPY config.py main.py ./
COPY tools ./tools
COPY clients ./clients
COPY utils ./utils
COPY CafeMCP.com ./CafeMCP.com

CMD ["python", "main.py"]
