alter table jobs add column if not exists attempts integer not null default 0;
alter table jobs add column if not exists retry_at timestamptz;
