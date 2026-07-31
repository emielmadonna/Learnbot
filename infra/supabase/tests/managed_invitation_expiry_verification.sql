do $$
declare
  trigger_count integer;
begin
  select count(*) into trigger_count
  from pg_trigger
  where tgrelid = 'public.identity_invitations'::regclass
    and tgname = 'identity_invitations_managed_expiry'
    and not tgisinternal;

  if trigger_count <> 1 then
    raise exception 'managed invitation expiry trigger is missing';
  end if;

  if exists (
    select 1
    from public.identity_invitations
    where invitation_id like 'auth-invite:%'
      and status = 'pending'
      and deleted_at is null
      and expires_at < clock_timestamp() + interval '6 days 23 hours'
  ) then
    raise exception 'a managed pending invitation has less than seven days';
  end if;
end;
$$;
