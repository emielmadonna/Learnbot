-- The hosted service_role inherits execution through its role graph even after
-- PUBLIC is revoked. Keep learning entrypoints connection-bound to end-user
-- authentication by revoking it explicitly.

begin;

revoke execute on function public.learning_get_workspace()
  from service_role;
revoke execute on function public.learning_mark_lesson_progress(
  uuid, text, text
) from service_role;
revoke execute on function public.learning_create_course_draft(
  text, text, text, text, text, text
) from service_role;
revoke execute on function public.learning_publish_course(uuid, text)
  from service_role;

commit;
