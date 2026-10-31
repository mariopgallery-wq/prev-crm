import { createClient } from '@supabase/supabase-js';

// The URL and publishable key are public client-side configuration, not secrets.
// Database access is protected by RLS policies in SUPABASE_SETUP.sql.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://nzvzoamhtmucshsrarqq.supabase.co';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_iUva66izu3dw0ol8qzpaWA_i4JS1h2J';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  global: {
    headers: { 'X-Client-Info': 'preventivi-pro-react/2.0.0' },
  },
});
