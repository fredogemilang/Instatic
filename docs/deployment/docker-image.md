# Production Docker Image

The production image is the portable Page Builder CMS artifact. It contains the built admin UI, the Bun server, the public renderer, CMS API routes, migrations, and runtime dependencies.

## Build Locally

```sh
docker build -t page-builder-cms:local .
```

The image does not run Vite or install dependencies at container startup. Those happen at image build time.

## Pull A Published Image

Once releases publish images, production servers should pull the image instead of building from source:

```sh
docker pull ghcr.io/GITHUB_OWNER/IMAGE_NAME:latest
```

Pin a version for predictable upgrades:

```sh
docker pull ghcr.io/GITHUB_OWNER/IMAGE_NAME:1.0.0
```

`GITHUB_OWNER` and `IMAGE_NAME` are placeholders until the public repository/package name is finalized.

## Run With An External Postgres Database

Use this mode for managed hosts or when you already operate Postgres separately.

```sh
docker run -d \
  --name page-builder-cms \
  -p 3001:3001 \
  -e DATABASE_URL="postgres://user:password@host:5432/page_builder" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e STATIC_DIR=/app/dist \
  -e UPLOADS_DIR=/app/uploads \
  -v page-builder-uploads:/app/uploads \
  --restart unless-stopped \
  ghcr.io/GITHUB_OWNER/IMAGE_NAME:latest
```

Then open:

```txt
http://localhost:3001/admin
```

## Required Runtime Variables

- `DATABASE_URL`: Postgres connection string.
- `SESSION_SECRET`: long random secret. Generate one with `openssl rand -hex 32`.
- `STATIC_DIR`: built asset directory. Use `/app/dist` in the Docker image.
- `UPLOADS_DIR`: upload directory. Use `/app/uploads` in the Docker image.
- `PORT`: optional. Defaults to `3001`; managed hosts may set this automatically.

## Health Check

```sh
curl http://localhost:3001/health
```

Expected response:

```json
{"status":"ok","ts":1234567890}
```
