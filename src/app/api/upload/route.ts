import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tbl } from '@/lib/supabase'
import * as XLSX from 'xlsx'

// Vercel: Pro permite até 300s; Hobby é limitado a 60s (Vercel fará o cap automaticamente)
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'cbf_admin_token_2025'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

const ABAS_ALVO = [
  'BP', 'DRE', 'DFC', 'DMPL', 'DRA',
  '12.Receita Bruta', '13.Custos com futebol',
  '14.Despesas Operacionais', '15.Resultado Financeiro'
]
const BALANCETE_SHEET_NAMES = ['Balancete', 'balancete', 'BALANCETE', 'Balanc', '100.Balancete']
const MAX_CHARS = 40000

export async function POST(req: NextRequest) {
  const authCookie = req.cookies.get('admin_auth')
  if (!authCookie || authCookie.value !== AUTH_TOKEN) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  let uploadId = ''
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const periodo = formData.get('periodo') as string
    const tipoDocumento = (formData.get('tipo_documento') as string) || 'dfs'

    if (!file || !periodo) {
      return NextResponse.json({ error: 'Arquivo e período são obrigatórios' }, { status: 400 })
    }

    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!['xlsx', 'docx', 'csv'].includes(ext || '')) {
      return NextResponse.json({ error: 'Apenas arquivos xlsx, csv ou docx são aceitos' }, { status: 400 })
    }
    if (file.size > 50 * 1024 * 1024) {
      return NextResponse.json({ error: 'Arquivo muito grande (máx 50MB)' }, { status: 400 })
    }

    // ── Ler bytes do arquivo (uma vez, usado para storage e parsing) ──
    const bytes = await file.arrayBuffer()

    // ── Upload para Storage ──
    const timestamp = Date.now()
    const storagePath = `${periodo}/${timestamp}_${file.name}`
    const { error: storageError } = await supabase.storage
      .from('uploads-cbf')
      .upload(storagePath, bytes, { contentType: file.type, upsert: false })
    if (storageError) throw new Error(`Erro no Storage: ${storageError.message}`)

    // ── Registrar upload como 'processing' ──
    const { data: uploadRecord, error: dbError } = await supabase
      .from(tbl('uploads'))
      .insert({
        filename: file.name,
        file_type: ['csv'].includes(ext || '') ? 'xlsx' : ext,
        storage_path: storagePath,
        periodo,
        tipo_documento: tipoDocumento,
        status: 'processing'
      })
      .select()
      .single()
    if (dbError || !uploadRecord) throw new Error(`Erro ao registrar: ${dbError?.message}`)
    uploadId = uploadRecord.id

    // ── Parse xlsx com SheetJS (Node.js) ──
    const workbook = XLSX.read(new Uint8Array(bytes), { type: 'array' })

    const balanceteSheetName = workbook.SheetNames.find((n: string) =>
      BALANCETE_SHEET_NAMES.some(b => n.toLowerCase().includes(b.toLowerCase()))
    )
    const hasBalancete = !!balanceteSheetName

    const sheetText = xlsxToText(workbook, ABAS_ALVO)
    let balanceteText = ''
    if (hasBalancete) {
      balanceteText = balanceteToText(workbook, balanceteSheetName!, periodo)
    }
    const balanceteEfetivo = balanceteText.length > 200

    const textoCompleto = balanceteEfetivo ? sheetText + '\n\n' + balanceteText : sheetText
    console.log(`[upload] Texto ao Claude: ${textoCompleto.length} chars | balancete: ${balanceteEfetivo}`)

    const prompt = balanceteEfetivo
      ? buildHybridPrompt(periodo, file.name, balanceteSheetName!)
      : buildPrompt(periodo, file.name)

    // ── Chamar Claude ──
    const claudeCtrl = new AbortController()
    const claudeTimer = setTimeout(() => claudeCtrl.abort(), 50_000)
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      signal: claudeCtrl.signal,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `## CONTEÚDO DO ARQUIVO XLSX: ${file.name}\n\n${textoCompleto}\n\n---\n\n${prompt}` }]
        }]
      })
    })
    clearTimeout(claudeTimer)

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text()
      throw new Error(`Claude API error ${claudeResponse.status}: ${errText.slice(0, 200)}`)
    }

    const claudeData = await claudeResponse.json()
    const rawText = claudeData.content?.[0]?.text || ''
    const jsonMatch = rawText.match(/```json\n?([\s\S]*?)\n?```/) || rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('Claude não retornou JSON válido')

    const dadosExtraidos = JSON.parse(jsonMatch[1] || jsonMatch[0])

    // ── Merge com dados existentes ──
    const { data: existingRow } = await supabase
      .from(tbl('dados_financeiros'))
      .select('*')
      .eq('periodo', periodo)
      .single()

    const existingRaw = existingRow?.dados_raw || {}
    const mergedRaw = deepMerge(existingRaw, dadosExtraidos, 'incoming')
    mergedRaw._sources = {
      ...(existingRaw._sources || {}),
      dfs: { filename: file.name, processed_at: new Date().toISOString() },
      ...(hasBalancete ? { balancete: { filename: file.name, processed_at: new Date().toISOString(), embedded: true } } : {})
    }

    const pick = (incoming: any, existing: any) =>
      (incoming !== null && incoming !== undefined) ? incoming : existing

    const novosDados = {
      periodo,
      upload_id: uploadId,
      source_file: file.name,
      // DRE
      receita_bruta:          pick(dadosExtraidos.dre?.receita_bruta, existingRow?.receita_bruta),
      receita_liquida:        pick(dadosExtraidos.dre?.receita_liquida, existingRow?.receita_liquida),
      custos_futebol:         pick(dadosExtraidos.dre?.custos_futebol, existingRow?.custos_futebol),
      superavit_bruto:        pick(dadosExtraidos.dre?.superavit_bruto, existingRow?.superavit_bruto),
      despesas_operacionais:  pick(dadosExtraidos.dre?.despesas_operacionais, existingRow?.despesas_operacionais),
      resultado_financeiro:   pick(dadosExtraidos.dre?.resultado_financeiro, existingRow?.resultado_financeiro),
      resultado_exercicio:    pick(dadosExtraidos.dre?.resultado_exercicio, existingRow?.resultado_exercicio),
      // Receitas
      rec_patrocinio:         pick(dadosExtraidos.receitas?.patrocinio, existingRow?.rec_patrocinio),
      rec_transmissao:        pick(dadosExtraidos.receitas?.transmissao, existingRow?.rec_transmissao),
      rec_bilheteria:         pick(dadosExtraidos.receitas?.bilheteria, existingRow?.rec_bilheteria),
      rec_registros:          pick(dadosExtraidos.receitas?.registros, existingRow?.rec_registros),
      rec_desenvolvimento:    pick(dadosExtraidos.receitas?.desenvolvimento, existingRow?.rec_desenvolvimento),
      rec_academy:            pick(dadosExtraidos.receitas?.academy, existingRow?.rec_academy),
      rec_financeiras:        pick(dadosExtraidos.resultado_financeiro?.receitas_financeiras, existingRow?.rec_financeiras),
      // Custos
      custo_selecao_principal: pick(dadosExtraidos.custos_futebol?.selecao_principal, existingRow?.custo_selecao_principal),
      custo_selecao_base:      pick(dadosExtraidos.custos_futebol?.selecoes_base, existingRow?.custo_selecao_base),
      custo_selecao_femininas: pick(dadosExtraidos.custos_futebol?.selecoes_femininas, existingRow?.custo_selecao_femininas),
      custo_fomento:           pick(dadosExtraidos.custos_futebol?.fomento, existingRow?.custo_fomento),
      // Despesas
      desp_pessoal:           pick(dadosExtraidos.despesas?.pessoal, existingRow?.desp_pessoal),
      desp_administrativas:   pick(dadosExtraidos.despesas?.administrativas, existingRow?.desp_administrativas),
      desp_impostos_taxas:    pick(dadosExtraidos.despesas?.impostos_taxas, existingRow?.desp_impostos_taxas),
      // Resultado financeiro
      res_fin_receitas:       pick(dadosExtraidos.resultado_financeiro?.receitas_financeiras, existingRow?.res_fin_receitas),
      res_fin_despesas:       pick(dadosExtraidos.resultado_financeiro?.despesas_financeiras, existingRow?.res_fin_despesas),
      res_fin_cambial:        pick(dadosExtraidos.resultado_financeiro?.variacao_cambial, existingRow?.res_fin_cambial),
      // Balanço
      ativo_total:            pick(dadosExtraidos.balanco?.ativo_total, existingRow?.ativo_total),
      ativo_circulante:       pick(dadosExtraidos.balanco?.ativo_circulante, existingRow?.ativo_circulante),
      caixa_equivalentes:     pick(dadosExtraidos.balanco?.caixa_equivalentes, existingRow?.caixa_equivalentes),
      contas_receber:         pick(dadosExtraidos.balanco?.contas_receber, existingRow?.contas_receber),
      tributos_recuperar:     pick(dadosExtraidos.balanco?.tributos_recuperar, existingRow?.tributos_recuperar),
      depositos_judiciais:    pick(dadosExtraidos.balanco?.depositos_judiciais, existingRow?.depositos_judiciais),
      imobilizado:            pick(dadosExtraidos.balanco?.imobilizado, existingRow?.imobilizado),
      passivo_circulante:     pick(dadosExtraidos.balanco?.passivo_circulante, existingRow?.passivo_circulante),
      receitas_diferidas_cp:  pick(dadosExtraidos.balanco?.receitas_diferidas_cp, existingRow?.receitas_diferidas_cp),
      receitas_diferidas_lp:  pick(dadosExtraidos.balanco?.receitas_diferidas_lp, existingRow?.receitas_diferidas_lp),
      prov_contingencias:     pick(dadosExtraidos.balanco?.prov_contingencias, existingRow?.prov_contingencias),
      patrimonio_liquido:     pick(dadosExtraidos.balanco?.patrimonio_liquido, existingRow?.patrimonio_liquido),
      patrimonio_social:      pick(dadosExtraidos.balanco?.patrimonio_social, existingRow?.patrimonio_social),
      fornecedores:           pick(dadosExtraidos.balanco?.fornecedores, existingRow?.fornecedores),
      obrig_trabalhistas:     pick(dadosExtraidos.balanco?.obrig_trabalhistas, existingRow?.obrig_trabalhistas),
      adiantamentos:          pick(dadosExtraidos.balanco?.adiantamentos, existingRow?.adiantamentos),
      intangivel:             pick(dadosExtraidos.balanco?.intangivel, existingRow?.intangivel),
      resultado_acumulado:    pick(dadosExtraidos.balanco?.resultado_acumulado, existingRow?.resultado_acumulado),
      despesas_antecipadas:   pick(dadosExtraidos.balanco?.despesas_antecipadas, existingRow?.despesas_antecipadas),
      contas_receber_lp:      pick(dadosExtraidos.balanco?.contas_receber_lp, existingRow?.contas_receber_lp),
      investimentos:          pick(dadosExtraidos.balanco?.investimentos, existingRow?.investimentos),
      programas_desenvolvimento: pick(dadosExtraidos.balanco?.programas_desenvolvimento, existingRow?.programas_desenvolvimento),
      provisao_ferias:        pick(dadosExtraidos.balanco?.provisao_ferias, existingRow?.provisao_ferias),
      fornecedores_lp:        pick(dadosExtraidos.balanco?.fornecedores_lp, existingRow?.fornecedores_lp),
      // DRE complementar
      outras_receitas_op:     pick(dadosExtraidos.dre?.outras_receitas, existingRow?.outras_receitas_op),
      outras_despesas_op:     pick(dadosExtraidos.dre?.outras_despesas, existingRow?.outras_despesas_op),
      resultado_antes_ir:     pick(dadosExtraidos.dre?.resultado_antes_ir, existingRow?.resultado_antes_ir),
      ir_csll:                pick(dadosExtraidos.dre?.ir_csll, existingRow?.ir_csll),
      // DFC
      fluxo_operacional:      pick(dadosExtraidos.dfc?.fluxo_operacional, existingRow?.fluxo_operacional),
      fluxo_investimento:     pick(dadosExtraidos.dfc?.fluxo_investimento, existingRow?.fluxo_investimento),
      variacao_caixa:         pick(dadosExtraidos.dfc?.variacao_total, existingRow?.variacao_caixa),
      // JSON completo
      dados_raw: mergedRaw,
      updated_at: new Date().toISOString()
    }

    const { error: upsertError } = await supabase
      .from(tbl('dados_financeiros'))
      .upsert(novosDados, { onConflict: 'periodo' })
    if (upsertError) throw new Error(`Erro ao salvar dados: ${upsertError.message}`)

    // Atualizar configuração de período atual
    await supabase
      .from(tbl('configuracao'))
      .upsert({ chave: 'periodo_atual', valor: periodo, updated_at: new Date().toISOString() })

    // Marcar como concluído
    await supabase
      .from(tbl('uploads'))
      .update({ status: 'done', processed_at: new Date().toISOString() })
      .eq('id', uploadId)

    // Disparar rebuild no Vercel
    const vercelHook = process.env.VERCEL_DEPLOY_HOOK
    if (vercelHook) {
      fetch(vercelHook, { method: 'POST' }).catch(() => {})
    }

    console.log(`[upload] ✅ Processamento concluído — ${periodo}`)
    return NextResponse.json({ ok: true, upload_id: uploadId, periodo, status: 'done' })

  } catch (err: any) {
    console.error('[upload] Erro:', err.message)
    if (uploadId) {
      await supabase
        .from(tbl('uploads'))
        .update({ status: 'error', error_msg: err.message?.slice(0, 500) })
        .eq('id', uploadId)
        .then(() => {}, () => {})
    }
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function xlsxToText(workbook: XLSX.WorkBook, prioritySheets?: string[]): string {
  const parts: string[] = []
  let totalChars = 0
  const ordered: string[] = []
  if (prioritySheets) {
    for (const prio of prioritySheets) {
      const lower = prio.toLowerCase()
      for (const name of workbook.SheetNames) {
        if (!ordered.includes(name) && (name === prio || name.toLowerCase() === lower)) {
          ordered.push(name)
        }
      }
    }
  }
  for (const name of workbook.SheetNames) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  for (const name of ordered) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t', blankrows: false })
    if (!csv.trim()) continue
    const lines = csv.split('\n')
    const truncated = lines.length > 500 ? lines.slice(0, 500).join('\n') + '\n[... truncado]' : csv
    if (totalChars + truncated.length > MAX_CHARS) {
      parts.push(`### Aba: ${name}\n[Aba omitida - limite de caracteres atingido]`)
      continue
    }
    parts.push(`### Aba: ${name}\n${truncated}`)
    totalChars += truncated.length
  }
  return parts.join('\n\n')
}

