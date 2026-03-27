import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const raw = readFileSync('.env.local', 'utf8')
const env = {}
for (const line of raw.split('\n')) {
  const idx = line.indexOf('=')
  if (idx < 0 || line.startsWith('#')) continue
  env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const { data, error } = await sb.from('dev_dados_financeiros')
  .select('periodo, dados_raw, superavit_bruto, despesas_operacionais, resultado_financeiro, outras_receitas_op, outras_despesas_op, resultado_exercicio, resultado_antes_ir, ir_csll, receita_bruta, receita_liquida, custos_futebol, rec_patrocinio, rec_transmissao, rec_bilheteria, rec_registros, rec_desenvolvimento, rec_academy, rec_financeiras, custo_selecao_principal, custo_selecao_base, custo_selecao_femininas, custo_fomento, desp_pessoal, desp_administrativas, desp_impostos_taxas, res_fin_receitas, res_fin_despesas, res_fin_cambial')
  .order('periodo')

if (error) { console.error(error.message); process.exit(1) }

let updated = 0
for (const r of data) {
  const dr = r.dados_raw?.dre || {}
  const n = v => v != null ? +v : 0
  const patch = {}

  // ── Recover DRE sub-fields from dados_raw.dre when top-level columns are null ──
  const rawMap = {
    receita_bruta:         dr.receita_bruta,
    receita_liquida:       dr.receita_liquida,
    custos_futebol:        dr.custos_futebol,
    superavit_bruto:       dr.superavit_bruto,
    despesas_operacionais: dr.despesas_operacionais,
    resultado_financeiro:  dr.resultado_financeiro,
    resultado_exercicio:   dr.resultado_exercicio,
    outras_receitas_op:    dr.outras_receitas,
    outras_despesas_op:    dr.outras_despesas,
    resultado_antes_ir:    dr.resultado_antes_ir,
    ir_csll:               dr.ir_csll,
    rec_patrocinio:        r.dados_raw?.receitas?.patrocinio,
    rec_transmissao:       r.dados_raw?.receitas?.transmissao,
    rec_bilheteria:        r.dados_raw?.receitas?.bilheteria,
    rec_registros:         r.dados_raw?.receitas?.registros,
    rec_desenvolvimento:   r.dados_raw?.receitas?.desenvolvimento,
    rec_academy:           r.dados_raw?.receitas?.academy,
    custo_selecao_principal:  r.dados_raw?.custos_futebol?.selecao_principal,
    custo_selecao_base:       r.dados_raw?.custos_futebol?.selecoes_base,
    custo_selecao_femininas:  r.dados_raw?.custos_futebol?.selecoes_femininas,
    custo_fomento:            r.dados_raw?.custos_futebol?.fomento,
    desp_pessoal:             r.dados_raw?.despesas?.pessoal,
    desp_administrativas:     r.dados_raw?.despesas?.administrativas,
    desp_impostos_taxas:      r.dados_raw?.despesas?.impostos_taxas,
    res_fin_receitas:         r.dados_raw?.resultado_financeiro?.receitas_financeiras,
    res_fin_despesas:         r.dados_raw?.resultado_financeiro?.despesas_financeiras,
    res_fin_cambial:          r.dados_raw?.resultado_financeiro?.variacao_cambial,
    rec_financeiras:          r.dados_raw?.resultado_financeiro?.receitas_financeiras,
  }
  for (const [col, rawVal] of Object.entries(rawMap)) {
    if (r[col] == null && rawVal != null) patch[col] = +rawVal
  }

  // ── Compute resultado_antes_ir / ir_csll from sub-fields if still missing ──
  const sbr = patch.superavit_bruto   ?? r.superavit_bruto
  const dop = patch.despesas_operacionais ?? r.despesas_operacionais
  const rf  = patch.resultado_financeiro  ?? r.resultado_financeiro
  const orec = patch.outras_receitas_op  ?? r.outras_receitas_op
  const odesp = patch.outras_despesas_op ?? r.outras_despesas_op
  const rex = patch.resultado_exercicio  ?? r.resultado_exercicio

  const hasSubFields = sbr != null || dop != null || rf != null
  if (hasSubFields && (patch.resultado_antes_ir == null && r.resultado_antes_ir == null)) {
    const rai = n(sbr) + n(dop) + n(rf) + n(orec) + n(odesp)
    patch.resultado_antes_ir = parseFloat(rai.toFixed(3))
    if (rex != null && patch.ir_csll == null && r.ir_csll == null) {
      patch.ir_csll = parseFloat((+rex - rai).toFixed(3))
    }
  }

  // ── Reset incorrectly zeroed fields ──
  if (!hasSubFields) {
    if (r.resultado_antes_ir === 0) patch.resultado_antes_ir = null
    if (r.ir_csll === 0) patch.ir_csll = null
  }

  if (!Object.keys(patch).length) continue

  const { error: uErr } = await sb.from('dev_dados_financeiros').update(patch).eq('periodo', r.periodo)
  if (uErr) { console.error(r.periodo, uErr.message); continue }
  const keys = Object.keys(patch).join(', ')
  console.log(r.periodo, `[${keys}]`)
  updated++
}

console.log(`\nDone — ${updated} records updated`)
