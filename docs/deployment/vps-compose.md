# VPS Deployment With Docker Compose

This is the easiest full self-host path. It runs the CMS app, Postgres, and uploaded media storage on one server.

## 1. Prepare The Server

Install Docker Engine and Docker Compose on the VPS. Point your domain to the server if you plan to put a reverse proxy in front of the app.

## 2. Download The Production Files

Create an install directory:

```sh
mkdir -p page-builder-cms
cd page-builder-cms
```

Download the production Compose and environment templates from the release source:

```sh
curl -fsSLO https://raw.githubusercontent.com/GITHUB_OWNER/GITHUB_REPO/main/compose.prod.yml
curl -fsSLO https://raw.githubusercontent.com/GITHUB_OWNER/GITHUB_REPO/main/.env.production.example
```

`GITHUB_OWNER` and `GITHUB_REPO` are placeholders until the public repository is renamed and published.

Before the project has a public GitHub repository/image, use the local repository files directly or build from source:

```sh
cp compose.prod.yml /path/on/server/compose.prod.yml
cp .env.production.example /path/on/server/.env.production.example
```

## 3. Create Production Environment

```sh
cp .env.production.example .env
```

Edit `.env` and replace:

```txt
PAGE_BUILDER_IMAGE=ghcr.io/GITHUB_OWNER/IMAGE_NAME:latest
POSTGRES_PASSWORD=replace-with-a-long-random-hex-password
SESSION_SECRET=replace-with-a-long-random-hex-secret
```

Generate safe values with:

```sh
openssl rand -hex 24
openssl rand -hex 32
```

## 4. Start The Stack

```sh
docker compose -f compose.prod.yml up -d
```

Check status:

```sh
docker compose -f compose.prod.yml ps
curl http://localhost:3001/health
```

Open:

```txt
http://server-ip:3001/admin
```

Create the first admin account in the browser.

## 5. View Logs

```sh
docker compose -f compose.prod.yml logs -f app
docker compose -f compose.prod.yml logs -f postgres
```

## 6. Update

Pull the latest published CMS image and recreate the app container:

```sh
docker compose -f compose.prod.yml pull app
docker compose -f compose.prod.yml up -d
```

Postgres and upload volumes stay attached.

## Build From Source Instead

Most users should pull the published image. Until the image exists, or when developing locally, build from a source checkout with:

```sh
docker compose -f compose.prod.yml -f compose.build.yml up -d --build
```

## Data Safety

`docker compose -f compose.prod.yml down` stops containers and keeps named volumes.

`docker compose -f compose.prod.yml down -v` deletes the Postgres database and uploaded media volumes. Use it only when you intentionally want to wipe the CMS.
