# Release And Image Publishing Workflow

The project is currently private and the final repository/package name is not locked. Production docs use placeholder names until the public GitHub repository is created.

Replace these placeholders before the first public release:

- `GITHUB_OWNER`: final GitHub user or organization.
- `GITHUB_REPO`: final repository name.
- `IMAGE_NAME`: final container package name.
- `APP_NAME`: final product/install directory name.

Recommended image naming:

```txt
ghcr.io/GITHUB_OWNER/IMAGE_NAME:latest
ghcr.io/GITHUB_OWNER/IMAGE_NAME:1.0.0
```

## Release Flow

1. Keep `main` releasable.
2. Merge feature work into `main`.
3. Create a version tag:

```sh
git tag v1.0.0
git push origin v1.0.0
```

4. GitHub Actions builds the Docker image from `Dockerfile`.
5. GitHub Actions pushes:

```txt
ghcr.io/GITHUB_OWNER/IMAGE_NAME:1.0.0
ghcr.io/GITHUB_OWNER/IMAGE_NAME:latest
```

6. GitHub release notes link to:

- `compose.prod.yml`
- `.env.production.example`
- deployment docs

7. Existing VPS installs update with:

```sh
docker compose -f compose.prod.yml pull app
docker compose -f compose.prod.yml up -d
```

## User Install Flow After Public Release

Users should not clone the repository for normal VPS installs. They download the Compose and env templates from GitHub and pull the published image:

```sh
mkdir -p APP_NAME
cd APP_NAME
curl -fsSLO https://raw.githubusercontent.com/GITHUB_OWNER/GITHUB_REPO/main/compose.prod.yml
curl -fsSLO https://raw.githubusercontent.com/GITHUB_OWNER/GITHUB_REPO/main/.env.production.example
cp .env.production.example .env
```

Then they edit `.env`:

```txt
PAGE_BUILDER_IMAGE=ghcr.io/GITHUB_OWNER/IMAGE_NAME:latest
POSTGRES_PASSWORD=<random hex password>
SESSION_SECRET=<random hex secret>
```

And start:

```sh
docker compose -f compose.prod.yml up -d
```

## Before Public Release

Until the GHCR image exists, local testing uses the source-build override:

```sh
docker compose -f compose.prod.yml -f compose.build.yml up -d --build
```

Or build and tag an image manually:

```sh
docker build -t ghcr.io/GITHUB_OWNER/IMAGE_NAME:dev .
PAGE_BUILDER_IMAGE=ghcr.io/GITHUB_OWNER/IMAGE_NAME:dev docker compose -f compose.prod.yml up -d
```

## GitHub Actions Shape

The release workflow should:

- run tests and build checks.
- log in to GitHub Container Registry with `GITHUB_TOKEN`.
- build `Dockerfile`.
- push a semver tag for `v*` tags.
- push `latest` for releases from `main`.

The exact workflow file should be added when the final repo owner/name is known, so package permissions and image visibility can be tested against the real GitHub organization.
