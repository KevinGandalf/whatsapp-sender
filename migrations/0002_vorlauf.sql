create table if not exists profiles (
  user_id text primary key,
  role text not null default 'user',
  display_name text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists contacts (
  id text primary key,
  name text not null,
  phone text not null,
  note text not null default '',
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists routines (
  id text primary key,
  owner_id text not null,
  title text not null,
  body text not null,
  frequency text not null,
  weekdays text not null default '',
  month_day integer not null default 1,
  time_local text not null,
  time_zone text not null default 'Europe/Berlin',
  recipients text not null,
  enabled boolean not null default true,
  next_run timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists routines_owner_idx on routines (owner_id);

create table if not exists jobs (
  id text primary key,
  owner_id text not null,
  routine_id text,
  title text not null,
  phone text not null,
  contact_name text not null default '',
  body text not null,
  send_at timestamptz not null,
  status text not null default 'queued',
  error text,
  dedupe_key text not null,
  sent_at timestamptz
);

create unique index if not exists jobs_dedupe_idx on jobs (dedupe_key);
create index if not exists jobs_owner_idx on jobs (owner_id);

create table if not exists org_settings (
  id text primary key,
  phone_number_id text not null default '',
  access_token text not null default '',
  country_code text not null default '49',
  time_zone text not null default 'Europe/Berlin'
);

insert into org_settings (id) values ('org') on conflict (id) do nothing;

create table if not exists calendar_rules (
  id text primary key,
  owner_id text not null,
  name text not null,
  enabled boolean not null default true,
  title_contains text not null default '',
  minutes integer not null default 15,
  anchor text not null default 'start',
  recipients text not null,
  template text not null
);

create index if not exists calendar_rules_owner_idx on calendar_rules (owner_id);

create table if not exists user_sources (
  user_id text primary key,
  source text not null default 'demo',
  graph_token text not null default '',
  graph_calendar_id text not null default '',
  ews_url text not null default 'https://outlook.office365.com/EWS/Exchange.asmx',
  ews_user text not null default '',
  ews_secret text not null default '',
  ews_auth text not null default 'basic',
  horizon_days integer not null default 14
);
