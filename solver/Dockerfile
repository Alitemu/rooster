FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy solver code
COPY . .

# python:3.11-slim has no non-root user by default
RUN useradd --system --create-home --uid 1000 appuser \
    && chown -R appuser:appuser /app

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD python -c "import requests; requests.get('http://localhost:8000/health')"

USER appuser

# Start solver.
#
# 0.0.0.0 is required here, not an oversight: inside a container 127.0.0.1
# is the container's own loopback, so the web container could never reach
# it. Privacy comes from docker-compose.yml instead, which only `expose`s
# this port on the internal bridge network and never publishes it to the
# host. Running main.py directly (outside Docker) binds loopback instead -
# see the __main__ block there.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
