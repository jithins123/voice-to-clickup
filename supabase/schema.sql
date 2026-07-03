create table if not exists public.user_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  openai_api_key_enc text,
  clickup_api_token_enc text,
  clickup_list_id_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_credentials enable row level security;

drop policy if exists "Users can read their own credential status" on public.user_credentials;
create policy "Users can read their own credential status"
  on public.user_credentials
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own credentials" on public.user_credentials;
create policy "Users can insert their own credentials"
  on public.user_credentials
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own credentials" on public.user_credentials;
create policy "Users can update their own credentials"
  on public.user_credentials
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_credentials_touch_updated_at on public.user_credentials;
create trigger user_credentials_touch_updated_at
before update on public.user_credentials
for each row
execute function public.touch_updated_at();
