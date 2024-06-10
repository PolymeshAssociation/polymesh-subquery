UPDATE extrinsics
SET extrinsic_hash = CONCAT('0x', extrinsic_hash)
WHERE extrinsic_hash NOT LIKE '0x%';