function balanceteToText(workbook: XLSX.WorkBook, sheetName: string, periodo: string): string {
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return ''
  const [ano, mes] = periodo.split('-')
  const month = parseInt(mes)
  const year = parseInt(ano)
  const lastDay = new Date(year, month, 0).getDate()
  const periodoBalancete = `${month}/${lastDay}/${String(year).slice(2)}`
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '|', blankrows: false })
  const lines = csv.split('\n')
  const headerLine = lines.find(l => l.includes('Período') || l.includes('Conta'))
  const filtradas = lines.filter(l => {
    const cols = l.split('|')
    return cols[1] === periodoBalancete && /\|S\|/.test(l)
  })
  if (filtradas.length === 0) return ''
  const header = headerLine ? headerLine + '\n' : ''
  return `### Aba: ${sheetName} (período ${periodoBalancete}, contas sintéticas)\n${header}${filtradas.join('\n')}`
}

function deepMerge(existing: any, incoming: any, sourcePriority: 'incoming' | 'existing' = 'incoming'): any {
  if (incoming === null || incoming === undefined) return existing
  if (existing === null || existing === undefined) return incoming
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    if (sourcePriority === 'incoming') return (incoming !== null && incoming !== undefined) ? incoming : existing
    if (existing !== null && existing !== undefined && existing !== 0) return existing
    return (incoming !== null && incoming !== undefined && incoming !== 0) ? incoming : existing
  }
  const result: any = { ...existing }
  for (const [key, val] of Object.entries(incoming)) {
    if (key === '_sources') continue
    result[key] = deepMerge(existing[key], val, sourcePriority)
  }
  return result
}

