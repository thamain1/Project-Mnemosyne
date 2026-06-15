-- Project 4ward — 0004: embedding provenance (Phase 1 ingestion prep)
-- Additive, re-runnable. Pin the embedding model + source path alongside every vector so recall always
-- matches the same model and a future model upgrade is a clean, scripted re-embed.

alter table public.memory_entries  add column if not exists embedding_model text;
alter table public.memory_entries  add column if not exists source_path     text;
alter table public.document_chunks add column if not exists embedding_model text;
