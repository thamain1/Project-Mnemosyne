-- Project 4ward — 0005: memory chunking + ingestion run audit (Phase 1 ingestion rework)
-- Additive, re-runnable. Supports chunking long memory entries (Aegis 0002-#3) and auditable runs.

-- ── memory_chunks: per-chunk vectors for long entries (short entries keep memory_entries.embedding) ──
create table if not exists public.memory_chunks (
  id              uuid primary key default gen_random_uuid(),
  memory_entry_id uuid not null references public.memory_entries (id) on delete cascade,
  chunk_index     int  not null,
  content         text not null,
  embedding       vector(768),
  embedding_model text
);
do $$ begin
  alter table public.memory_chunks add constraint memory_chunks_entry_chunk_uniq unique (memory_entry_id, chunk_index);
exception when duplicate_table then null; when duplicate_object then null; end $$;
create index if not exists idx_memory_chunks_entry on public.memory_chunks (memory_entry_id);
create index if not exists memory_chunks_embedding_idx on public.memory_chunks using hnsw (embedding vector_cosine_ops);

-- ── ingestion_runs: auditable run records (counts for partial-failure / safe-retry) ──
create table if not exists public.ingestion_runs (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  status     text not null,                 -- success | partial | failed
  counts     jsonb not null default '{}',
  notes      text,
  started_at timestamptz not null default now()
);

-- ── RLS (consistent with the access model) ──
alter table public.memory_chunks  enable row level security;
alter table public.ingestion_runs enable row level security;

-- memory_chunks = knowledge data → team read/write (mirrors memory_entries)
drop policy if exists memory_chunks_team_all on public.memory_chunks;
create policy memory_chunks_team_all on public.memory_chunks for all
  using (public.is_team_member()) with check (public.is_team_member());
revoke truncate on public.memory_chunks from anon, authenticated;

-- ingestion_runs = audit record → team read; writes via service role only
drop policy if exists ingestion_runs_select on public.ingestion_runs;
create policy ingestion_runs_select on public.ingestion_runs for select using (public.is_team_member());
revoke insert, update, delete, truncate on public.ingestion_runs from anon, authenticated;
