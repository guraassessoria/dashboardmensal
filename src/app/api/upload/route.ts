import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tbl } from '@/lib/supabase'
import * as XLSX from 'xlsx'
import { createHash } from 'crypto'

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

    // ── Balancete avulso (tipo_documento === 'balancete') ────────────────────────
    if (tipoDocumento === 'balancete') {
      if (!hasBalancete) {
        await supabase.from(tbl('uploads')).update({ status: 'error', error_msg: 'Nenhuma aba de Balancete encontrada' }).eq('id', uploadId)
        return NextResponse.json({ error: 'Nenhuma aba de Balancete encontrada no arquivo' }, { status: 400 })
      }
      const bText = balanceteToText(workbook, balanceteSheetName!, periodo)
      if (bText.length < 100) {
        await supabase.from(tbl('uploads')).update({ status: 'error', error_msg: `Balancete vazio para período ${periodo}` }).eq('id', uploadId)
        return NextResponse.json({ error: `Balancete vazio ou sem dados para período ${periodo}` }, { status: 400 })
      }
      const bHash = hashText(bText)

      // Verificar se o balancete já existe e é idêntico
      const { data: existingBalRow } = await supabase.from(tbl('dados_financeiros')).select('*').eq('periodo', periodo).single()
      if (existingBalRow?.dados_raw?._balancete_hash === bHash) {
        await supabase.from(tbl('uploads')).update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', uploadId)
        return NextResponse.json({ ok: true, upload_id: uploadId, periodo, status: 'done', msg: 'Balancete idêntico ao armazenado — nenhuma alteração necessária' })
      }

      // Chamar Claude apenas para o balancete
      const bCtrl = new AbortController()
      const bTimer = setTimeout(() => bCtrl.abort(), 50_000)
      const bResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        signal: bCtrl.signal,
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          messages: [{ role: 'user', content: [{ type: 'text', text: `## BALANCETE: ${file.name}\n\n${bText}\n\n---\n\n${buildBalancetePrompt(periodo, file.name)}` }] }]
        })
      })
      clearTimeout(bTimer)
      if (!bResp.ok) throw new Error(`Claude API ${bResp.status}: ${(await bResp.text()).slice(0, 200)}`)
      const bData = await bResp.json()
      const bRaw = bData.content?.[0]?.text || ''
      const bMatch = bRaw.match(/```json\n?([\s\S]*?)\n?```/) || bRaw.match(/\{[\s\S]*\}/)
      if (!bMatch) throw new Error('Claude não retornou JSON válido para balancete')
      const bExtracted = JSON.parse(bMatch[1] || bMatch[0])
      const bFields = bExtracted.balanco || {}

      // Merge: preservar dados existentes, atualizar apenas campos de balanço
      const bExistingRaw = existingBalRow?.dados_raw || {}
      const bMergedRaw = deepMerge(bExistingRaw, { balanco: bFields }, 'incoming')
      bMergedRaw._balancete_hash = bHash
      bMergedRaw._balancete_extracted = bFields
      bMergedRaw._sources = { ...(bExistingRaw._sources || {}), balancete: { filename: file.name, processed_at: new Date().toISOString() } }

      const bPick = (inc: any, ex: any) => (inc !== null && inc !== undefined) ? inc : ex
      const bPatch: any = { periodo, upload_id: uploadId, dados_raw: bMergedRaw, updated_at: new Date().toISOString() }
      const balFieldMap: Record<string, string> = {
        ativo_total: 'ativo_total', ativo_circulante: 'ativo_circulante', caixa_equivalentes: 'caixa_equivalentes',
        contas_receber: 'contas_receber', tributos_recuperar: 'tributos_recuperar', adiantamentos: 'adiantamentos',
        despesas_antecipadas: 'despesas_antecipadas', contas_receber_lp: 'contas_receber_lp',
        depositos_judiciais: 'depositos_judiciais', investimentos: 'investimentos', imobilizado: 'imobilizado',
        intangivel: 'intangivel', passivo_circulante: 'passivo_circulante', fornecedores: 'fornecedores',
        programas_desenvolvimento: 'programas_desenvolvimento', obrig_trabalhistas: 'obrig_trabalhistas',
        provisao_ferias: 'provisao_ferias', receitas_diferidas_cp: 'receitas_diferidas_cp',
        receitas_diferidas_lp: 'receitas_diferidas_lp', fornecedores_lp: 'fornecedores_lp',
        prov_contingencias: 'prov_contingencias', patrimonio_social: 'patrimonio_social',
        resultado_acumulado: 'resultado_acumulado', patrimonio_liquido: 'patrimonio_liquido'
      }
      for (const [src, dst] of Object.entries(balFieldMap)) {
        bPatch[dst] = bPick(bFields[src], existingBalRow?.[dst as keyof typeof existingBalRow])
      }
      const { error: bUpsertErr } = await supabase.from(tbl('dados_financeiros')).upsert(bPatch, { onConflict: 'periodo' })
      if (bUpsertErr) throw new Error(`Erro ao salvar balancete: ${bUpsertErr.message}`)
      await supabase.from(tbl('uploads')).update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', uploadId)
      console.log(`[upload] ✅ Balancete avulso processado — ${periodo}`)
      return NextResponse.json({ ok: true, upload_id: uploadId, periodo, status: 'done' })
    }
    // ── Fim balancete avulso ─────────────────────────────────────────────────

    const sheetText = xlsxToText(workbook, ABAS_ALVO)
    let balanceteText = ''
    if (hasBalancete) {
      balanceteText = balanceteToText(workbook, balanceteSheetName!, periodo)
    }
    const balanceteEfetivo = balanceteText.length > 200

    // ── Diff de balancete: detectar se mudou desde o último upload ────────────
    const balanceteHash = balanceteEfetivo ? hashText(balanceteText) : null
    const { data: existingRow } = await supabase
      .from(tbl('dados_financeiros'))
      .select('*')
      .eq('periodo', periodo)
      .single()
    const storedBalHash = existingRow?.dados_raw?._balancete_hash ?? null
    const balanceteUnchanged = balanceteHash !== null && storedBalHash !== null && balanceteHash === storedBalHash

    let textoCompleto: string
    let prompt: string
    if (balanceteUnchanged) {
      console.log(`[upload] Balancete sem alterações (hash ${balanceteHash}) — processando apenas DFs`)
      textoCompleto = sheetText
      prompt = buildPrompt(periodo, file.name)
    } else {
      textoCompleto = balanceteEfetivo ? sheetText + '\n\n' + balanceteText : sheetText
      prompt = balanceteEfetivo
        ? buildHybridPrompt(periodo, file.name, balanceteSheetName!)
        : buildPrompt(periodo, file.name)
    }
    console.log(`[upload] Texto ao Claude: ${textoCompleto.length} chars | balancete: ${balanceteEfetivo} | unchanged: ${balanceteUnchanged}`)

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
    const existingRaw = existingRow?.dados_raw || {}
    const mergedRaw = deepMerge(existingRaw, dadosExtraidos, 'incoming')
    mergedRaw._balancete_hash = balanceteHash ?? (existingRaw._balancete_hash ?? null)
    if (!balanceteUnchanged && balanceteEfetivo && dadosExtraidos.balanco) {
      mergedRaw._balancete_extracted = dadosExtraidos.balanco
    }
    mergedRaw._sources = {
      ...(existingRaw._sources || {}),
      dfs: { filename: file.name, processed_at: new Date().toISOString() },
      ...(!balanceteUnchanged && hasBalancete ? { balancete: { filename: file.name, processed_at: new Date().toISOString(), embedded: true } } : {})
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

    // Extrair e salvar DRE do período comparativo (ex: DFS 2025-02 contém DRE de 2024-02)
    await saveDREComparativePeriods(workbook, periodo)

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

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function buildBalancetePrompt(periodo: string, filename: string): string {
  const [ano, mes] = periodo.split('-')
  const dataRef = `${mes}/${ano}`
  return `Você é especialista em Balanço Patrimonial e demonstrações financeiras brasileiras.
Analise o Balancete acima (período ${dataRef}, apenas contas sintéticas marcadas com "S").
Extraia os saldos das contas principais. Os valores estão em R$ (reais).
Contas negativas representam passivos/deduções.
Retorne APENAS um JSON válido (sem explicações):
\`\`\`json
{
  "periodo": "${periodo}",
  "balanco": {
    "ativo_total": null, "ativo_circulante": null, "caixa_equivalentes": null,
    "contas_receber": null, "tributos_recuperar": null, "adiantamentos": null,
    "despesas_antecipadas": null, "contas_receber_lp": null, "depositos_judiciais": null,
    "investimentos": null, "imobilizado": null, "intangivel": null,
    "passivo_circulante": null, "fornecedores": null, "programas_desenvolvimento": null,
    "obrig_trabalhistas": null, "provisao_ferias": null, "receitas_diferidas_cp": null,
    "receitas_diferidas_lp": null, "fornecedores_lp": null, "prov_contingencias": null,
    "patrimonio_social": null, "resultado_acumulado": null, "patrimonio_liquido": null
  }
}
\`\`\`
Use null para contas não encontradas no Balancete.`
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

// ─── Extração direta da aba DRE (período comparativo) ───────────────────────

function periodoToSerial(periodo: string): number {
  const [ano, mes] = periodo.split('-').map(Number)
  const dtUltimoDia = new Date(ano, mes, 0)
  const excelEpoch  = new Date(1899, 11, 30)
  return Math.round((dtUltimoDia.getTime() - excelEpoch.getTime()) / 86_400_000)
}

function serialToPeriodo(serial: number): string | null {
  const excelEpoch = new Date(1899, 11, 30)
  const date = new Date(excelEpoch.getTime() + serial * 86_400_000)
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const lastDay = new Date(year, month, 0).getDate()
  if (date.getDate() !== lastDay) return null
  return `${year}-${String(month).padStart(2, '0')}`
}

const DRE_LABEL_MAP: Record<string, string> = {
  'DRE -  Patrocínio':                           'rec_patrocinio',
  'DRE - Direito de Transmissão':                'rec_transmissao',
  'DRE - Bilheteria e Premiações':               'rec_bilheteria',
  'DRE - Registros e Transferências':            'rec_registros',
  'DRE - Legado':                                'rec_legado',
  'DRE - Programa de desenvolvimento':           'rec_desenvolvimento',
  'DRE - CBF Academy':                           'rec_academy',
  'DRE - Deduções da Receita':                   '_deducoes',
  'DRE - Seleção Principal':                     'custo_selecao_principal',
  'DRE - Seleções de base e femininas':          'custo_selecao_base',
  'Seleções Femininas':                          'custo_selecao_femininas',
  'DRE - Contribuição ao Fomento do futebol':    'custo_fomento',
  'DRE - Pessoal':                               'desp_pessoal',
  'DRE - Administrativas':                       'desp_administrativas',
  'DRE - Impostos e taxas':                      'desp_impostos_taxas',
  'DRE - Receitas financeiras':                  'res_fin_receitas',
  'DRE - Despesas financeiras':                  'res_fin_despesas',
  'DRE - Variação Cambial':                      'res_fin_cambial',
  'DRE - Outras Receitas Operacionais':          '_outras_rec',
  'DRE - Outras Despesas Operacionais':          '_outras_desp',
  'DRE - Imposto de renda e contribuição social':'_ir_csll',
}

function extractDREFromSheet(workbook: XLSX.WorkBook, periodo: string): Record<string, number | null> | null {
  const sheetName = workbook.SheetNames.find(n => n.toUpperCase() === 'DRE')
  if (!sheetName) return null
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return null

  const serial = periodoToSerial(periodo)
  const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })

  let valCol = -1
  for (const r of data) {
    const i = (r as any[]).indexOf(serial)
    if (i >= 0) { valCol = i; break }
  }
  if (valCol < 0) return null

  const raw: Record<string, number> = {}
  for (const r of data) {
    const label = (String(r[0] || '').trim() || String(r[1] || '').trim())
    const field = DRE_LABEL_MAP[label]
    if (!field) continue
    const val = r[valCol]
    if (typeof val === 'number') raw[field] = val
  }

  const maxAbsVal = Math.max(...Object.values(raw).map(Math.abs))
  const scale = maxAbsVal > 1_000_000 ? 1000 : 1
  const g = (k: string): number | null => raw[k] != null ? parseFloat((raw[k] / scale).toFixed(3)) : null
  const s = (...args: (number | null)[]): number => parseFloat(args.reduce((acc: number, v) => acc + (v ?? 0), 0).toFixed(3))

  const rec_patrocinio    = g('rec_patrocinio')
  const rec_transmissao   = g('rec_transmissao')
  const rec_bilheteria    = g('rec_bilheteria')
  const rec_registros     = g('rec_registros')
  const rec_desenvolvimento = g('rec_desenvolvimento')
  const rec_academy       = g('rec_academy')
  const deducoes          = g('_deducoes')
  const custo_principal   = g('custo_selecao_principal')
  const custo_base        = g('custo_selecao_base')
  const custo_femininas   = g('custo_selecao_femininas')
  const custo_fomento     = g('custo_fomento')
  const desp_pessoal      = g('desp_pessoal')
  const desp_admin        = g('desp_administrativas')
  const desp_impostos     = g('desp_impostos_taxas')
  const res_fin_rec       = g('res_fin_receitas')
  const res_fin_desp      = g('res_fin_despesas')
  const res_fin_camb      = g('res_fin_cambial')
  const outras_rec        = g('_outras_rec')
  const outras_desp       = g('_outras_desp')
  const ir_csll           = g('_ir_csll')

  const receita_bruta         = s(rec_patrocinio, rec_transmissao, rec_bilheteria, rec_registros, rec_desenvolvimento, rec_academy)
  const receita_liquida       = s(receita_bruta, deducoes)
  const custos_futebol        = s(custo_principal, custo_base, custo_femininas, custo_fomento)
  const superavit_bruto       = s(receita_liquida, custos_futebol)
  const despesas_operacionais = s(desp_pessoal, desp_admin, desp_impostos)
  const resultado_financeiro  = s(res_fin_rec, res_fin_desp, res_fin_camb)
  const resultado_antes_ir    = s(superavit_bruto, despesas_operacionais, resultado_financeiro, outras_rec, outras_desp)
  const resultado_exercicio   = s(resultado_antes_ir, ir_csll)

  return {
    receita_bruta, receita_liquida, custos_futebol, superavit_bruto,
    despesas_operacionais, resultado_financeiro, resultado_exercicio,
    resultado_antes_ir, outras_receitas_op: outras_rec, outras_despesas_op: outras_desp, ir_csll,
    rec_patrocinio, rec_transmissao, rec_bilheteria, rec_registros,
    rec_desenvolvimento, rec_academy, rec_financeiras: res_fin_rec,
    custo_selecao_principal: custo_principal, custo_selecao_base: custo_base,
    custo_selecao_femininas: custo_femininas, custo_fomento,
    desp_pessoal, desp_administrativas: desp_admin, desp_impostos_taxas: desp_impostos,
    res_fin_receitas: res_fin_rec, res_fin_despesas: res_fin_desp, res_fin_cambial: res_fin_camb,
  }
}

