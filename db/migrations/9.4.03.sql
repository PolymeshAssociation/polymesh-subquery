-- events
alter type public_enum_8f5a39c8ee add value if not exists 'MetadataValueDeleted' after 'RegisterAssetMetadataGlobalType';
alter type public_enum_8f5a39c8ee add value if not exists 'LocalMetadataKeyDeleted' after 'MetadataValueDeleted';
alter type public_enum_8f5a39c8ee add value if not exists 'TransactionFeePaid' after 'ReserveRepatriated';
alter type public_enum_8f5a39c8ee add value if not exists 'Called' after 'ContractCodeUpdated';
alter type public_enum_8f5a39c8ee add value if not exists 'CallUnavailable' after 'CallLookupFailed';
alter type public_enum_8f5a39c8ee add value if not exists 'DelegateCalled' after 'Called';
alter type public_enum_8f5a39c8ee add value if not exists 'PeriodicFailed' after 'CallUnavailable';
alter type public_enum_8f5a39c8ee add value if not exists 'PermanentlyOverweight' after 'PeriodicFailed';
alter type public_enum_8f5a39c8ee add value if not exists 'PlaceholderFillBlock' after 'Remarked';
-- extrinsics
alter type public_enum_0bf3c7d4ef add value if not exists 'execute_scheduled_instruction_v2' after 'execute_scheduled_instruction';
alter type public_enum_0bf3c7d4ef add value if not exists 'placeholder_fill_block' after 'remark_with_event';
alter type public_enum_0bf3c7d4ef add value if not exists 'call_old_weight' after 'remove_code';
alter type public_enum_0bf3c7d4ef add value if not exists 'instantiate_with_code_old_weight' after 'call_old_weight';
alter type public_enum_0bf3c7d4ef add value if not exists 'instantiate_old_weight' after 'instantiate_with_code_old_weight';