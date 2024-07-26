ALTER TABLE stat_types 
ADD COLUMN IF NOT EXISTS custom_claim_type_id TEXT;

-- add foreign key constraint only if historical state is not enabled
DO $$
BEGIN
    IF NOT EXISTS (select 1 from _metadata where key = 'historicalStateEnabled' and value = 'true') then
        ALTER TABLE stat_types 
            DROP CONSTRAINT IF EXISTS "stat_types_custom_claim_type_id_fkey";
        ALTER TABLE stat_types
            ADD CONSTRAINT "stat_types_custom_claim_type_id_fkey"
            FOREIGN KEY (custom_claim_type_id) REFERENCES custom_claim_types(id) ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE;
    END IF;
END
$$;
