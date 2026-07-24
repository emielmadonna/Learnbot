"use client";

import { createBrowserClient } from "@supabase/ssr";
import { readSupabasePublicConfig } from "./config";

export function createBrowserSupabaseClient() {
  const config = readSupabasePublicConfig();
  return createBrowserClient(config.url, config.publishableKey);
}
