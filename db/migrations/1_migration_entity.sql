create table if not exists migrations (
    id text not null,
    "number" numeric not null,
    version text not null,
    executed boolean not null,
    processed_block integer not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    PRIMARY KEY (id)
);
create index if not exists migrations_pkey on migrations using btree(id);

