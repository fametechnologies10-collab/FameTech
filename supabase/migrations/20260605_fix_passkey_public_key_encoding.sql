-- Fix corrupted passkey_credentials rows caused by Buffer.toJSON() serialization bug.
--
-- The register-verify route previously passed Buffer.from(credentialPublicKey) directly
-- to the Supabase insert. JSON.stringify called Buffer.prototype.toJSON(), producing
-- {"type":"Buffer","data":[...]} as text, which PostgreSQL stored as the ASCII bytes of
-- that JSON string instead of the raw COSE key bytes. Every credential registered before
-- this migration has an unrecoverable public_key and will never verify.
--
-- Clearing the table forces affected users to re-register their passkeys with the fixed route.

TRUNCATE public.passkey_credentials;
