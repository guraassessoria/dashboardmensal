import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tbl, isDev } from '@/lib/supabase'
import * as XLSX from 'xlsx'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ADMIN_PWD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || 'cbf2025'

// Páginas válidas do dashboard
const PAGINAS_VALIDAS = new Set([
  'overview', 'receitas', 'despesas', 'balanco', 'bp', 'indicadores', 'historico'
])

export async function POST(req: NextRequest) {
  const authCookie = req.cookies.get('admin_auth')
  if (!authCookie || authCookie.value !== ADMIN_PWD) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const periodo = formData.get('periodo') as string

    if (!file || !periodo) {
      return NextResponse.json({ error: 'Arquivo e período são obrigatórios' }, { status: 400 })
    }

    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext !== 'xlsx') {
      return NextResponse.json({ error: 'Apenas arquivos .xlsx são aceitos' }, { status: 400 })
    }

    // Ler xlsx
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' })

    const tabelas: { pagina: string; titulo: string; colunas: string[]; linhas: Record<string, any>[] }[] = []
    let erros: string[] = []

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) continue

      const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      if (rows.length < 2) continue // precisa de pelo menos header + 1 dado

      // Primeira linha = cabeçalhos
      const headerRow = rows[0].map((h: any) => String(h).trim())
      if (headerRow.length < 3) {
        erros.push(`Aba "${sheetName}": precisa de pelo menos 3 colunas (página, título, dados)`)
        continue
      }

      // Colunas de dados = a partir da 3ª coluna
      const dataCols = headerRow.slice(2).filter(h => h.length > 0)
      if (dataCols.length === 0) {
        erros.push(`Aba "${sheetName}": sem colunas de dados após página/título`)
        continue
      }

      // Processar linhas de dados agrupando por (pagina, titulo)
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]
        const pagina = String(row[0] || '').trim().toLowerCase()
        const titulo = String(row[1] || '').trim()

        if (!pagina || !titulo) continue

        if (!PAGINAS_VALIDAS.has(pagina)) {
          erros.push(`Linha ${i + 1}: página "${pagina}" inválida. Use: ${Array.from(PAGINAS_VALIDAS).join(', ')}`)
          continue
        }

        // Encontrar ou criar tabela para este (pagina, titulo)
        let tabela = tabelas.find(t => t.pagina === pagina && t.titulo === titulo)
        if (!tabela) {
          tabela = { pagina, titulo, colunas: dataCols, linhas: [] }
          tabelas.push(tabela)
        }

        // Montar linha de dados
        const linha: Record<string, any> = {}
        for (let c = 0; c < dataCols.length; c++) {
          const val = row[c + 2]
          linha[dataCols[c]] = val !== undefined && val !== '' ? val : null
        }
        tabela.linhas.push(linha)
      }
    }

    if (tabelas.length === 0) {
      return NextResponse.json({
        error: 'Nenhuma tabela válida encontrada. Verifique o formato: col1=página, col2=título, demais=dados.',
        erros
      }, { status: 400 })
    }

    // Upsert cada tabela no banco
    const tabelaName = isDev ? 'dev_tabelas_complementares' : 'tabelas_complementares'
    const resultados: string[] = []

    for (const tab of tabelas) {
      const { error } = await supabase
        .from(tabelaName)
        .upsert({
          periodo,
          pagina: tab.pagina,
          titulo: tab.titulo,
          colunas: tab.colunas,
          linhas: tab.linhas,
          filename: file.name,
          updated_at: new Date().toISOString()
        }, { onConflict: 'periodo,pagina,titulo' })

      if (error) {
        erros.push(`Erro ao salvar "${tab.titulo}" (${tab.pagina}): ${error.message}`)
      } else {
        resultados.push(`✅ ${tab.pagina}/${tab.titulo}: ${tab.linhas.length} linhas, ${tab.colunas.length} colunas`)
      }
    }

    return NextResponse.json({
      ok: true,
      tabelas: tabelas.length,
      resultados,
      erros: erros.length > 0 ? erros : undefined
    })

  } catch (err: any) {
    console.error('Erro no upload de tabela:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// GET: buscar tabelas complementares de um período
export async function GET(req: NextRequest) {
  const periodo = req.nextUrl.searchParams.get('periodo')
  const pagina = req.nextUrl.searchParams.get('pagina')

  const tabelaName = isDev ? 'dev_tabelas_complementares' : 'tabelas_complementares'

  let query = supabase
    .from(tabelaName)
    .select('id, periodo, pagina, titulo, colunas, linhas, filename, updated_at')
    .order('pagina')
    .order('titulo')

  if (periodo) query = query.eq('periodo', periodo)
  if (pagina) query = query.eq('pagina', pagina)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data || [])
}

// DELETE: remover tabela complementar por id
export async function DELETE(req: NextRequest) {
  const authCookie = req.cookies.get('admin_auth')
  if (!authCookie || authCookie.value !== ADMIN_PWD) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'ID obrigatório' }, { status: 400 })

  const tabelaName = isDev ? 'dev_tabelas_complementares' : 'tabelas_complementares'
  const { error } = await supabase.from(tabelaName).delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
