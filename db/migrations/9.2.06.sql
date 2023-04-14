alter type public_enum_8f5a39c8ee add value if not exists 'MetadataValueDeleted' after 'RegisterAssetMetadataGlobalType';
alter type public_enum_8f5a39c8ee add value if not exists 'LocalMetadataKeyDeleted' after 'MetadataValueDeleted';
alter type public_enum_8f5a39c8ee add value if not exists 'TransactionFeePaid' after 'ReserveRepatriated';