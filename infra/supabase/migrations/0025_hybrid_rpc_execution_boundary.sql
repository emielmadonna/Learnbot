-- Function creation grants PUBLIC execute by default. Restore the explicit
-- signed-in-only boundary after the provider wrapper introduced in 0024.

begin;

revoke execute on function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) to authenticated;
revoke execute on function public.learning_search_chunks_hybrid(
  text, extensions.vector, uuid, integer
) from service_role;

commit;