function buildPrompt(periodo: string, filename: string): string {
  const [ano, mes] = periodo.split('-')
  const dataRef = `${mes}/${ano}`
  return `Você é um especialista em demonstrações financeiras brasileiras.
Analise os dados acima extraídos do arquivo xlsx das Demonstrações Financeiras da CBF (arquivo: ${filename}, período: ${periodo}).

Extraia TODOS os dados numéricos das seguintes abas: BP, DRE, DFC, e Notas 12, 13, 14 e 15.
Os valores estão em R$ milhares.

## IMPORTANTE — COLUNAS
Use SEMPRE a PRIMEIRA coluna numérica após "Nota" (período ${dataRef}).
- Na aba DRE: use a coluna "${dataRef.split('/')[1]}/${String(parseInt(dataRef.split('/')[1])+1).slice(-2)}" ou a primeira coluna de dados
- Na aba BP: use a primeira coluna de dados (período corrente)

## RESULTADO FINANCEIRO
Na DRE, a seção "Resultado Financeiro" fica ENTRE "Total das despesas operacionais" e "Outros Resultados Operacionais".
Contém: Receitas Financeiras, Despesas Financeiras, Variação Cambial, Total. NÃO retorne null para estes campos.

Retorne APENAS um JSON válido:
\`\`\`json
{
  "periodo": "${periodo}", "fonte": "${filename}",
  "dre": { "receita_bruta": 0, "deducoes": 0, "receita_liquida": 0, "custos_futebol": 0,
    "superavit_bruto": 0, "despesas_operacionais": 0, "resultado_financeiro": 0,
    "outras_receitas": 0, "outras_despesas": 0, "resultado_antes_ir": 0, "ir_csll": 0, "resultado_exercicio": 0 },
  "receitas": { "patrocinio": 0, "transmissao": 0, "bilheteria": 0, "registros": 0, "desenvolvimento": 0, "academy": 0, "legado": 0 },
  "custos_futebol": { "selecao_principal": 0, "selecoes_base": 0, "selecoes_femininas": 0, "fomento": 0 },
  "despesas": { "pessoal": 0, "administrativas": 0, "impostos_taxas": 0 },
  "resultado_financeiro": { "receitas_financeiras": 0, "despesas_financeiras": 0, "variacao_cambial": 0, "total": 0 },
  "balanco": {
    "ativo_total": 0, "ativo_circulante": 0, "caixa_equivalentes": 0, "contas_receber": 0,
    "tributos_recuperar": 0, "adiantamentos": 0, "despesas_antecipadas": 0, "contas_receber_lp": 0,
    "depositos_judiciais": 0, "investimentos": 0, "imobilizado": 0, "intangivel": 0,
    "passivo_circulante": 0, "fornecedores": 0, "programas_desenvolvimento": 0, "obrig_trabalhistas": 0,
    "provisao_ferias": 0, "receitas_diferidas_cp": 0, "receitas_diferidas_lp": 0, "fornecedores_lp": 0,
    "prov_contingencias": 0, "patrimonio_social": 0, "resultado_acumulado": 0, "patrimonio_liquido": 0 },
  "dfc": { "fluxo_operacional": 0, "fluxo_investimento": 0, "variacao_total": 0, "saldo_inicial": 0, "saldo_final": 0 },
  "competicoes": [{ "nome": "Brasileiro Série A", "valor_2025": 0, "valor_2024": 0 }]
}
\`\`\`
Use os valores exatos do arquivo. Se um campo não existir, use null.
Para "competicoes", liste todas as competições da Nota 13.`
}

