import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Client com service role para operações server-side
export const supabaseAdmin = () =>
  createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Dev environment detection: Vercel preview = dev, production = prod
export const isDev = process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development'

// Table name resolver: prefixes with dev_ in dev/preview environments
// Shared tables (dashboard_users) are NOT prefixed
export function tbl(name: string): string {
  if (!isDev) return name
  const devTables = ['uploads', 'dados_financeiros', 'insights_gerados', 'configuracao']
  return devTables.includes(name) ? `dev_${name}` : name
}
