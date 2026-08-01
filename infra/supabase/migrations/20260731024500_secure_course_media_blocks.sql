-- Secure, durable media blocks for authored lessons.
--
-- Media metadata uses the existing content_blocks table, course revision
-- snapshots, optimistic concurrency and audit ledger. No public bucket or
-- cross-tenant asset table is introduced. The browser route canonicalizes
-- URLs before calling these RPCs; this database validator is the independent
-- boundary for callers that invoke the authenticated RPC directly.

begin;

create or replace function app_private.authoring_safe_https_url(
  requested_url text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  url_host text;
begin
  if requested_url is null
    or length(requested_url) not between 8 and 2048
    or requested_url !~ '^https://'
    or requested_url ~ '[[:space:][:cntrl:]]'
    or lower(requested_url) ~ '%(00|0a|0d)'
  then
    return false;
  end if;

  url_host := lower(
    split_part(
      split_part(
        split_part(substring(requested_url from 9), '/', 1),
        '?',
        1
      ),
      '#',
      1
    )
  );

  return url_host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
    and position('.' in url_host) > 0
    and position('@' in url_host) = 0
    and position(':' in url_host) = 0
    and url_host <> 'localhost'
    and url_host !~ '(^|[.])localhost$'
    and url_host !~ '[.](internal|invalid|local|test)$'
    and url_host !~ '^0[.]'
    and url_host !~ '^10[.]'
    and url_host !~ '^127[.]'
    and url_host !~ '^169[.]254[.]'
    and url_host !~ '^172[.](1[6-9]|2[0-9]|3[01])[.]'
    and url_host !~ '^192[.](0|168)[.]'
    and url_host !~ '^198[.](18|19)[.]'
    and url_host !~ '^100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])[.]'
    and url_host !~ '^(22[4-9]|23[0-9]|24[0-9]|25[0-5])[.]';
end;
$$;

revoke execute on function app_private.authoring_safe_https_url(text)
  from public, anon, authenticated, service_role;

create or replace function app_private.authoring_valid_block(
  requested_block_type text,
  requested_content jsonb
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select requested_block_type in (
      'rich_text', 'heading', 'callout', 'code', 'quote', 'list', 'divider',
      'image', 'video', 'link'
    )
    and jsonb_typeof(requested_content) = 'object'
    and length(requested_content::text) <= 100000
    and case requested_block_type
      when 'rich_text' then
        jsonb_typeof(requested_content -> 'text') = 'string'
        and length(btrim(requested_content ->> 'text')) between 1 and 50000
      when 'image' then
        requested_content ?& array['url', 'altText', 'caption']
        and (requested_content - array['url', 'altText', 'caption']) = '{}'::jsonb
        and jsonb_typeof(requested_content -> 'url') = 'string'
        and app_private.authoring_safe_https_url(
          requested_content ->> 'url'
        )
        and jsonb_typeof(requested_content -> 'altText') = 'string'
        and length(btrim(requested_content ->> 'altText')) between 3 and 500
        and jsonb_typeof(requested_content -> 'caption') = 'string'
        and length(btrim(requested_content ->> 'caption')) between 0 and 1000
      when 'video' then
        requested_content ?& array['url', 'provider', 'title', 'caption']
        and (
          requested_content
            - array['url', 'provider', 'title', 'caption']
        ) = '{}'::jsonb
        and jsonb_typeof(requested_content -> 'url') = 'string'
        and app_private.authoring_safe_https_url(
          requested_content ->> 'url'
        )
        and jsonb_typeof(requested_content -> 'provider') = 'string'
        and (
          (
            requested_content ->> 'provider' = 'youtube'
            and requested_content ->> 'url'
              ~ '^https://www[.]youtube-nocookie[.]com/embed/[A-Za-z0-9_-]{11}$'
          )
          or (
            requested_content ->> 'provider' = 'vimeo'
            and requested_content ->> 'url'
              ~ '^https://player[.]vimeo[.]com/video/[0-9]{6,12}$'
          )
          or (
            requested_content ->> 'provider' = 'file'
            and lower(
              split_part(requested_content ->> 'url', '?', 1)
            ) ~ '[.](mp4|ogg|webm)$'
          )
        )
        and jsonb_typeof(requested_content -> 'title') = 'string'
        and length(btrim(requested_content ->> 'title')) between 1 and 160
        and jsonb_typeof(requested_content -> 'caption') = 'string'
        and length(btrim(requested_content ->> 'caption')) between 0 and 1000
      when 'link' then
        requested_content ?& array['url', 'label', 'description']
        and (
          requested_content - array['url', 'label', 'description']
        ) = '{}'::jsonb
        and jsonb_typeof(requested_content -> 'url') = 'string'
        and app_private.authoring_safe_https_url(
          requested_content ->> 'url'
        )
        and jsonb_typeof(requested_content -> 'label') = 'string'
        and length(btrim(requested_content ->> 'label')) between 1 and 160
        and jsonb_typeof(requested_content -> 'description') = 'string'
        and length(
          btrim(requested_content ->> 'description')
        ) between 0 and 1000
      else true
    end;
$$;

revoke execute on function app_private.authoring_valid_block(text, jsonb)
  from public, anon, authenticated, service_role;

-- Media blocks contribute only their human-authored learning context to
-- retrieval. The remote media URL/provider are deliberately excluded: an
-- assistant can use an image's alt text, a video's title, or a link's
-- description, but can never retrieve and repeat an opaque tracking URL.
create or replace function app_private.knowledge_block_text(
  block_type text,
  content jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  collected text;
begin
  if content is null
    or jsonb_typeof(content) <> 'object'
    or block_type = 'divider'
  then
    return null;
  end if;

  collected := concat_ws(
    E'\n\n',
    case
      when jsonb_typeof(content -> 'title') = 'string'
        then content ->> 'title'
    end,
    case
      when jsonb_typeof(content -> 'heading') = 'string'
        then content ->> 'heading'
    end,
    case
      when jsonb_typeof(content -> 'text') = 'string'
        then content ->> 'text'
    end,
    case
      when jsonb_typeof(content -> 'body') = 'string'
        then content ->> 'body'
    end,
    case
      when jsonb_typeof(content -> 'markdown') = 'string'
        then content ->> 'markdown'
    end,
    case
      when jsonb_typeof(content -> 'code') = 'string'
        then content ->> 'code'
    end,
    case
      when jsonb_typeof(content -> 'quote') = 'string'
        then content ->> 'quote'
    end,
    case
      when jsonb_typeof(content -> 'altText') = 'string'
        then content ->> 'altText'
    end,
    case
      when jsonb_typeof(content -> 'label') = 'string'
        then content ->> 'label'
    end,
    case
      when jsonb_typeof(content -> 'description') = 'string'
        then content ->> 'description'
    end,
    case
      when jsonb_typeof(content -> 'caption') = 'string'
        then content ->> 'caption'
    end,
    case
      when jsonb_typeof(content -> 'items') = 'array' then (
        select string_agg(
          case
            when jsonb_typeof(listed.item) = 'string' then listed.item #>> '{}'
            when jsonb_typeof(listed.item) = 'object'
              and jsonb_typeof(listed.item -> 'text') = 'string'
              then listed.item ->> 'text'
          end,
          E'\n' order by listed.item_index
        )
        from jsonb_array_elements(content -> 'items')
          with ordinality as listed(item, item_index)
      )
    end
  );

  if btrim(coalesce(collected, '')) = '' then
    select string_agg(
      fields.field_value #>> '{}',
      E'\n\n' order by fields.field_key
    )
    into collected
    from jsonb_each(content) as fields(field_key, field_value)
    where jsonb_typeof(fields.field_value) = 'string'
      and fields.field_key not in (
        'format', 'language', 'id', 'url', 'href', 'src', 'align', 'variant',
        'level', 'icon', 'tone', 'color', 'alt', 'startHms', 'sourceStart',
        'sourceLabel', 'provider'
      )
      and length(btrim(fields.field_value #>> '{}')) >= 2;
  end if;

  return left(app_private.knowledge_normalize_text(collected), 60000);
end;
$$;

revoke execute on function app_private.knowledge_block_text(text, jsonb)
  from public, anon, authenticated, service_role;

commit;
