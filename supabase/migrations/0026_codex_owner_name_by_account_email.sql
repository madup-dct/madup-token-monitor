create or replace function get_codex_account_limits()
returns table (
  account_id text,
  account_email text,
  owner_email text,
  owner_name text,
  plan_type text,
  windows jsonb,
  fetched_at timestamptz,
  updated_at timestamptz
)
language sql stable security definer set search_path = pg_catalog as $$
  select
    s.account_id,
    coalesce(nullif(trim(s.account_email), ''), s.account_id) as account_email,
    coalesce(nullif(trim(s.account_email), ''), s.account_id) as owner_email,
    coalesce(
      nullif(trim(account_profile.name), ''),
      coalesce(nullif(trim(s.account_email), ''), s.account_id)
    ) as owner_name,
    s.plan_type,
    s.windows,
    s.fetched_at,
    s.updated_at
  from public.codex_limit_snapshots s
  left join public.codex_owner o on o.account_id = s.account_id
  left join lateral (
    select pr.id, pr.name
    from auth.users account_user
    join public.profiles pr on pr.id = account_user.id
    where lower(trim(account_user.email)) = lower(nullif(trim(s.account_email), ''))
    order by account_user.created_at asc, account_user.id asc
    limit 1
  ) account_profile on true
  left join lateral (
    select pr.id
    from public.profiles pr
    where pr.email = o.owner_email
    order by pr.created_at asc, pr.id asc
    limit 1
  ) mapped_owner_profile on true
  where
    public.is_team_leader_or_above()
    or s.uploaded_by = auth.uid()
    or (o.account_id is null and public.are_team_mates(auth.uid(), s.uploaded_by))
    or mapped_owner_profile.id = auth.uid()
    or public.are_team_mates(auth.uid(), mapped_owner_profile.id)
$$;

revoke all on function get_codex_account_limits() from public;
grant execute on function get_codex_account_limits() to authenticated;
