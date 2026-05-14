DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = '0bf3c7d4ef' 
          AND e.enumlabel = 'sumbit_unsigned'
    ) THEN
        ALTER TYPE "0bf3c7d4ef" RENAME VALUE 'sumbit_unsigned' TO 'submit_unsigned';
    END IF;
END $$;