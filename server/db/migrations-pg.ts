import type { Migration } from './runMigrations'

export const pgMigrations: Migration[] = [
  {
    id: '001_cms_foundation',
    sql: `
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      );

      create table if not exists site (
        id text primary key default 'default',
        name text not null,
        settings_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists roles (
        id text primary key,
        slug text not null unique,
        name text not null,
        description text not null default '',
        is_system boolean not null default false,
        capabilities_json jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      insert into roles (id, slug, name, description, is_system, capabilities_json)
      values
        ('owner', 'owner', 'Owner', 'Permanent first-site owner with full system access.', true, '["site.read","site.edit","pages.edit","pages.publish","content.create","content.edit.own","content.edit.any","content.publish.own","content.publish.any","content.manage","media.manage","runtime.manage","plugins.manage","users.manage","roles.manage","audit.read"]'::jsonb),
        ('admin', 'admin', 'Admin', 'Full admin access.', true, '["site.read","site.edit","pages.edit","pages.publish","content.create","content.edit.own","content.edit.any","content.publish.own","content.publish.any","content.manage","media.manage","runtime.manage","plugins.manage","users.manage","roles.manage","audit.read"]'::jsonb),
        ('editor', 'editor', 'Editor', 'Can edit and publish assigned site content.', true, '["site.read","site.edit","pages.edit","pages.publish","content.create","content.edit.own","content.publish.own","media.manage"]'::jsonb),
        ('content-manager', 'content-manager', 'Content Manager', 'Can manage all content entries and collections.', true, '["site.read","content.create","content.edit.any","content.publish.any","content.manage","media.manage"]'::jsonb),
        ('viewer', 'viewer', 'Viewer', 'Read-only admin access.', true, '["site.read"]'::jsonb),
        ('subscriber', 'subscriber', 'Subscriber', 'Reserved for future public member accounts.', true, '[]'::jsonb)
      on conflict (id) do update
        set slug = excluded.slug,
            name = excluded.name,
            description = excluded.description,
            is_system = excluded.is_system,
            capabilities_json = excluded.capabilities_json,
            updated_at = current_timestamp;

      create table if not exists users (
        id text primary key,
        email text not null,
        email_normalized text not null,
        display_name text not null,
        password_hash text not null,
        status text not null default 'active',
        role_id text not null references roles(id) on delete restrict,
        last_login_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint users_status_check check (status in ('active', 'suspended'))
      );

      create unique index if not exists users_email_normalized_active_idx
        on users (email_normalized)
        where deleted_at is null;

      create unique index if not exists users_single_active_owner_idx
        on users (role_id)
        where role_id = 'owner' and status = 'active' and deleted_at is null;

      create table if not exists sessions (
        id_hash text primary key,
        user_id text not null references users(id) on delete cascade,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        ip_address text,
        user_agent text
      );

      create index if not exists sessions_user_idx
        on sessions (user_id, last_seen_at desc);

      create table if not exists audit_events (
        id text primary key,
        actor_user_id text references users(id) on delete set null,
        action text not null,
        target_type text,
        target_id text,
        metadata_json jsonb not null default '{}'::jsonb,
        ip_address text,
        user_agent text,
        created_at timestamptz not null default now()
      );

      create index if not exists audit_events_created_idx
        on audit_events (created_at desc);

      create table if not exists pages (
        id text primary key,
        title text not null,
        slug text not null unique,
        status text not null default 'draft',
        draft_document_json jsonb not null,
        active_version_id text,
        sort_order integer not null default 0,
        owner_user_id text references users(id) on delete set null,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists page_versions (
        id text primary key,
        page_id text not null references pages(id) on delete cascade,
        version integer not null,
        snapshot_json jsonb not null,
        published_at timestamptz not null default now(),
        published_by_user_id text references users(id) on delete set null,
        unique (page_id, version)
      );

      create table if not exists media_assets (
        id text primary key,
        filename text not null,
        mime_type text not null,
        size_bytes bigint not null,
        storage_path text not null,
        public_path text not null unique,
        uploaded_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now()
      );
    `,
  },
  {
    id: '002_page_sort_order',
    sql: `
      alter table pages
        add column if not exists sort_order integer not null default 0;
    `,
  },
  {
    id: '003_content_documents',
    sql: `
      create table if not exists content_collections (
        id text primary key,
        name text not null,
        slug text not null,
        route_base text not null default '',
        singular_label text not null,
        plural_label text not null,
        fields_json jsonb not null default '{"builtIn":{"body":true,"featuredMedia":true,"seo":true},"custom":[]}'::jsonb,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz
      );

      create unique index if not exists content_collections_slug_active_idx
        on content_collections (slug)
        where deleted_at is null;

      insert into content_collections (id, name, slug, route_base, singular_label, plural_label)
      values ('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts')
      on conflict (id) do update
        set name = excluded.name,
            slug = excluded.slug,
            route_base = excluded.route_base,
            singular_label = excluded.singular_label,
            plural_label = excluded.plural_label,
            updated_at = current_timestamp,
            deleted_at = null;

      create table if not exists content_entries (
        id text primary key,
        collection_id text not null references content_collections(id) on delete restrict,
        title text not null,
        slug text not null,
        status text not null default 'draft',
        body_markdown text not null default '',
        featured_media_id text references media_assets(id) on delete set null,
        seo_title text not null default '',
        seo_description text not null default '',
        author_user_id text references users(id) on delete set null,
        created_by_user_id text references users(id) on delete set null,
        updated_by_user_id text references users(id) on delete set null,
        published_by_user_id text references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        published_at timestamptz,
        deleted_at timestamptz,
        constraint content_entries_status_check check (status in ('draft', 'published', 'unpublished'))
      );

      create unique index if not exists content_entries_collection_slug_active_idx
        on content_entries (collection_id, slug)
        where deleted_at is null;

      create index if not exists content_entries_collection_idx
        on content_entries (collection_id, updated_at desc)
        where deleted_at is null;

      create table if not exists content_entry_versions (
        id text primary key,
        entry_id text not null references content_entries(id) on delete cascade,
        version_number integer not null,
        title text not null,
        slug text not null,
        body_markdown text not null,
        featured_media_id text references media_assets(id) on delete set null,
        seo_title text not null default '',
        seo_description text not null default '',
        published_by_user_id text references users(id) on delete set null,
        published_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        unique (entry_id, version_number)
      );

      create index if not exists content_entry_versions_entry_latest_idx
        on content_entry_versions (entry_id, version_number desc);
    `,
  },
  {
    id: '004_plugins_mvp',
    sql: `
      create table if not exists installed_plugins (
        id text primary key,
        name text not null,
        version text not null,
        enabled boolean not null default true,
        granted_permissions_json jsonb not null default '[]'::jsonb,
        manifest_json jsonb not null,
        installed_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists installed_plugins_enabled_idx
        on installed_plugins (enabled, installed_at desc);
    `,
  },
  {
    id: '005_plugin_records',
    sql: `
      create table if not exists plugin_records (
        id text primary key,
        plugin_id text not null references installed_plugins(id) on delete cascade,
        resource_id text not null,
        data_json jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists plugin_records_resource_idx
        on plugin_records (plugin_id, resource_id, created_at desc);
    `,
  },
  {
    id: '006_plugin_permission_grants',
    // `granted_permissions_json` is already present in the `installed_plugins`
    // CREATE TABLE in migration 004. Tracked no-op that records the schema
    // version step without touching DDL (the column was added retrospectively to
    // 004 during schema consolidation).
    sql: `SELECT 1`,
  },
  {
    id: '007_plugin_lifecycle_status',
    sql: `
      alter table installed_plugins
        add column if not exists lifecycle_status text not null default 'installed',
        add column if not exists last_error text;
    `,
  },
  {
    id: '008_content_collection_route_base',
    sql: `
      alter table content_collections
        add column if not exists route_base text not null default '';

      update content_collections
      set route_base = '/' || slug,
          updated_at = current_timestamp
      where coalesce(route_base, '') = '';
    `,
  },
  {
    id: '009_content_entry_active_version_and_redirects',
    sql: `
      alter table content_entries
        add column if not exists active_version_id text references content_entry_versions(id) on delete set null;

      update content_entries
      set active_version_id = latest_versions.id,
          updated_at = current_timestamp
      from (
        select distinct on (entry_id) id, entry_id
        from content_entry_versions
        order by entry_id, version_number desc
      ) latest_versions
      where content_entries.id = latest_versions.entry_id
        and content_entries.active_version_id is null
        and content_entries.status = 'published'
        and content_entries.deleted_at is null;

      create table if not exists content_entry_redirects (
        id text primary key,
        collection_id text not null references content_collections(id) on delete cascade,
        from_route_base text not null,
        from_slug text not null,
        target_entry_id text not null references content_entries(id) on delete cascade,
        created_at timestamptz not null default now()
      );

      create unique index if not exists content_entry_redirects_source_idx
        on content_entry_redirects (from_route_base, from_slug);

      create index if not exists content_entry_redirects_target_idx
        on content_entry_redirects (target_entry_id, created_at desc);
    `,
  },
  {
    id: '010_content_collection_fields',
    // `fields_json` is already present in the `content_collections` CREATE TABLE
    // in migration 003. Tracked no-op — see note on 006 above.
    sql: `SELECT 1`,
  },
  {
    id: '011_published_runtime_assets',
    sql: `
      create table if not exists published_runtime_assets (
        id text primary key,
        page_version_id text not null references page_versions(id) on delete cascade,
        asset_path text not null,
        public_path text not null unique,
        content_type text not null,
        content_bytes bytea not null,
        created_at timestamptz not null default now()
      );

      create index if not exists published_runtime_assets_page_version_idx
        on published_runtime_assets (page_version_id);
    `,
  },
]
