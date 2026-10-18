-- Fix: admin SMS broadcast CSV import always failed with a Postgres 42P10 error
-- ("no unique or exclusion constraint matching the ON CONFLICT specification").
-- app/api/admin/sms-contacts/route.ts upserts into sms_contacts with
-- onConflict: 'group_id,phone_number', but no such unique constraint existed
-- (unlike the parallel sms_group_contacts table used by the dashboard contacts page).
ALTER TABLE sms_contacts
  ADD CONSTRAINT sms_contacts_group_id_phone_number_key UNIQUE (group_id, phone_number);
