-- Tenant-scoped people visibility for workspace administrators.
-- Active memberships include owners created through bootstrap as well as
-- managed accounts. Pending invitations expose only display-safe metadata;
-- provider errors, invitation tokens, and acceptance secrets remain private.

begin;

create or replace function public.admin_list_access_accounts()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  accounts jsonb;
  pending_invitations jsonb;
  usage jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'authUserId', l.auth_user_id,
    'email', coalesce(lower(u.email), a.email_normalized, 'Verified identity'),
    'role', m.role,
    'status', m.status,
    'mustChangePassword', coalesce(a.must_change_password, false),
    'createdAt', coalesce(a.created_at, m.created_at),
    'passwordChangedAt', a.password_changed_at
  ) order by coalesce(a.created_at, m.created_at)), '[]'::jsonb)
  into accounts
  from public.identity_memberships m
  join app_private.supabase_auth_principal_links l
    on l.principal_id = m.principal_id
  join auth.users u
    on u.id = l.auth_user_id
  left join app_private.user_access_accounts a
    on a.auth_user_id = l.auth_user_id
   and a.tenant_id = m.tenant_id
   and a.principal_id = m.principal_id
  where m.tenant_id = caller.tenant_id
    and m.status = 'active'
    and m.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'email', pending.email_normalized,
    'displayName', pending.display_name,
    'role', pending.role,
    'status', 'pending',
    'sentAt', pending.sent_at,
    'expiresAt', pending.expires_at,
    'createdAt', pending.created_at
  ) order by pending.created_at desc), '[]'::jsonb)
  into pending_invitations
  from (
    select distinct on (d.email_normalized)
      d.email_normalized,
      d.display_name,
      d.role,
      d.sent_at,
      i.expires_at,
      d.created_at
    from app_private.auth_invitation_deliveries d
    join public.identity_invitations i
      on i.tenant_id = d.tenant_id
     and i.invitation_id = d.invitation_id
    where d.tenant_id = caller.tenant_id
      and d.status = 'sent'
      and i.status = 'pending'
      and i.deleted_at is null
      and i.expires_at > clock_timestamp()
    order by d.email_normalized, d.created_at desc
  ) pending;

  select jsonb_build_object(
    'last30Days',
    coalesce((
      select jsonb_object_agg(event_name, event_count)
      from (
        select event_name, count(*)::bigint as event_count
        from public.learning_usage_events
        where tenant_id = caller.tenant_id
          and occurred_at >= clock_timestamp() - interval '30 days'
        group by event_name
      ) counts
    ), '{}'::jsonb),
    'activeLearners',
    coalesce((
      select count(distinct principal_id)
      from public.learning_usage_events
      where tenant_id = caller.tenant_id
        and occurred_at >= clock_timestamp() - interval '30 days'
        and (
          event_name like 'learning.%'
          or event_name like 'conversation.%'
          or event_name like 'voice.%'
        )
    ), 0)
  )
  into usage;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'accounts', accounts,
    'pendingInvitations', pending_invitations,
    'usage', coalesce(usage, '{"last30Days":{},"activeLearners":0}'::jsonb)
  );
end;
$$;

revoke execute on function public.admin_list_access_accounts()
  from public, anon, service_role;
grant execute on function public.admin_list_access_accounts()
  to authenticated;

commit;
