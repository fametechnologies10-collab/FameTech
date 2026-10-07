-- Fametech schema snapshot: extensions
-- Source: read-only introspection of the original source production database (schema only, NO data).
-- Supabase-managed (pg_stat_statements, supabase_vault, plpgsql) are pre-enabled on new projects.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
-- Optional (advisor tooling only, not required by app code):
-- CREATE EXTENSION IF NOT EXISTS hypopg WITH SCHEMA extensions;
-- CREATE EXTENSION IF NOT EXISTS index_advisor WITH SCHEMA extensions;
