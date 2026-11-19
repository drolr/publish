-- Data format barrier: schema14 programs must refuse databases that may contain V2 editor bodies.
-- No business rows or columns are changed by this migration.
SELECT 1;
