create table if not exists subquery_versions (
    id text not null,
    version text not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    PRIMARY KEY (id)
);
create index if not exists subquery_versions_pkey on subquery_versions using btree(id);
