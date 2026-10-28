-- Disposable PostgreSQL compatibility harness only. This is not a Supabase stack.
-- Run only against a throwaway local database before applying the checked-in migrations.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$roles$;

create schema auth;
create schema storage;

create table auth.users (id uuid primary key);

create function auth.uid()
returns uuid
language sql
stable
as $function$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$function$;

grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  owner_id text,
  metadata jsonb,
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, service_role;
grant all on table storage.buckets, storage.objects to service_role;

