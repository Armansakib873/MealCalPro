-- Run this in your Supabase SQL Editor to clean up orphaned meal records.
-- These are records that were incorrectly saved under cycle 20 (February) 
-- with meal_date = 2026-03-01 due to the tracker's cross-boundary save bug.
-- They all have 0 counts and are safe to delete.

DELETE FROM meals
WHERE cycle_id = 20
  AND meal_date = '2026-03-01';
