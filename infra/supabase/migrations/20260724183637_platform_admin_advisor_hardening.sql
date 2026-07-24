begin;

create index platform_administrators_created_by_idx
  on app_private.platform_administrators (created_by_auth_user_id)
  where created_by_auth_user_id is not null;

create policy platform_administrators_no_direct_access
  on app_private.platform_administrators
  for all
  to anon, authenticated
  using (false)
  with check (false);

commit;
