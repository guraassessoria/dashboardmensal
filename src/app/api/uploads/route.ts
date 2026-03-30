import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey)
}

export async function GET() {
  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase não configurado no ambiente' }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('uploads')
    .select('id, filename, file_type, periodo, status, error_msg, uploaded_at, processed_at')
    .order('uploaded_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json([], { status: 500 })
  return NextResponse.json(data)
}
