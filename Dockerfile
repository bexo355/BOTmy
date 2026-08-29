FROM python:3.9-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py .

# متغيرات البيئة
ENV PYTHONUNBUFFERED=1
ENV TMPDIR=/tmp

CMD ["python", "bot.py"]
