create table if not exists wa_chats (
  jid text primary key,
  name text not null default '',
  preview text not null default '',
  last_at timestamptz,
  unread integer not null default 0,
  is_group boolean not null default false
);

create table if not exists wa_messages (
  id text primary key,
  jid text not null,
  from_me boolean not null default false,
  sender text not null default '',
  body text not null default '',
  kind text not null default 'text',
  sent_at timestamptz not null
);

create index if not exists wa_messages_jid_idx on wa_messages (jid, sent_at desc);
