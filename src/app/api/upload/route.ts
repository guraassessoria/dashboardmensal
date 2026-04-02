import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Supabase não configurado no ambiente' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // Verificar autenticação
  const authCookie = req.cookies.get('admin_auth')
  if (!authCookie || authCookie.value !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const periodo = formData.get('periodo') as string
    const tipoDocumento = (formData.get('tipo_documento') as string) || 'dfs'

    if (!file || !periodo) {
      return NextResponse.json({ error: 'Arquivo e período são obrigatórios' }, { status: 400 })
    }

    // Validar tipo de arquivo
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!['xlsx', 'docx', 'csv'].includes(ext || '')) {
      return NextResponse.json({ error: 'Apenas arquivos xlsx, csv ou docx são aceitos' }, { status: 400 })
    }

    // Validar tamanho (max 50MB)
    if (file.size > 50 * 1024 * 1024) {
      return NextResponse.json({ error: 'Arquivo muito grande (máx 50MB)' }, { status: 400 })
    }

    // Path no Storage: uploads-cbf/2025-12/DFS_CBF_2025_V07.xlsx
    const timestamp = Date.now()
    const storagePath = `${periodo}/${timestamp}_${file.name}`

    // Upload para Supabase Storage
    const bytes = await file.arrayBuffer()
    const { error: storageError } = await supabase.storage
      .from('uploads-cbf')
      .upload(storagePath, bytes, {
        contentType: file.type,
        upsert: false
      })

    if (storageError) {
      throw new Error(`Erro no Storage: ${storageError.message}`)
    }

    // Registrar upload no banco
    const { data: uploadRecord, error: dbError } = await supabase
      .from('uploads')
      .insert({
        filename: file.name,
        file_type: ['csv'].includes(ext || '') ? 'xlsx' : ext,
        storage_path: storagePath,
        periodo,
        tipo_documento: tipoDocumento,
        status: 'pending'
      })
      .select()
      .single()

    if (dbError || !uploadRecord) {
      throw new Error(`Erro ao registrar: ${dbError?.message}`)
    }

    // Disparar Edge Function de processamento (assíncrono)
    const funcName = tipoDocumento === 'balancete' ? 'process-balancete' : 'process-upload'
    const edgeFunctionUrl = `${supabaseUrl}/functions/v1/${funcName}`
    
    fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({
        upload_id: uploadRecord.id,
        storage_path: storagePath,
        periodo,
        filename: file.name
      })
    }).catch(err => console.error('Erro ao disparar Edge Function:', err))
    // Não await — processamento é assíncrono

    return NextResponse.json({
      ok: true,
      upload_id: uploadRecord.id,
      message: 'Upload recebido. Processamento iniciado.'
    })

  } catch (err: any) {
    console.error('Erro no upload:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