function buildHybridPrompt(periodo: string, filename: string, balanceteSheetName: string): string {
  const [ano, mes] = periodo.split('-')
  const dataRef = `${mes}/${ano}`
  return `Você é um especialista em demonstrações financeiras brasileiras.
Analise os dados acima extraídos do arquivo xlsx das Demonstrações Financeiras da CBF (arquivo: ${filename}, período: ${periodo}).

Este arquivo contém TANTO as Demonstrações Financeiras (BP, DRE, DFC, Notas) QUANTO uma aba de Balancete ("${balanceteSheetName}").

### Das abas de DFs (BP, DRE, DFC, Notas 12-15): use a PRIMEIRA coluna numérica (período ${dataRef}). Valores em R$ milhares.
### Da aba Balancete: use para COMPLEMENTAR e VALIDAR os totais das DFs.
### Prioridade: para campos consolidados (DRE, balanço, DFC) use as DFs; balancete só para detalhamento.

## RESULTADO FINANCEIRO
Na DRE, seção "Resultado Financeiro" entre "Total das despesas operacionais" e "Outros Resultados Operacionais".

Retorne APENAS um JSON válido:
\`\`\`json
{
  "periodo": "${periodo}", "fonte": "${filename}",
  "dre": { "receita_bruta": 0, "deducoes": 0, "receita_liquida": 0, "custos_futebol": 0,
    "superavit_bruto": 0, "despesas_operacionais": 0, "resultado_financeiro": 0,
    "outras_receitas": 0, "outras_despesas": 0, "resultado_antes_ir": 0, "ir_csll": 0, "resultado_exercicio": 0 },
  "receitas": { "patrocinio": 0, "transmissao": 0, "bilheteria": 0, "registros": 0, "desenvolvimento": 0, "academy": 0, "legado": 0 },
  "custos_futebol": { "selecao_principal": 0, "selecoes_base": 0, "selecoes_femininas": 0, "fomento": 0 },
  "despesas": { "pessoal": 0, "administrativas": 0, "impostos_taxas": 0 },
  "resultado_financeiro": { "receitas_financeiras": 0, "despesas_financeiras": 0, "variacao_cambial": 0, "total": 0 },
  "balanco": {
    "ativo_total": 0, "ativo_circulante": 0, "caixa_equivalentes": 0, "contas_receber": 0,
    "tributos_recuperar": 0, "adiantamentos": 0, "despesas_antecipadas": 0, "contas_receber_lp": 0,
    "depositos_judiciais": 0, "investimentos": 0, "imobilizado": 0, "intangivel": 0,
    "passivo_circulante": 0, "fornecedores": 0, "programas_desenvolvimento": 0, "obrig_trabalhistas": 0,
    "provisao_ferias": 0, "receitas_diferidas_cp": 0, "receitas_diferidas_lp": 0, "fornecedores_lp": 0,
    "prov_contingencias": 0, "patrimonio_social": 0, "resultado_acumulado": 0, "patrimonio_liquido": 0 },
  "dfc": { "fluxo_operacional": 0, "fluxo_investimento": 0, "variacao_total": 0, "saldo_inicial": 0, "saldo_final": 0 },
  "competicoes": [{ "nome": "Brasileiro Série A", "valor_2025": 0, "valor_2024": 0 }]
}
\`\`\`
Use os valores exatos. Para "competicoes", liste todas da Nota 13.`
}
