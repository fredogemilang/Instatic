import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('self-host docker config', () => {
  it('defines app and postgres services', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8')
    expect(compose).toContain('app:')
    expect(compose).toContain('postgres:')
    expect(compose).toContain('postgres:16')
  })

  it('defines persistent postgres and uploads volumes', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8')
    expect(compose).toContain('postgres_data:')
    expect(compose).toContain('uploads:')
    expect(compose).toContain('/app/uploads')
  })

  it('documents required environment variables', () => {
    const env = readFileSync('.env.example', 'utf8')
    expect(env).toContain('DATABASE_URL=')
    expect(env).toContain('SESSION_SECRET=')
    expect(env).toContain('UPLOADS_DIR=')
  })

  it('defines a production Docker image that builds assets before runtime startup', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')

    expect(dockerfile).toContain('FROM oven/bun:1.3 AS build')
    expect(dockerfile).toContain('RUN bun run build')
    expect(dockerfile).toContain('FROM oven/bun:1.3 AS runtime')
    expect(dockerfile).toContain('CMD ["bun", "run", "server/index.ts"]')
    expect(dockerfile).not.toContain('vite build && bun run server/index.ts')
  })

  it('defines a production compose stack with health checks and persistent data', () => {
    const compose = readFileSync('compose.prod.yml', 'utf8')
    const buildOverride = readFileSync('compose.build.yml', 'utf8')

    expect(compose).toContain('ghcr.io/GITHUB_OWNER/IMAGE_NAME:latest')
    expect(compose).not.toContain('build:')
    expect(compose).toContain('restart: unless-stopped')
    expect(compose).toContain('condition: service_healthy')
    expect(compose).toContain('postgres_data:')
    expect(compose).toContain('uploads:')
    expect(compose).toContain('${SESSION_SECRET:?')
    expect(compose).toContain('${POSTGRES_PASSWORD:?')
    expect(buildOverride).toContain('build:')
    expect(buildOverride).toContain('dockerfile: Dockerfile')
  })

  it('documents production environment variables and deployment workflows', () => {
    const env = readFileSync('.env.production.example', 'utf8')
    const readme = readFileSync('README.md', 'utf8')
    const vpsDocs = readFileSync('docs/deployment/vps-compose.md', 'utf8')
    const managedDocs = readFileSync('docs/deployment/managed-hosts.md', 'utf8')
    const backupDocs = readFileSync('docs/deployment/backup-restore.md', 'utf8')
    const releaseDocs = readFileSync('docs/deployment/release-workflow.md', 'utf8')

    expect(env).toContain('POSTGRES_PASSWORD=')
    expect(env).toContain('SESSION_SECRET=')
    expect(readme).toContain('Self-hosted CMS')
    expect(vpsDocs).toContain('docker compose -f compose.prod.yml up -d')
    expect(vpsDocs).toContain('docker compose -f compose.prod.yml pull app')
    expect(vpsDocs).toContain('compose.build.yml')
    expect(managedDocs).toContain('DATABASE_URL')
    expect(backupDocs).toContain('pg_dump')
    expect(releaseDocs).toContain('GitHub Actions builds the Docker image')
    expect(releaseDocs).toContain('ghcr.io/GITHUB_OWNER/IMAGE_NAME')
  })
})
