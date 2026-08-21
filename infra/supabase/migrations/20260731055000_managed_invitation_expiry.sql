-- Managed email invitations must remain usable long enough for a real client
-- onboarding workflow. Provider links and identity invitations stay pending
-- for seven days; acceptance still activates membership exactly once and every
-- existing revocation/expiry check remains authoritative.

begin;

create or replace function app_private.enforce_managed_invitation_expiry()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.invitation_id like 'auth-invite:%'
    and new.status = 'pending'
    and (
      new.expires_at is null
      or new.expires_at < clock_timestamp() + interval '7 days'
    )
  then
    new.expires_at := clock_timestamp() + interval '7 days';
  end if;
  return new;
end;
$$;

drop trigger if exists identity_invitations_managed_expiry
  on public.identity_invitations;
create trigger identity_invitations_managed_expiry
before insert or update of expires_at, status
on public.identity_invitations
for each row
execute function app_private.enforce_managed_invitation_expiry();

update public.identity_invitations
set expires_at = clock_timestamp() + interval '7 days',
    record_version = record_version + 1,
    updated_at = clock_timestamp()
where invitation_id like 'auth-invite:%'
  and status = 'pending'
  and deleted_at is null
  and expires_at < clock_timestamp() + interval '7 days';

commit;
