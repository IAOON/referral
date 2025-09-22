-- Fix position values to be consecutive for each user
-- This script will reorder positions to be 0, 1, 2, 3... for each user

-- First, let's see the current state
SELECT 'Current positions by user:' as info;
SELECT recommended_username, position, id, recommendation_text 
FROM recommendations 
ORDER BY recommended_username, position;

-- Update positions to be consecutive for each user
-- Using ROW_NUMBER() to assign new consecutive positions
UPDATE recommendations 
SET position = (
    SELECT new_pos - 1 
    FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY recommended_username ORDER BY position) as new_pos
        FROM recommendations r2 
        WHERE r2.recommended_username = recommendations.recommended_username
    ) ranked 
    WHERE ranked.id = recommendations.id
);

-- Verify the fix
SELECT 'Fixed positions by user:' as info;
SELECT recommended_username, position, id, recommendation_text 
FROM recommendations 
ORDER BY recommended_username, position;