const DRE_FIELDS_FOR_COMPARATIVE = [
  'receita_bruta','receita_liquida','custos_futebol','superavit_bruto',
  'despesas_operacionais','resultado_financeiro','resultado_exercicio',
  'resultado_antes_ir','outras_receitas_op','outras_despesas_op','ir_csll',
  'rec_patrocinio','rec_transmissao','rec_bilheteria','rec_registros',
  'rec_desenvolvimento','rec_academy','rec_financeiras',
  'custo_selecao_principal','custo_selecao_base','custo_selecao_femininas','custo_fomento',
  'desp_pessoal','desp_administrativas','desp_impostos_taxas',
  'res_fin_receitas','res_fin_despesas','res_fin_cambial',
]

async function saveDREComparativePeriods(workbook: XLSX.WorkBook, currentPeriodo: string) {
  const sheetName = workbook.SheetNames.find(n => n.toUpperCase() === 'DRE')
  if (!sheetName) return
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return
  const data: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })

  const comparativos: string[] = []
  for (const r of data.slice(0, 5)) {
    for (const cell of r) {
      if (typeof cell === 'number' && cell > 40000 && cell < 60000) {
        const p = serialToPeriodo(cell)
        if (p && p !== currentPeriodo && !comparativos.includes(p)) comparativos.push(p)
      }
    }
  }
  if (comparativos.length === 0) return

  for (const periodo of comparativos) {
    const dre = extractDREFromSheet(workbook, periodo)
    if (!dre) continue

    const { data: existing } = await supabase
      .from(tbl('dados_financeiros'))
      .select('periodo,' + DRE_FIELDS_FOR_COMPARATIVE.join(','))
      .eq('periodo', periodo)
      .maybeSingle()

    const patch: Record<string, any> = {}
    for (const f of DRE_FIELDS_FOR_COMPARATIVE) {
      if (dre[f] != null && (existing == null || (existing as any)[f] == null)) patch[f] = dre[f]
    }

    if (Object.keys(patch).length === 0) {
      console.log(`[upload] DRE comparativa ${periodo} — já preenchida`)
      continue
    }

    patch.updated_at = new Date().toISOString()
    if (existing) {
      const { error } = await supabase.from(tbl('dados_financeiros')).update(patch).eq('periodo', periodo)
      if (error) console.error(`[upload] DRE comparativa ${periodo}: ${error.message}`)
      else console.log(`[upload] ✅ DRE comparativa ${periodo} — resultado: ${dre.resultado_exercicio}`)
    } else {
      const { error } = await supabase.from(tbl('dados_financeiros')).insert({ periodo, ...patch })
      if (error) console.error(`[upload] DRE comparativa ${periodo} (novo): ${error.message}`)
      else console.log(`[upload] ✅ DRE comparativa ${periodo} (novo) — resultado: ${dre.resultado_exercicio}`)
    }
  }
}
