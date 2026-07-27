-- Ledger reconciliation for project fwilehggxqkpeuojxqzk
-- Prepared 2026-07-27. See infra/supabase/SCHEMA-DRIFT.md for the full record.
--
-- WHY THIS EXISTS
-- ---------------
-- supabase_migrations.schema_migrations and infra/supabase/migrations/ were
-- completely disjoint: 39 ledger rows, 56 repo migrations, ZERO versions in
-- common. Every ledger row was a generated 2026-07-24 timestamp; not one was a
-- repo filename version. `supabase db push` would therefore have treated all 56
-- repo migrations as unapplied and replayed them from 0001 against the live
-- database -- the exact full-replay failure SCHEMA-DRIFT.md exists to prevent.
--
-- After the nine 2026-07-24 bodies were recovered into the repo (commit
-- 1a0da7b) nine versions now match, leaving the 47 below to record.
--
-- WHAT WAS VERIFIED BEFORE WRITING THIS
-- -------------------------------------
-- Every one of the 56 repo migrations was confirmed already applied to the live
-- database. Nothing here is assumed from a filename.
--
--   * 47 migrations: every object they create was checked for existence --
--     350 objects (tables, views, functions across public and app_private).
--     Result: 350/350 present.
--
--   * 7 migrations create no new object (they patch a function body in place or
--     only move privileges), so each was checked for its own specific effect:
--       0013  auth_select_tenant           functiondef contains '#variable_conflict use_column'
--       0014  onboarding_update_tenant_profile  functiondef contains the qualified
--                                          'onboarding_update_tenant_profile.idempotency_key'
--       0015  onboarding_accept_invitation functiondef contains '#variable_conflict use_variable'
--       0016  functiondef contains 'on conflict on constraint identity_principals_pkey do nothing;'
--       0018  service_role does NOT have EXECUTE on learning_get_workspace()
--       0025  service_role does NOT have EXECUTE on learning_search_chunks_hybrid(...)
--             and authenticated DOES
--       20260724183637  index platform_administrators_created_by_idx exists
--                       and policy platform_administrators_no_direct_access exists
--     Result: all 7 true.
--
--   * 2 migrations (20260724212458, 20260724212646) were already in the ledger.
--
-- NOTE ON `statements`
-- --------------------
-- These rows are inserted with a NULL `statements` array, the same thing
-- `supabase migration repair --status applied` does. The ledger records that the
-- migration ran; the SQL itself lives in infra/supabase/migrations/. Do not read
-- a NULL here as "the body was lost".
--
-- Idempotent: `on conflict (version) do nothing`. Safe to re-run.

insert into supabase_migrations.schema_migrations (version, name)
select v, n from (values
  ('0001','extensions_and_security_helpers'),
  ('0002','tenants_and_learning_core'),
  ('0003','ingestion_and_knowledge'),
  ('0004','branding_progress_and_conversations'),
  ('0005','audit_cost_and_mcp'),
  ('0006','rls_policies_and_storage'),
  ('0007','durable_execution_primitives'),
  ('0008','identity_and_provisioning'),
  ('0009','durable_upload_intents'),
  ('0010','onboarding_control_plane'),
  ('0011','supabase_auth_tenant_bridge'),
  ('0012','authenticated_onboarding_rpcs'),
  ('0013','auth_select_tenant_ambiguity_fix'),
  ('0014','onboarding_profile_parameter_qualification'),
  ('0015','onboarding_invitation_name_resolution'),
  ('0016','onboarding_invitation_conflict_constraint'),
  ('0017','durable_learning_workspace'),
  ('0018','learning_rpc_service_role_boundary'),
  ('0019','preprovisioned_tenant_owner_claims'),
  ('0020','grounded_lexical_retrieval'),
  ('0021','durable_learning_conversations'),
  ('0022','learning_turn_replay'),
  ('0023','hybrid_semantic_retrieval'),
  ('0024','openai_embedding_provider'),
  ('0025','hybrid_rpc_execution_boundary'),
  ('0026','authenticated_quarantine_uploads'),
  ('0027','managed_access_and_usage_events'),
  ('0028','usage_event_membership_resolution'),
  ('20260724182939','platform_admin_control_plane'),
  ('20260724183637','platform_admin_advisor_hardening'),
  ('20260725120000','agent_configuration'),
  ('20260725121000','learning_analytics'),
  ('20260725122000','course_editing'),
  ('20260725123000','tenant_section_control'),
  ('20260726090000','platform_admin_client_provisioning'),
  ('20260726091000','question_intelligence'),
  ('20260726092000','authoring_publish_visibility'),
  ('20260726093000','widget_delivery'),
  ('20260726094000','widget_analytics'),
  ('20260726095000','authored_content_retrieval'),
  ('20260726096000','operational_safety'),
  ('20260726097000','agent_control_surface'),
  ('20260726098000','learner_signal_readout'),
  ('20260726099000','operational_debt'),
  ('20260726100000','billing_stripe'),
  ('20260726101000','character_avatars'),
  ('20260727090000','knowledge_ingestion_pipeline')
) as t(v, n)
on conflict (version) do nothing;

-- Expected afterwards: 39 + 47 = 86 rows, and every one of the 56 repo
-- migration versions present. Confirm with:
--
--   select count(*) as ledger_rows from supabase_migrations.schema_migrations;
--   -- expect 86
--
--   select count(*) as still_missing
--   from (values ('0001'),('20260727090000')) as t(v)   -- widen to all 56 to be thorough
--   where not exists (
--     select 1 from supabase_migrations.schema_migrations s where s.version = t.v
--   );
--   -- expect 0
