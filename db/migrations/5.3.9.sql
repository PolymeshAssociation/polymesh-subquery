alter table asset_documents alter column content_hash type jsonb using content_hash::jsonb;
create index asset_documents_content_hash on asset_documents using gin(content_hash);
