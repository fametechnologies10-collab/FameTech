-- ============================================================
-- MoMo Reference Code Format Migration
-- Changes the reference_code constraint from exactly 5 uppercase
-- alphanumeric chars to a flexible word+number format (4-12 chars).
-- Run this in Supabase SQL Editor.
-- ============================================================

-- Step 1: Drop the old strict 5-char constraint
ALTER TABLE public.user_payment_references
    DROP CONSTRAINT IF EXISTS chk_reference_code_format;

-- Step 2: Add new flexible constraint (4-12 uppercase alphanumeric chars)
-- This allows formats like: BOOK45, 12GIFT, PAY100, RENT7 etc.
ALTER TABLE public.user_payment_references
    ADD CONSTRAINT chk_reference_code_format
    CHECK (reference_code ~ '^[A-Z0-9]{4,12}$');
