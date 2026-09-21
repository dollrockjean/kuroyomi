# Lightweight Python container for 24/7 Cloud Hosting
FROM python:3.9-slim

WORKDIR /app

# Copy requirements & install dependencies
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . /app

# Expose standard web port
EXPOSE 8000

ENV PORT=8000
ENV PYTHONUNBUFFERED=1
ENV MALLOC_ARENA_MAX=2

# Start server
CMD ["python3", "server.py"]
