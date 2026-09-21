# Lightweight Python container for 24/7 Cloud Hosting
FROM python:3.9-slim

WORKDIR /app

# Copy requirements & install dependencies
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . /app

# Ensure write permissions for non-root containers (e.g. Hugging Face Spaces UID 1000)
RUN chmod -R 777 /app

# Expose standard web ports (8000 for standard/Render, 7860 for Hugging Face Spaces)
EXPOSE 8000
EXPOSE 7860

ENV PORT=8000
ENV PYTHONUNBUFFERED=1
ENV MALLOC_ARENA_MAX=2

# Start server
CMD ["python3", "server.py"]
