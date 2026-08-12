# Segue v0.7.0 — multi-stage: build the SPA, then run FastAPI serving it.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY server/requirements.txt ./
RUN pip install -r requirements.txt
COPY server/app ./app
COPY --from=web /web/dist ./web
# Persist sessions' oauth files, job checkpoints and the match cache.
VOLUME ["/app/data"]
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
