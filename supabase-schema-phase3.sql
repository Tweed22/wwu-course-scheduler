-- =========================================================================
-- WWU Course Scheduling — Phase 3 Migration
-- =========================================================================
-- Adds a `data jsonb` column to offerings and change_requests so the rich
-- client object (including arrays like changes[] and history[]) round-trips
-- cleanly without us having to maintain a column-per-field mapping.
--
-- Indexed columns (id, year, semester, subterm, status, submitted, etc.)
-- stay as-is — RLS policies still use them.  The data column is purely
-- additive and stores the full object.
--
-- Safe to re-run; uses IF NOT EXISTS.
-- =========================================================================

alter table public.offerings        add column if not exists data jsonb;
alter table public.change_requests  add column if not exists data jsonb;

-- An index on the data column isn't needed yet, but if queries get slow
-- later, individual jsonb path indexes can be added like:
--   create index on public.offerings ((data->>'instructor'));

-- Done.  Continue with the JS changes; nothing else to configure in the
-- dashboard for this phase.
