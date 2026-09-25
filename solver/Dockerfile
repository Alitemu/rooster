FROM python:3.11-slim

# No .pyc files next to read-only code, and log lines straight out.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Every dependency comes as a ready-made wheel, so no compiler is needed
# (and none is left in the image). --only-binary makes a missing wheel
# fail the build instead of quietly compiling from source.
COPY requirements.txt .
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt

COPY . .

# Runs as its own user. The code stays owned by root: the solver writes no
# files, so it has no reason to be able to change its own code.
RUN useradd --system --no-create-home --uid 1000 appuser

EXPOSE 8000

# Fails on a refused connection and on any error status alike (urlopen
# raises for both), unlike a bare GET that only fails when nothing answers.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"

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
