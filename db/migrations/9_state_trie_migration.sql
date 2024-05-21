alter type "7a0b4cc03e" add value if not exists 'statetriemigration' after 'confidentialasset';

alter type "0bf3c7d4ef" add value if not exists 'continue_migrate' after 'set_asset_frozen';
alter type "0bf3c7d4ef" add value if not exists 'control_auto_migration' after 'continue_migrate';
alter type "0bf3c7d4ef" add value if not exists 'force_set_progress' after 'control_auto_migration';
alter type "0bf3c7d4ef" add value if not exists 'migrate_custom_child' after 'force_set_progress';
alter type "0bf3c7d4ef" add value if not exists 'migrate_custom_top' after 'migrate_custom_child';
alter type "0bf3c7d4ef" add value if not exists 'set_signed_max_limits' after 'migrate_custom_top';
